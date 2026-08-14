/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { CodeScrimLearnerWorkspaceService } from '../../browser/codeScrimLearnerWorkspaceService.js';
import { ICodeScrimRecordingDraft } from '../../common/codeScrimRecording.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';

suite('CodeScrimLearnerWorkspaceService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('materializes a checkpoint outside the instructor workspace and removes it on disposal', async () => {
		const { fileService, service } = createService();
		const draft = createDraft();
		await service.reset(draft, draft.checkpoints[0]);

		const workspaceRoot = service.workspaceRoot;
		const lesson = service.toLearnerUri({ root: 0, path: 'src/lesson.ts' });
		const binary = service.toLearnerUri({ root: 0, path: 'asset.bin' });
		assert.ok(workspaceRoot);
		assert.strictEqual(service.primaryRoot?.toString(), workspaceRoot.toString());
		assert.strictEqual((await fileService.readFile(lesson!)).value.toString(), 'const learner = 2;');
		assert.deepStrictEqual((await fileService.readFile(binary!)).value.buffer, VSBuffer.fromByteArray([0, 1, 2]).buffer);

		await service.disposeWorkspace();
		assert.strictEqual(await fileService.exists(workspaceRoot), false);
		assert.strictEqual(service.workspaceRoot, undefined);
	});

	test('applies file lifecycle events only inside the owned projection', async () => {
		const { fileService, service } = createService();
		const draft = createDraft();
		await service.reset(draft, draft.checkpoints[0]);
		const oldResource = { root: 0, path: 'src/lesson.ts' };
		const newResource = { root: 0, path: 'src/next.ts' };

		await service.applyWorkspaceChanges([oldResource], [{
			resource: newResource,
			type: 'file',
			size: 21,
			contents: encodeBase64(VSBuffer.fromString('export const next = 3;')),
			text: true,
		}]);

		assert.strictEqual(await fileService.exists(service.toLearnerUri(oldResource)!), false);
		assert.strictEqual((await fileService.readFile(service.toLearnerUri(newResource)!)).value.toString(), 'export const next = 3;');
		await service.disposeWorkspace();
	});

	test('accepts learner-created folders and files when the recording starts empty', async () => {
		const { fileService, service } = createService();
		const draft: ICodeScrimRecordingDraft = {
			id: 'empty-learner-workspace-test',
			duration: 1_000,
			checkpoints: [{ timestamp: 0, eventIndex: 0, documents: [], entries: [], skippedEntryCount: 0, terminals: [] }],
			events: [],
		};
		await service.reset(draft, draft.checkpoints[0]);
		const folder = { resource: { root: 0, path: 'src' }, type: 'directory' as const, text: false };
		const file = { resource: { root: 0, path: 'src/learner.ts' }, type: 'file' as const, size: 0, contents: '', text: true };

		await service.applyWorkspaceChanges([], [folder, file]);
		await service.writeText(file.resource, 'export const learner = true;');

		const fileUri = service.toLearnerUri(file.resource)!;
		const scanned = await service.scanEntries();
		assert.strictEqual((await fileService.readFile(fileUri)).value.toString(), 'export const learner = true;');
		assert.deepStrictEqual(service.toWorkspaceResource(fileUri), file.resource);
		assert.deepStrictEqual(scanned.map(entry => ({ path: entry.resource.path, type: entry.type, text: entry.text })), [
			{ path: 'src', type: 'directory', text: false },
			{ path: 'src/learner.ts', type: 'file', text: true },
		]);
		assert.strictEqual(service.primaryRoot?.toString(), service.workspaceRoot?.toString());
		await service.disposeWorkspace();
	});

	test('synthesizes a tsconfig.json project boundary when no configuration is recorded', async () => {
		const { fileService, service } = createService();
		const draft = createDraft();
		await service.reset(draft, draft.checkpoints[0]);

		const tsconfigUri = service.toLearnerUri({ root: 0, path: 'tsconfig.json' })!;
		assert.strictEqual(await fileService.exists(tsconfigUri), true);
		const parsed = JSON.parse((await fileService.readFile(tsconfigUri)).value.toString());
		assert.strictEqual(parsed.compilerOptions.moduleDetection, 'force');

		const scanned = await service.scanEntries();
		assert.strictEqual(scanned.some(entry => entry.resource.path === 'tsconfig.json'), false);
		await service.disposeWorkspace();
	});

	test('removes a stale projection before preparing a recovered session', async () => {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		const storageService = disposables.add(new TestStorageService());
		const environmentService = { workspaceStorageHome: URI.from({ scheme: Schemas.inMemory, path: '/workspace-storage' }) } as IEnvironmentService;
		const draft = createDraft();
		const interrupted = new CodeScrimLearnerWorkspaceService(environmentService, fileService, storageService);
		await interrupted.reset(draft, draft.checkpoints[0]);
		const staleRoot = interrupted.workspaceRoot!;

		const recovered = new CodeScrimLearnerWorkspaceService(environmentService, fileService, storageService);
		await recovered.reset(draft, draft.checkpoints[0]);

		assert.strictEqual(await fileService.exists(staleRoot), false);
		assert.notStrictEqual(recovered.workspaceRoot?.toString(), staleRoot.toString());
		await recovered.disposeWorkspace();
	});

	function createService(): { fileService: FileService; service: CodeScrimLearnerWorkspaceService } {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		const storageService = disposables.add(new TestStorageService());
		const environmentService = { workspaceStorageHome: URI.from({ scheme: Schemas.inMemory, path: '/workspace-storage' }) } as IEnvironmentService;
		return { fileService, service: new CodeScrimLearnerWorkspaceService(environmentService, fileService, storageService) };
	}
});

function createDraft(): ICodeScrimRecordingDraft {
	return {
		id: 'learner-workspace-test',
		duration: 1_000,
		checkpoints: [{
			timestamp: 0,
			eventIndex: 0,
			documents: [{ resource: { root: 0, path: 'src/lesson.ts' }, languageId: 'typescript', versionId: 2, eol: '\n', text: 'const learner = 2;' }],
			entries: [
				{ resource: { root: 0, path: 'src' }, type: 'directory', text: false },
				{ resource: { root: 0, path: 'src/lesson.ts' }, type: 'file', size: 18, contents: encodeBase64(VSBuffer.fromString('const learner = 1;')), text: true },
				{ resource: { root: 0, path: 'asset.bin' }, type: 'file', size: 3, contents: encodeBase64(VSBuffer.fromByteArray([0, 1, 2])), text: false },
			],
			skippedEntryCount: 0,
			terminals: [],
		}],
		events: [],
	};
}
