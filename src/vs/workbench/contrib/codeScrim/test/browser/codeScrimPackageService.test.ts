/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { toUserDataProfile } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import { CodeScrimPackageService } from '../../browser/codeScrimPackageService.js';
import { ICodeScrimRecordingDraft } from '../../common/codeScrimRecording.js';

suite('CodeScrimPackageService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('persists an atomic recovery draft across service instances', async () => {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		const secrets = disposables.add(new TestSecretStorageService());
		const profile = toUserDataProfile('test', 'Test', URI.from({ scheme: Schemas.inMemory, path: '/profile' }), URI.from({ scheme: Schemas.inMemory, path: '/cache' }));
		const profiles = { defaultProfile: profile };
		const first = new CodeScrimPackageService(fileService, new NullLogService(), secrets, profiles);
		await first.saveDraft(createDraft());

		const second = new CodeScrimPackageService(fileService, new NullLogService(), secrets, profiles);
		const recovered = await second.loadDraft();
		const recoveryResource = joinPath(profile.globalStorageHome, 'codescrim', 'drafts', 'last.scrim');
		const storage = await fileService.resolve(joinPath(profile.globalStorageHome, 'codescrim', 'drafts'));

		assert.deepStrictEqual({
			recovered,
			recoveryExists: await fileService.exists(recoveryResource),
			files: storage.children?.map(child => child.name),
		}, {
			recovered: createDraft(),
			recoveryExists: true,
			files: ['last.scrim'],
		});
	});

	test('deletes the recovery draft without affecting exported packages', async () => {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		const profile = toUserDataProfile('delete-test', 'Delete Test', URI.from({ scheme: Schemas.inMemory, path: '/delete-profile' }), URI.from({ scheme: Schemas.inMemory, path: '/delete-cache' }));
		const service = new CodeScrimPackageService(fileService, new NullLogService(), disposables.add(new TestSecretStorageService()), { defaultProfile: profile });
		const exported = URI.from({ scheme: Schemas.inMemory, path: '/course/lesson.scrim' });
		await service.saveDraft(createDraft());
		await service.savePackage(exported, createDraft());

		await service.deleteDraft();

		assert.strictEqual(await service.loadDraft(), undefined);
		assert.strictEqual(await fileService.exists(exported), true);
	});
});

function createDraft(): ICodeScrimRecordingDraft {
	return {
		id: 'package-service-test',
		duration: 1_000,
		checkpoints: [{
			timestamp: 0,
			eventIndex: 0,
			documents: [{ resource: { root: 0, path: 'lesson.ts' }, languageId: 'typescript', versionId: 1, eol: '\n', text: 'let value = 1;' }],
			entries: [{ resource: { root: 0, path: 'lesson.ts' }, type: 'file', size: 14, contents: 'bGV0IHZhbHVlID0gMTs=', text: true }],
			skippedEntryCount: 0,
			terminals: [],
		}],
		events: [],
	};
}
