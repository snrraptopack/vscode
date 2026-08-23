/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { findCodeScrimBrowserFrame, ICodeScrimBrowserTrack } from '../../common/codeScrimBrowser.js';

suite('CodeScrimBrowser', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves only frames from the visible instructor page', () => {
		const track: ICodeScrimBrowserTrack = {
			frames: [
				{ timestamp: 100, pageId: 'one', url: 'http://one', title: 'One', mimeType: 'image/jpeg', data: 'one-a' },
				{ timestamp: 300, pageId: 'one', url: 'http://one', title: 'One', mimeType: 'image/jpeg', data: 'one-b' },
				{ timestamp: 500, pageId: 'two', url: 'http://two', title: 'Two', mimeType: 'image/jpeg', data: 'two-a' },
			],
			visibility: [
				{ timestamp: 50, pageId: 'one', visible: true },
				{ timestamp: 400, pageId: 'one', visible: false },
				{ timestamp: 450, pageId: 'two', visible: true },
			],
		};

		assert.deepStrictEqual([
			findCodeScrimBrowserFrame(track, 25)?.data,
			findCodeScrimBrowserFrame(track, 200)?.data,
			findCodeScrimBrowserFrame(track, 350)?.data,
			findCodeScrimBrowserFrame(track, 425)?.data,
			findCodeScrimBrowserFrame(track, 600)?.data,
		], [undefined, 'one-a', 'one-b', undefined, 'two-a']);
	});

	test('falls back to the most recent recorded frame when the visible page has none yet', () => {
		const track: ICodeScrimBrowserTrack = {
			frames: [
				{ timestamp: 100, pageId: 'one', url: 'http://one', title: 'One', mimeType: 'image/jpeg', data: 'one-a' },
				{ timestamp: 300, pageId: 'one', url: 'http://one', title: 'One', mimeType: 'image/jpeg', data: 'one-b' },
			],
			visibility: [
				{ timestamp: 50, pageId: 'one', visible: true },
				{ timestamp: 400, pageId: 'one', visible: false },
				{ timestamp: 420, pageId: 'two', visible: true },
			],
		};

		assert.strictEqual(findCodeScrimBrowserFrame(track, 430)?.data, 'one-b');
		assert.strictEqual(findCodeScrimBrowserFrame(track, 25), undefined);
	});
});
