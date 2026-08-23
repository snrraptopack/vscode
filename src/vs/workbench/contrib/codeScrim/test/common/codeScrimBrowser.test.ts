/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { findCodeScrimBrowserState, findCodeScrimBrowserThumbnail, findCodeScrimVisiblePage, ICodeScrimBrowserTrack } from '../../common/codeScrimBrowser.js';

suite('CodeScrimBrowser', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const track: ICodeScrimBrowserTrack = {
		events: [
			{ timestamp: 100, kind: 'browser.navigated', payload: { pageId: 'one', url: 'http://one' } },
			{ timestamp: 150, kind: 'browser.titleChanged', payload: { pageId: 'one', title: 'One' } },
			{ timestamp: 200, kind: 'browser.scrolled', payload: { pageId: 'one', scrollTop: 320 } },
			{ timestamp: 500, kind: 'browser.navigated', payload: { pageId: 'two', url: 'http://two' } },
			{ timestamp: 550, kind: 'browser.zoomChanged', payload: { pageId: 'two', zoomFactor: 1.25 } },
		],
		thumbnails: [
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

	test('resolves the visible instructor page at a position', () => {
		assert.deepStrictEqual([
			findCodeScrimVisiblePage(track, 25),
			findCodeScrimVisiblePage(track, 200),
			findCodeScrimVisiblePage(track, 425),
			findCodeScrimVisiblePage(track, 600),
		], [undefined, 'one', undefined, 'two']);
	});

	test('reconstructs recorded state of the visible page at a position', () => {
		assert.deepStrictEqual(findCodeScrimBrowserState(track, 350), {
			pageId: 'one',
			url: 'http://one',
			title: 'One',
			zoomFactor: undefined,
			width: undefined,
			height: undefined,
			scrollTop: 320,
		});
		assert.deepStrictEqual(findCodeScrimBrowserState(track, 600), {
			pageId: 'two',
			url: 'http://two',
			title: undefined,
			zoomFactor: 1.25,
			width: undefined,
			height: undefined,
			scrollTop: undefined,
		});
		assert.strictEqual(findCodeScrimBrowserState(track, 25), undefined);
	});

	test('resolves the scrubber thumbnail of the visible page at a position', () => {
		assert.deepStrictEqual([
			findCodeScrimBrowserThumbnail(track, 200)?.data,
			findCodeScrimBrowserThumbnail(track, 350)?.data,
			findCodeScrimBrowserThumbnail(track, 600)?.data,
		], ['one-a', 'one-b', 'two-a']);
	});

	test('falls back to the most recent thumbnail when the visible page has none yet', () => {
		const partial: ICodeScrimBrowserTrack = {
			events: [{ timestamp: 100, kind: 'browser.navigated', payload: { pageId: 'one', url: 'http://one' } }],
			thumbnails: [
				{ timestamp: 100, pageId: 'one', url: 'http://one', title: 'One', mimeType: 'image/jpeg', data: 'one-a' },
			],
			visibility: [
				{ timestamp: 50, pageId: 'one', visible: true },
				{ timestamp: 400, pageId: 'one', visible: false },
				{ timestamp: 420, pageId: 'two', visible: true },
			],
		};

		assert.strictEqual(findCodeScrimBrowserThumbnail(partial, 430)?.data, 'one-a');
		assert.strictEqual(findCodeScrimVisiblePage(partial, 25), undefined);
	});
});
