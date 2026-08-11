/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CodeScrimEditorEvent } from '../../common/codeScrimRecording.js';
import { CodeScrimReplayCursor } from '../../common/codeScrimReplay.js';

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
});
