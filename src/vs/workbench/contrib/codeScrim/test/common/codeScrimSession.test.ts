/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CodeScrimSessionClock, ICodeScrimLessonDescriptor } from '../../common/codeScrimSession.js';

suite('CodeScrimSessionClock', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const lesson: ICodeScrimLessonDescriptor = {
		id: 'lesson-one',
		title: 'Lesson One',
		duration: 10_000,
	};

	test('opens a lesson in the ready state', () => {
		const clock = new CodeScrimSessionClock();

		assert.deepStrictEqual(clock.openLesson(lesson), {
			lesson,
			status: 'ready',
			position: 0,
			duration: 10_000,
		});
	});

	test('advances from the supplied monotonic anchor', () => {
		const clock = new CodeScrimSessionClock();
		clock.openLesson(lesson);
		clock.play(5_000);

		assert.deepStrictEqual(clock.tick(6_250), {
			lesson,
			status: 'playing',
			position: 1_250,
			duration: 10_000,
		});
	});

	test('pause preserves the resolved position', () => {
		const clock = new CodeScrimSessionClock();
		clock.openLesson(lesson);
		clock.play(100);
		clock.pause(2_600);

		assert.deepStrictEqual(clock.tick(8_000), {
			lesson,
			status: 'paused',
			position: 2_500,
			duration: 10_000,
		});
	});

	test('seek clamps to the lesson and ends playback', () => {
		const clock = new CodeScrimSessionClock();
		clock.openLesson(lesson);
		clock.play(0);

		assert.deepStrictEqual(clock.seek(20_000, 500), {
			lesson,
			status: 'ended',
			position: 10_000,
			duration: 10_000,
		});
	});

	test('playing after completion starts from the beginning', () => {
		const clock = new CodeScrimSessionClock();
		clock.openLesson(lesson, lesson.duration);

		assert.deepStrictEqual(clock.play(1_000), {
			lesson,
			status: 'playing',
			position: 0,
			duration: 10_000,
		});
	});

	test('restart returns to a stable ready state', () => {
		const clock = new CodeScrimSessionClock();
		clock.openLesson(lesson);
		clock.play(0);
		clock.tick(4_000);

		assert.deepStrictEqual(clock.restart(), {
			lesson,
			status: 'ready',
			position: 0,
			duration: 10_000,
		});
	});
});
