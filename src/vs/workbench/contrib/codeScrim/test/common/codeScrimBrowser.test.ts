/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { findCodeScrimActiveSurface, findCodeScrimBrowserPagePosition, findCodeScrimBrowserPages, findCodeScrimBrowserScroll, findCodeScrimBrowserSnapshot, findCodeScrimVisiblePage, ICodeScrimBrowserTrack } from '../../common/codeScrimBrowser.js';

suite('CodeScrimBrowser', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const track: ICodeScrimBrowserTrack = {
		snapshots: [
			{ timestamp: 100, pageId: 'one', url: 'http://one', title: 'One', scrollTop: 0, html: '<html>one-a</html>' },
			{ timestamp: 300, pageId: 'one', url: 'http://one', title: 'One', scrollTop: 320, html: '<html>one-b</html>' },
			{ timestamp: 500, pageId: 'two', url: 'http://two', title: 'Two', scrollTop: 0, html: '<html>two-a</html>' },
		],
		visibility: [
			{ timestamp: 50, pageId: 'one', visible: true },
			{ timestamp: 400, pageId: 'one', visible: false },
			{ timestamp: 450, pageId: 'two', visible: true },
		],
		scrolls: [
			{ timestamp: 110, pageId: 'one', scrollLeft: 0, scrollTop: 20 },
			{ timestamp: 250, pageId: 'one', scrollLeft: 0, scrollTop: 220 },
			{ timestamp: 510, pageId: 'two', scrollLeft: 0, scrollTop: 80 },
		],
		pages: [
			{ timestamp: 40, pageId: 'one', kind: 'opened' },
			{ timestamp: 50, pageId: 'one', kind: 'activated' },
			{ timestamp: 440, pageId: 'two', kind: 'opened' },
			{ timestamp: 450, pageId: 'two', kind: 'activated' },
		],
		surfaces: [
			{ timestamp: 50, surface: 'browser', pageId: 'one' },
			{ timestamp: 400, surface: 'workbench' },
			{ timestamp: 450, surface: 'browser', pageId: 'two' },
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

	test('resolves the latest snapshot of the visible page at a position', () => {
		assert.deepStrictEqual([
			findCodeScrimBrowserSnapshot(track, 200)?.html,
			findCodeScrimBrowserSnapshot(track, 350)?.html,
			findCodeScrimBrowserSnapshot(track, 600)?.html,
		], ['<html>one-a</html>', '<html>one-b</html>', '<html>two-a</html>']);
		assert.deepStrictEqual(findCodeScrimBrowserSnapshot(track, 350), {
			timestamp: 300,
			pageId: 'one',
			url: 'http://one',
			title: 'One',
			scrollTop: 320,
			html: '<html>one-b</html>',
		});
		assert.strictEqual(findCodeScrimBrowserSnapshot(track, 25), undefined);
	});

	test('falls back to the most recent snapshot when the visible page has none yet', () => {
		const partial: ICodeScrimBrowserTrack = {
			snapshots: [
				{ timestamp: 100, pageId: 'one', url: 'http://one', title: 'One', scrollTop: 0, html: '<html>one-a</html>' },
			],
			visibility: [
				{ timestamp: 50, pageId: 'one', visible: true },
				{ timestamp: 400, pageId: 'one', visible: false },
				{ timestamp: 420, pageId: 'two', visible: true },
			],
			scrolls: [],
			pages: [],
			surfaces: [],
		};

		assert.strictEqual(findCodeScrimBrowserSnapshot(partial, 430)?.html, '<html>one-a</html>');
		assert.strictEqual(findCodeScrimVisiblePage(partial, 25), undefined);
	});

	test('uses ordered tab activation while BrowserView visibility is delayed', () => {
		const delayedVisibility: ICodeScrimBrowserTrack = {
			snapshots: [
				{ timestamp: 100, pageId: 'two', url: 'https://two', title: 'Two', scrollTop: 0, html: '<html>two</html>' },
				{ timestamp: 200, pageId: 'one', url: 'https://one', title: 'One', scrollTop: 0, html: '<html>one</html>' },
			],
			visibility: [
				{ timestamp: 150, pageId: 'one', visible: true },
				{ timestamp: 350, pageId: 'one', visible: false },
				{ timestamp: 350, pageId: 'two', visible: true },
			],
			scrolls: [],
			pages: [
				{ timestamp: 0, pageId: 'one', kind: 'opened' },
				{ timestamp: 0, pageId: 'two', kind: 'opened' },
				{ timestamp: 150, pageId: 'one', kind: 'activated' },
				{ timestamp: 300, pageId: 'two', kind: 'activated' },
			],
			surfaces: [],
		};

		assert.strictEqual(findCodeScrimVisiblePage(delayedVisibility, 320), 'one');
		assert.strictEqual(findCodeScrimBrowserSnapshot(delayedVisibility, 320)?.pageId, 'two');
	});

	test('resolves tab structure and active teaching surface', () => {
		assert.deepStrictEqual(findCodeScrimBrowserPages(track, 200), [
			{ pageId: 'one', url: 'http://one', title: 'One', active: true, activeAt: 50, snapshot: track.snapshots[0], scrollTop: 20 },
		]);
		assert.deepStrictEqual(findCodeScrimBrowserPages(track, 600), [
			{ pageId: 'one', url: 'http://one', title: 'One', active: false, snapshot: track.snapshots[1], scrollTop: 220 },
			{ pageId: 'two', url: 'http://two', title: 'Two', active: true, activeAt: 450, snapshot: track.snapshots[2], scrollTop: 80 },
		]);
		assert.strictEqual(findCodeScrimActiveSurface(track, 425)?.surface, 'workbench');
		assert.strictEqual(findCodeScrimActiveSurface(track, 600)?.pageId, 'two');
	});

	test('resolves viewport movement independently of DOM snapshots', () => {
		assert.strictEqual(findCodeScrimBrowserScroll(track, 100, 'one'), undefined);
		assert.strictEqual(findCodeScrimBrowserScroll(track, 200, 'one')?.scrollTop, 20);
		assert.strictEqual(findCodeScrimBrowserScroll(track, 350, 'one')?.scrollTop, 220);
		assert.strictEqual(findCodeScrimBrowserScroll(track, 600, 'two')?.scrollTop, 80);
	});

	test('opens a recorded tab at useful content instead of its initial blank page', () => {
		const tabs: ICodeScrimBrowserTrack = {
			snapshots: [
				{ timestamp: 100, pageId: 'external', url: 'about:blank', title: '', scrollTop: 0, html: '<html></html>' },
				{ timestamp: 300, pageId: 'external', url: 'https://example.com/docs', title: 'Docs', scrollTop: 0, html: '<html>docs-a</html>' },
				{ timestamp: 500, pageId: 'external', url: 'https://example.com/docs', title: 'Docs', scrollTop: 200, html: '<html>docs-b</html>' },
			],
			visibility: [],
			scrolls: [],
			pages: [],
			surfaces: [],
		};

		assert.deepStrictEqual([
			findCodeScrimBrowserPagePosition(tabs, 'external', 200),
			findCodeScrimBrowserPagePosition(tabs, 'external', 600),
			findCodeScrimBrowserPagePosition(tabs, 'example.com', 600),
		], [300, 500, 500]);
	});
});
