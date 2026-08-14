/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../base/common/async.js';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { dirname, extUri, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { collectCodeScrimWorkspaceRoots, ICodeScrimLearnerWorkspaceService } from '../common/codeScrimLearnerWorkspace.js';
import { CodeScrimRecordingBuffer, ICodeScrimRecordingCheckpoint, ICodeScrimRecordingDraft, ICodeScrimWorkspaceEntryCheckpoint, ICodeScrimWorkspaceResource } from '../common/codeScrimRecording.js';

const ACTIVE_WORKSPACE_STORAGE_KEY = 'codeScrim.learnerWorkspace.activeRoot';

/**
 * Projects an immutable recording checkpoint into CodeScrim-owned storage. The projection is a
 * file-backed language/tooling boundary, not an execution sandbox.
 */
export class CodeScrimLearnerWorkspaceService implements ICodeScrimLearnerWorkspaceService {

	declare readonly _serviceBrand: undefined;

	private readonly operations = new Sequencer();
	private readonly baseRoot: URI;
	private roots: readonly number[] = [];
	private _workspaceRoot: URI | undefined;

	private readonly synthesizedFiles = new Set<string>();

	get workspaceRoot(): URI | undefined {
		return this._workspaceRoot;
	}

	get primaryRoot(): URI | undefined {
		if (!this._workspaceRoot || !this.roots.length) {
			return undefined;
		}
		return this.roots.length === 1 ? this._workspaceRoot : this.learnerRoot(this.roots[0]);
	}

	constructor(
		@IEnvironmentService environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		this.baseRoot = joinPath(environmentService.workspaceStorageHome, 'codescrim', 'learner-workspaces');
	}

	reset(draft: ICodeScrimRecordingDraft, checkpoint: ICodeScrimRecordingCheckpoint): Promise<void> {
		return this.operations.queue(async () => {
			await this.deleteOwnedWorkspace(this.readStoredWorkspace());
			this.synthesizedFiles.clear();
			this.roots = collectCodeScrimWorkspaceRoots(draft);
			const workspaceRoot = joinPath(this.baseRoot, generateUuid());
			this._workspaceRoot = workspaceRoot;
			this.storageService.store(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceRoot.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);

			try {
				await this.fileService.createFolder(workspaceRoot);
				await this.materializeCheckpoint(checkpoint);
			} catch (error) {
				await this.deleteOwnedWorkspace(workspaceRoot);
				throw error;
			}
		});
	}

	applyWorkspaceChanges(deleted: readonly ICodeScrimWorkspaceResource[], created: readonly ICodeScrimWorkspaceEntryCheckpoint[]): Promise<void> {
		return this.operations.queue(async () => {
			for (const resource of deleted) {
				this.synthesizedFiles.delete(CodeScrimRecordingBuffer.resourceKey(resource));
				const uri = this.toLearnerUri(resource);
				if (uri && await this.fileService.exists(uri)) {
					await this.fileService.del(uri, { recursive: true, useTrash: false });
				}
			}
			for (const entry of created) {
				this.synthesizedFiles.delete(CodeScrimRecordingBuffer.resourceKey(entry.resource));
				await this.materializeEntry(entry);
			}
		});
	}

	writeText(resource: ICodeScrimWorkspaceResource, text: string): Promise<void> {
		return this.operations.queue(async () => {
			this.synthesizedFiles.delete(CodeScrimRecordingBuffer.resourceKey(resource));
			const uri = this.toLearnerUri(resource);
			if (!uri) {
				return;
			}
			await this.fileService.createFolder(dirname(uri));
			await this.fileService.writeFile(uri, VSBuffer.fromString(text));
		});
	}

	toLearnerUri(resource: ICodeScrimWorkspaceResource): URI | undefined {
		if (!this._workspaceRoot || !this.roots.includes(resource.root) || !this.isSafeResource(resource)) {
			return undefined;
		}
		return joinPath(this.learnerRoot(resource.root), ...resource.path.split('/'));
	}

	toWorkspaceResource(resource: URI): ICodeScrimWorkspaceResource | undefined {
		for (const root of this.roots) {
			const path = extUri.relativePath(this.learnerRoot(root), resource);
			if (path === '') {
				return { root, path };
			}
			if (path && this.isSafeResource({ root, path })) {
				return { root, path };
			}
		}
		return undefined;
	}

	scanEntries(): Promise<readonly ICodeScrimWorkspaceEntryCheckpoint[]> {
		return this.operations.queue(async () => {
			const entries: ICodeScrimWorkspaceEntryCheckpoint[] = [];
			for (const root of this.roots) {
				const learnerRoot = this.learnerRoot(root);
				if (!await this.fileService.exists(learnerRoot)) {
					continue;
				}
				const stat = await this.fileService.resolve(learnerRoot);
				for (const child of stat.children ?? []) {
					await this.scanEntry(child, root, child.name, entries);
				}
			}
			return Object.freeze(entries.filter(entry => !this.synthesizedFiles.has(CodeScrimRecordingBuffer.resourceKey(entry.resource))));
		});
	}

	disposeWorkspace(): Promise<void> {
		return this.operations.queue(async () => {
			await this.deleteOwnedWorkspace(this._workspaceRoot ?? this.readStoredWorkspace());
			this._workspaceRoot = undefined;
			this.roots = [];
			this.synthesizedFiles.clear();
		});
	}

