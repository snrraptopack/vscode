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
		assert.strictEqual(second.timestamp, 500);
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
			checkpoints: [{
				timestamp: 0,
				eventIndex: 0,
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
			}, {
				timestamp: 25_000,
				eventIndex: 1,
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
			}],
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
		assert.strictEqual(Object.isFrozen(draft?.checkpoints), true);
		assert.strictEqual(Object.isFrozen(draft?.checkpoints[0].documents), true);
		assert.strictEqual(Object.isFrozen(draft?.checkpoints[0].entries), true);
		assert.strictEqual(Object.isFrozen(draft?.checkpoints[0].entries[0]), true);
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

	test('checkpoints the latest unsaved text for a file created during recording', () => {
		const buffer = new CodeScrimRecordingBuffer();
		buffer.start('draft-created-file', 0);
		buffer.append({
			domain: 'workspace',
			kind: 'workspace.entriesChanged',
			payload: {
				deleted: [],
				created: [{
					resource: { root: 0, path: 'created.ts' },
					type: 'file',
					size: 0,
					contents: '',
					text: true,
				}],
			},
		}, 10);
		buffer.append({
			domain: 'editor',
			kind: 'editor.documentChanged',
			payload: {
				resource: { root: 0, path: 'created.ts' },
				languageId: 'typescript',
				versionId: 2,
				eol: '\n',
				text: 'const created = true;',
				changes: [{ rangeOffset: 0, rangeLength: 0, text: 'const created = true;' }],
				undoing: false,
				redoing: false,
			},
		}, 15);

		const draft = buffer.stop(30);
		assert.strictEqual(draft?.checkpoints.at(-1)?.documents[0]?.text, 'const created = true;');
		assert.strictEqual(draft?.checkpoints.at(-1)?.documents[0]?.languageId, 'typescript');
		assert.strictEqual(draft?.checkpoints.at(-1)?.eventIndex, 2);
	});

	test('creates automatic checkpoints from time and event-volume thresholds', () => {
		const timed = new CodeScrimRecordingBuffer();
		timed.start('draft-timed-checkpoint', 0);
		timed.append({ domain: 'editor', kind: 'editor.activeResourceChanged', payload: {} }, 30_000);
		assert.strictEqual(timed.stop(30_001)?.checkpoints[1]?.timestamp, 30_000_000);

		const volume = new CodeScrimRecordingBuffer();
		volume.start('draft-volume-checkpoint', 0);
		for (let index = 0; index < 1_000; index++) {
			volume.append({ domain: 'editor', kind: 'editor.activeResourceChanged', payload: {} }, index);
		}
		const draft = volume.stop(1_001);
		assert.strictEqual(draft?.checkpoints[1]?.eventIndex, 1_000);
	});

	test('does not replace an active recording', () => {
		const buffer = new CodeScrimRecordingBuffer();
		buffer.start('draft-three', 0);
		assert.throws(() => buffer.start('draft-four', 1), /already active/);
	});

	test('excludes paused time while preserving event sequence', () => {
		const buffer = new CodeScrimRecordingBuffer();
		buffer.start('draft-paused', 100);
		buffer.append({ domain: 'editor', kind: 'editor.activeResourceChanged', payload: {} }, 110);

		assert.strictEqual(buffer.pause(115), true);
		assert.strictEqual(buffer.pause(120), false);
		assert.strictEqual(buffer.resume(145), true);
		const resumed = buffer.append({ domain: 'editor', kind: 'editor.activeResourceChanged', payload: {} }, 150);
		const draft = buffer.stop(160);

		assert.strictEqual(resumed.timestamp, 20_000);
		assert.strictEqual(resumed.sequence, 1);
		assert.strictEqual(draft?.duration, 30_000);
	});
});
