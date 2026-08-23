/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { CodeScrimPackageCodec, ICodeScrimPackageKey, ICodeScrimPackageService } from '../common/codeScrimPackage.js';
import { ICodeScrimRecordingDraft } from '../common/codeScrimRecording.js';

const CODE_SCRIM_AUTHORING_KEY = 'codescrim.authoringPackageKey.v1';
const CODE_SCRIM_STORAGE_DIRECTORY = 'codescrim';
const CODE_SCRIM_DRAFT_DIRECTORY = 'drafts';
const CODE_SCRIM_LAST_DRAFT = 'last.scrim';
const CODE_SCRIM_PACKAGE_MAX_BYTES = 256 * 1024 * 1024;

interface IStoredCodeScrimPackageKey {
	readonly id: string;
	readonly jwk: JsonWebKey;
}

/**
 * Owns local package persistence and the installation-scoped authoring key. The key is stored by
 * VS Code's secret service, never beside the `.scrim` bytes or inside the instructor workspace.
 */
export class CodeScrimPackageService implements ICodeScrimPackageService {

	declare readonly _serviceBrand: undefined;

	private readonly codec = new CodeScrimPackageCodec();
	private keyPromise: Promise<ICodeScrimPackageKey> | undefined;
	private readonly draftResource: URI;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IUserDataProfilesService userDataProfilesService: IUserDataProfilesService,
	) {
		this.draftResource = joinPath(
			userDataProfilesService.defaultProfile.globalStorageHome,
			CODE_SCRIM_STORAGE_DIRECTORY,
			CODE_SCRIM_DRAFT_DIRECTORY,
			CODE_SCRIM_LAST_DRAFT,
		);
	}

	async saveDraft(draft: ICodeScrimRecordingDraft): Promise<void> {
		await this.savePackage(this.draftResource, draft);
	}

	async loadDraft(): Promise<ICodeScrimRecordingDraft | undefined> {
		if (!await this.fileService.exists(this.draftResource)) {
			return undefined;
		}
		try {
			return await this.openPackage(this.draftResource);
		} catch (error) {
			// A bad recovery draft must not stop CodeScrim from starting or prevent a new recording.
			this.logService.error('CodeScrim: failed to restore the last recording draft', error);
			return undefined;
		}
	}

	async deleteDraft(): Promise<void> {
		if (await this.fileService.exists(this.draftResource)) {
			await this.fileService.del(this.draftResource);
		}
	}

	async savePackage(resource: URI, draft: ICodeScrimRecordingDraft): Promise<void> {
		const packageBytes = await this.codec.encode(draft, await this.getOrCreateKey());
		await this.writeAtomically(resource, packageBytes);
	}

	async openPackage(resource: URI): Promise<ICodeScrimRecordingDraft> {
		const contents = await this.fileService.readFile(resource, { atomic: true, limits: { size: CODE_SCRIM_PACKAGE_MAX_BYTES } });
		return this.codec.decode(contents.value, await this.getOrCreateKey());
	}

	private getOrCreateKey(): Promise<ICodeScrimPackageKey> {
		return this.keyPromise ??= this.doGetOrCreateKey();
	}

	private async doGetOrCreateKey(): Promise<ICodeScrimPackageKey> {
		const stored = await this.secretStorageService.get(CODE_SCRIM_AUTHORING_KEY);
		if (stored) {
			try {
				const candidate = JSON.parse(stored) as Partial<IStoredCodeScrimPackageKey>;
				if (typeof candidate.id === 'string' && candidate.id && candidate.jwk) {
					const value = await crypto.subtle.importKey('jwk', candidate.jwk, 'AES-GCM', false, ['encrypt', 'decrypt']);
					return { id: candidate.id, value };
				}
			} catch (error) {
				this.logService.warn('CodeScrim: replacing an invalid authoring package key', error);
			}
		}

		const value = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
		const key: ICodeScrimPackageKey = { id: generateUuid(), value };
		const serialized: IStoredCodeScrimPackageKey = { id: key.id, jwk: await crypto.subtle.exportKey('jwk', value) };
		await this.secretStorageService.set(CODE_SCRIM_AUTHORING_KEY, JSON.stringify(serialized));
		return key;
	}

	private async writeAtomically(resource: URI, contents: VSBuffer): Promise<void> {
		const parent = dirname(resource);
		const temporary = resource.with({ path: `${resource.path}.tmp-${generateUuid()}` });
		try {
			await this.fileService.createFolder(parent);
		} catch {
			// The file service reports an existing directory as an error on some providers.
		}

		try {
			await this.fileService.writeFile(temporary, contents);
			// Moving the complete sibling file is the commit point. A crash cannot leave a half-written package.
			await this.fileService.move(temporary, resource, true);
		} catch (error) {
			if (await this.fileService.exists(temporary)) {
				await this.fileService.del(temporary).catch(cleanupError => this.logService.warn('CodeScrim: failed to clean a temporary package', cleanupError));
			}
			throw error;
		}
	}
}
