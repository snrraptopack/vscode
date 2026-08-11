/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CodeScrimRecordingBuffer } from '../../common/codeScrimRecording.js';

suite('CodeScrimRecordingBuffer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('assigns monotonic microsecond timestamps and sequence numbers', () => {
		const buffer = new CodeScrimRecordingBuffer();
		buffer.start('draft-one', 100);

		const first = buffer.append({
			domain: 'editor',
			kind: 'editor.activeResourceChanged',
			payload: { resource: { root: 0, path: 'src/index.ts' } },
		}, 100.5);
		const second = buffer.append({
			domain: 'editor',
			kind: 'editor.documentSaved',
			payload: { resource: { root: 0, path: 'src/index.ts' } },
		}, 99);

		assert.strictEqual(first.id, 'draft-one:0');
		assert.strictEqual(first.timestamp, 500);
		assert.strictEqual(first.sequence, 0);
		assert.strictEqual(second.id, 'draft-one:1');
		assert.strictEqual(second.timestamp, 0);
		assert.strictEqual(second.sequence, 1);
	});

	test('stops with an immutable draft and resets the buffer', () => {
		const buffer = new CodeScrimRecordingBuffer();
		buffer.start('draft-two', 1_000);
		buffer.captureDocument({
			resource: { root: 0, path: 'src/index.ts' },
			languageId: 'typescript',
			versionId: 7,
			eol: '\n',
			text: 'const value = 1;\n',
		});
		buffer.captureDocument({
			resource: { root: 0, path: 'src/index.ts' },
			languageId: 'typescript',
			versionId: 8,
			eol: '\n',
			text: 'const value = 2;\n',
		});
		buffer.captureWorkspaceEntry({
			resource: { root: 0, path: 'src/index.ts' },
			type: 'file',
			size: 17,
			contents: 'Y29uc3QgdmFsdWUgPSAxOwo=',
			text: true,
		});
		buffer.captureWorkspaceEntry({
			resource: { root: 0, path: 'src/index.ts' },
			type: 'file',
			size: 17,
			contents: 'cmVwbGFjZW1lbnQ=',
			text: true,
		});
		buffer.recordSkippedWorkspaceEntry();
		buffer.append({
			domain: 'editor',
			kind: 'editor.activeResourceChanged',
			payload: {},
		}, 1_010);

		const draft = buffer.stop(1_025);
		assert.deepStrictEqual(draft, {
			id: 'draft-two',
			duration: 25_000,
			checkpoint: {
				documents: [{
					resource: { root: 0, path: 'src/index.ts' },
					languageId: 'typescript',
					versionId: 7,
					eol: '\n',
					text: 'const value = 1;\n',
				}],
				entries: [{
					resource: { root: 0, path: 'src/index.ts' },
					type: 'file',
					size: 17,
					contents: 'Y29uc3QgdmFsdWUgPSAxOwo=',
					text: true,
				}],
				skippedEntryCount: 1,
			},
			events: [{
				id: 'draft-two:0',
				version: 1,
				timestamp: 10_000,
				sequence: 0,
				domain: 'editor',
				kind: 'editor.activeResourceChanged',
				payload: {},
			}],
		});
		assert.strictEqual(buffer.isRecording, false);
		assert.strictEqual(buffer.eventCount, 0);
		assert.strictEqual(Object.isFrozen(draft?.events), true);
		assert.strictEqual(Object.isFrozen(draft?.checkpoint.documents), true);
		assert.strictEqual(Object.isFrozen(draft?.checkpoint.entries), true);
		assert.strictEqual(Object.isFrozen(draft?.checkpoint.entries[0]), true);
	});

	test('rejects appends outside an active recording', () => {
		const buffer = new CodeScrimRecordingBuffer();
		assert.throws(() => buffer.append({
			domain: 'editor',
			kind: 'editor.activeResourceChanged',
			payload: {},
		}, 0), /not active/);
	});

	test('freezes portable workspace lifecycle payloads', () => {
		const buffer = new CodeScrimRecordingBuffer();
		buffer.start('draft-workspace', 0);
		const event = buffer.append({
			domain: 'workspace',
			kind: 'workspace.entriesChanged',
			payload: {
				deleted: [{ root: 0, path: 'old.ts' }],
				created: [{
					resource: { root: 0, path: 'new.ts' },
					type: 'file',
					size: 0,
					contents: '',
					text: true,
				}],
			},
		}, 1);

		assert.strictEqual(event.kind, 'workspace.entriesChanged');
		assert.strictEqual(Object.isFrozen(event.payload), true);
		assert.strictEqual(Object.isFrozen(event.payload.deleted), true);
		assert.strictEqual(Object.isFrozen(event.payload.created), true);
		assert.strictEqual(Object.isFrozen(event.payload.created[0]), true);
	});

	test('does not replace an active recording', () => {
		const buffer = new CodeScrimRecordingBuffer();
		buffer.start('draft-three', 0);
		assert.throws(() => buffer.start('draft-four', 1), /already active/);
	});
});
