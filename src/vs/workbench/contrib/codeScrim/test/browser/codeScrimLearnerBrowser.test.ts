/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { CodeScrimLearnerBrowserWindow } from '../../browser/codeScrimLearnerBrowserWindow.js';
import { ICodeScrimBrowserSnapshot } from '../../common/codeScrimBrowser.js';

suite('CodeScrimLearnerBrowser', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const snapshot: ICodeScrimBrowserSnapshot = {
		timestamp: 0, pageId: 'page', url: 'https://example.test', title: 'Example', scrollTop: 0,
		html: '<html><head></head><body><p>Lesson page</p></body></html>',
	};

	function setup() {
		const host = mainWindow.document.createElement('div');
		host.style.cssText = 'position:relative;width:1000px;height:700px';
		mainWindow.document.body.append(host);
		disposables.add(toDisposable(() => host.remove()));
		const storage = disposables.add(new InMemoryStorageService());
		const browser = disposables.add(new CodeScrimLearnerBrowserWindow(storage));
		const lease = disposables.add(browser.attach(host));
		browser.show(snapshot);
		const panel = host.querySelector<HTMLElement>('.codescrim-learner-browser')!;
		return { browser, host, panel, lease };
	}

	test('hiding survives subsequent playback frames and reopening preserves the document', async () => {
		const { browser, panel } = setup();
		const frame = panel.querySelector('iframe');
		await browser.toggle();
		browser.show({ ...snapshot, timestamp: 1000 });
		assert.strictEqual(panel.hidden, true);
		await browser.toggle();
		assert.deepStrictEqual({ hidden: panel.hidden, sameFrame: panel.querySelector('iframe') === frame }, { hidden: false, sameFrame: true });
	});

	test('expansion uses workbench height and restores the floating bounds', () => {
		const { panel } = setup();
		const bounds = panel.style.cssText;
		const expand = Array.from(panel.querySelectorAll('button')).find(button => button.textContent === 'Expand')!;
		expand.click();
		assert.deepStrictEqual({ width: panel.style.width, height: panel.style.height }, { width: '968px', height: '636px' });
		expand.click();
		assert.strictEqual(panel.style.cssText, bounds);
	});

	test('browser opens without a recorded page and stays open across empty frames', async () => {
		const { browser, panel } = setup();
		browser.show(undefined);
		await browser.toggle();
		assert.strictEqual(panel.hidden, false);
		browser.show(undefined);
		assert.strictEqual(panel.hidden, false);
		assert.strictEqual(panel.querySelector<HTMLElement>('.codescrim-learner-browser-empty')!.hidden, false);
		await browser.toggle();
		assert.strictEqual(panel.hidden, true);
	});

	test('top bar moves in both directions and resizing increases height', () => {
		const { panel } = setup();
		const header = panel.querySelector<HTMLElement>('header')!;
		header.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'ArrowRight' }));
		header.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'ArrowDown' }));
		assert.deepStrictEqual({ x: panel.style.left, y: panel.style.top }, { x: '44px', y: '76px' });
		const resize = panel.querySelector<HTMLElement>('.codescrim-learner-browser-resize')!;
		resize.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'ArrowDown' }));
		assert.strictEqual(panel.style.height, '400px');
		assert.strictEqual(panel.querySelector('label'), null);
	});

	test('keyboard resize clamps the browser to its host and disposing the lease removes it', () => {
		const { panel, host, lease } = setup();
		const resize = panel.querySelector<HTMLButtonElement>('.codescrim-learner-browser-resize')!;
		for (let i = 0; i < 100; i++) {
			resize.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'ArrowRight' }));
		}
		assert.strictEqual(panel.style.width, '968px');
		lease.dispose();
		assert.strictEqual(host.children.length, 0);
	});

	test('pointer dragging uses the whole top bar and ignores its buttons', () => {
		const { panel } = setup();
		const header = panel.querySelector<HTMLElement>('header')!;
		// Synthetic pointers do not enter the browser's active pointer registry.
		Object.defineProperty(header, 'setPointerCapture', { value: () => {} });
		const pointer = (target: HTMLElement, type: string, x: number, y: number) => target.dispatchEvent(
			new mainWindow.PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
		pointer(panel.querySelector<HTMLElement>('.codescrim-learner-browser-title')!, 'pointerdown', 40, 70);
		pointer(header, 'pointermove', 240, 270);
		assert.deepStrictEqual({ x: panel.style.left, y: panel.style.top }, { x: '224px', y: '256px' });
		assert.strictEqual(panel.classList.contains('adjusting'), true);
		pointer(header, 'pointerup', 240, 270);
		assert.strictEqual(panel.classList.contains('adjusting'), false);
		pointer(header.querySelector('button')!, 'pointerdown', 240, 270);
		pointer(header, 'pointermove', 340, 370);
		assert.deepStrictEqual({ x: panel.style.left, y: panel.style.top }, { x: '224px', y: '256px' });
	});

	test('address follows navigation metadata before the next DOM snapshot', () => {
		const { browser, panel } = setup();
		browser.show(snapshot, 0, [{ pageId: snapshot.pageId, url: 'https://example.test/settings', title: 'Settings', active: true }]);
		assert.strictEqual(panel.querySelector('input')!.value, 'https://example.test/settings');
	});
});
