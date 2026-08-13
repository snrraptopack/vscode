/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CodeScrimEditorEvent } from '../../common/codeScrimRecording.js';
import { CodeScrimLearnerOverlayStore, CodeScrimReplayCursor, findCodeScrimCheckpoint } from '../../common/codeScrimReplay.js';

suite('CodeScrimReplayCursor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const event = (sequence: number, timestamp: number): CodeScrimEditorEvent => ({
		id: `draft:${sequence}`,
		version: 1,
		timestamp,
		sequence,
		domain: 'editor',
		kind: 'editor.activeResourceChanged',
		payload: { resource: { root: 0, path: `file-${sequence}.ts` } },
	});

	test('releases events in recorded order', () => {
		const cursor = new CodeScrimReplayCursor();
		const events = [event(0, 0), event(1, 500), event(2, 500), event(3, 1_000)];
		cursor.reset(events);

		assert.deepStrictEqual(cursor.advance(0), [events[0]]);
		assert.deepStrictEqual(cursor.advance(500), [events[1], events[2]]);
		assert.deepStrictEqual(cursor.advance(750), []);
		assert.strictEqual(cursor.appliedEventCount, 3);
		assert.strictEqual(cursor.ended, false);
		assert.deepStrictEqual(cursor.advance(1_000), [events[3]]);
		assert.strictEqual(cursor.ended, true);
	});

	test('does not move backward when the supplied clock regresses', () => {
		const cursor = new CodeScrimReplayCursor();
		const events = [event(0, 100), event(1, 200)];
		cursor.reset(events);

		assert.deepStrictEqual(cursor.advance(150), [events[0]]);
		assert.deepStrictEqual(cursor.advance(50), []);
		assert.deepStrictEqual(cursor.advance(200), [events[1]]);
	});

	test('reset returns to the start', () => {
		const cursor = new CodeScrimReplayCursor();
		const events = [event(0, 0)];
		cursor.reset(events);
		cursor.advance(0);
		cursor.reset(events);

		assert.strictEqual(cursor.appliedEventCount, 0);
		assert.deepStrictEqual(cursor.advance(0), events);
	});

	test('resets directly to a checkpoint event index', () => {
		const cursor = new CodeScrimReplayCursor();
		const events = [event(0, 100), event(1, 100), event(2, 200)];
		cursor.reset(events, 2, 100);

		assert.strictEqual(cursor.appliedEventCount, 2);
		assert.deepStrictEqual(cursor.advance(100), []);
		assert.deepStrictEqual(cursor.advance(200), [events[2]]);
	});

	test('releases one event without consuming the rest of a timestamp batch', () => {
		const cursor = new CodeScrimReplayCursor();
		const events = [event(0, 100), event(1, 100), event(2, 200)];
		cursor.reset(events);

		assert.strictEqual(cursor.advanceOne(100), events[0]);
		assert.strictEqual(cursor.appliedEventCount, 1);
		assert.strictEqual(cursor.advanceOne(100), events[1]);
		assert.strictEqual(cursor.advanceOne(100), undefined);
		assert.strictEqual(cursor.advanceOne(200), events[2]);
	});
});

suite('CodeScrim checkpoint index', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('finds the nearest checkpoint at or before the target', () => {
		const checkpoint = (timestamp: number, eventIndex: number) => ({ timestamp, eventIndex, documents: [], entries: [], skippedEntryCount: 0 });
		const checkpoints = [checkpoint(0, 0), checkpoint(30_000, 20), checkpoint(60_000, 45)];

		assert.strictEqual(findCodeScrimCheckpoint(checkpoints, 0), checkpoints[0]);
		assert.strictEqual(findCodeScrimCheckpoint(checkpoints, 59_999), checkpoints[1]);
		assert.strictEqual(findCodeScrimCheckpoint(checkpoints, 60_000), checkpoints[2]);
		assert.strictEqual(findCodeScrimCheckpoint(checkpoints, 90_000), checkpoints[2]);
	});
});

suite('CodeScrimLearnerOverlayStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const resource = { root: 0, path: 'lesson.ts' };

	test('removes an overlay when learner and instructor text match', () => {
		const overlays = new CodeScrimLearnerOverlayStore();
		overlays.record(resource, 'const answer = 42;', '');
		assert.strictEqual(overlays.hasChanges(resource), true);

		overlays.record(resource, 'const answer = 42;', 'const answer = 42;');
		assert.strictEqual(overlays.hasChanges(resource), false);
	});

	test('blocks an instructor edit until learner chooses a resolution', () => {
		const overlays = new CodeScrimLearnerOverlayStore();
		overlays.record(resource, 'const answer = 43;', 'const answer = 42;');

		assert.strictEqual(overlays.advanceInstructor(resource, 'const answer = 44;', true), 'conflict');
		assert.deepStrictEqual(overlays.state.conflict?.resource, resource);
		assert.strictEqual(overlays.keep(resource), true);
		assert.strictEqual(overlays.state.conflict, undefined);
		assert.strictEqual(overlays.advanceInstructor(resource, 'const answer = 45;', true), 'keep');
	});

	test('restores the instructor branch by discarding only learner text', () => {
		const overlays = new CodeScrimLearnerOverlayStore();
		overlays.record(resource, 'learner', 'instructor');
		assert.strictEqual(overlays.restore(resource), true);
		assert.strictEqual(overlays.hasChanges(resource), false);
		assert.strictEqual(overlays.advanceInstructor(resource, 'next instructor', true), 'apply');
	});

	test('preserves an overlay throughout checkpoint reconstruction', () => {
		const overlays = new CodeScrimLearnerOverlayStore();
		overlays.record(resource, 'temporary match', 'start');

		assert.strictEqual(overlays.advanceInstructor(resource, 'temporary match', false), 'keep');
		assert.strictEqual(overlays.advanceInstructor(resource, 'final instructor', false), 'keep');
		assert.strictEqual(overlays.getText(resource), 'temporary match');
	});
});