	private async materializeCheckpoint(checkpoint: ICodeScrimRecordingCheckpoint): Promise<void> {
		const documents = new Map(checkpoint.documents.map(document => [CodeScrimRecordingBuffer.resourceKey(document.resource), document]));
		const directories = checkpoint.entries
			.filter(entry => entry.type === 'directory')
			.sort((left, right) => left.resource.path.length - right.resource.path.length);
		for (const directory of directories) {
			await this.materializeEntry(directory);
		}
		for (const entry of checkpoint.entries) {
			if (entry.type === 'file' && !documents.has(CodeScrimRecordingBuffer.resourceKey(entry.resource))) {
				await this.materializeEntry(entry);
			}
		}
		for (const document of checkpoint.documents) {
			await this.writeTextNow(document.resource, document.text);
		}
		await this.ensureTypeScriptProjectBoundaries(checkpoint);
	}

	private async ensureTypeScriptProjectBoundaries(checkpoint: ICodeScrimRecordingCheckpoint): Promise<void> {
		for (const root of this.roots) {
			const hasConfig = checkpoint.entries.some(entry => entry.resource.root === root && (entry.resource.path === 'tsconfig.json' || entry.resource.path === 'jsconfig.json')) ||
				checkpoint.documents.some(document => document.resource.root === root && (document.resource.path === 'tsconfig.json' || document.resource.path === 'jsconfig.json'));
			if (hasConfig) {
				continue;
			}
			const hasScript = checkpoint.entries.some(entry => entry.resource.root === root && /\.[jt]sx?$/i.test(entry.resource.path)) ||
				checkpoint.documents.some(document => document.resource.root === root && /\.[jt]sx?$/i.test(document.resource.path));
			if (!hasScript) {
				continue;
			}
			const resource = Object.freeze({ root, path: 'tsconfig.json' });
			const defaultConfig = JSON.stringify({
				compilerOptions: {
					target: 'ES2022',
					module: 'ESNext',
					moduleResolution: 'bundler',
					moduleDetection: 'force',
					isolatedModules: true,
					allowJs: true,
					checkJs: false,
					strict: true,
					noEmit: true,
				},
			}, null, 2);
			this.synthesizedFiles.add(CodeScrimRecordingBuffer.resourceKey(resource));
			await this.writeTextNow(resource, defaultConfig);
		}
	}

	private async materializeEntry(entry: ICodeScrimWorkspaceEntryCheckpoint): Promise<void> {
		const uri = this.toLearnerUri(entry.resource);
		if (!uri) {
			return;
		}
		if (entry.type === 'directory') {
			await this.fileService.createFolder(uri);
			return;
		}
		if (entry.contents === undefined) {
			return;
		}
		await this.fileService.createFolder(dirname(uri));
		await this.fileService.writeFile(uri, decodeBase64(entry.contents));
	}

	private async writeTextNow(resource: ICodeScrimWorkspaceResource, text: string): Promise<void> {
		const uri = this.toLearnerUri(resource);
		if (!uri) {
			return;
		}
		await this.fileService.createFolder(dirname(uri));
		await this.fileService.writeFile(uri, VSBuffer.fromString(text));
	}

	private async scanEntry(stat: IFileStat, root: number, path: string, entries: ICodeScrimWorkspaceEntryCheckpoint[]): Promise<void> {
		const resource = Object.freeze({ root, path: path.replace(/\\/g, '/') });
		if (stat.isDirectory) {
			entries.push(Object.freeze({ resource, type: 'directory', text: false }));
			const resolved = stat.children ? stat : await this.fileService.resolve(stat.resource);
			for (const child of resolved.children ?? []) {
				await this.scanEntry(child, root, `${resource.path}/${child.name}`, entries);
			}
			return;
		}
		if (!stat.isFile) {
			return;
		}
		const contents = (await this.fileService.readFile(stat.resource, { atomic: true })).value;
		entries.push(Object.freeze({
			resource,
			type: 'file',
			size: contents.byteLength,
			contents: encodeBase64(contents),
			text: this.isProbablyText(contents),
		}));
	}

	private readStoredWorkspace(): URI | undefined {
		const stored = this.storageService.get(ACTIVE_WORKSPACE_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!stored) {
			return undefined;
		}
		try {
			return URI.parse(stored);
		} catch {
			this.storageService.remove(ACTIVE_WORKSPACE_STORAGE_KEY, StorageScope.WORKSPACE);
			return undefined;
		}
	}

	private async deleteOwnedWorkspace(candidate: URI | undefined): Promise<void> {
		if (candidate && !extUri.isEqual(candidate, this.baseRoot) && extUri.isEqualOrParent(candidate, this.baseRoot) && await this.fileService.exists(candidate)) {
			await this.fileService.del(candidate, { recursive: true, useTrash: false });
		}
		this.storageService.remove(ACTIVE_WORKSPACE_STORAGE_KEY, StorageScope.WORKSPACE);
		if (candidate && this._workspaceRoot && extUri.isEqual(candidate, this._workspaceRoot)) {
			this._workspaceRoot = undefined;
		}
	}

	private rootFolder(root: number): string {
		return `root-${root + 1}`;
	}

	private learnerRoot(root: number): URI {
		return this.roots.length === 1 ? this._workspaceRoot! : joinPath(this._workspaceRoot!, this.rootFolder(root));
	}

	private isProbablyText(buffer: VSBuffer): boolean {
		const length = Math.min(buffer.byteLength, 8192);
		for (let index = 0; index < length; index++) {
			if (buffer.buffer[index] === 0) {
				return false;
			}
		}
		return true;
	}

	private isSafeResource(resource: ICodeScrimWorkspaceResource): boolean {
		return Number.isSafeInteger(resource.root) && resource.root >= 0 && !!resource.path && !resource.path.startsWith('/') &&
			!resource.path.includes('\\') && resource.path.split('/').every(segment => !!segment && segment !== '.' && segment !== '..');
	}
}
