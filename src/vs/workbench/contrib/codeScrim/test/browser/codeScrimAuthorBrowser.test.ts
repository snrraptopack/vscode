/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBrowserViewNavigationEvent } from '../../../../../platform/browserView/common/browserView.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IAuxiliaryWindow, IAuxiliaryWindowService } from '../../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { BrowserEditorInput } from '../../../browserView/common/browserEditorInput.js';
import { IBrowserViewModel } from '../../../browserView/common/browserView.js';
import { CodeScrimAuthorBrowserWindow } from '../../browser/codeScrimAuthorBrowserWindow.js';

suite('CodeScrimAuthorBrowser', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup() {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.append(container);
		const title = mainWindow.document.title;
		disposables.add(toDisposable(() => {
			container.remove();
			mainWindow.document.title = title;
			mainWindow.document.body.classList.remove('codescrim-browser-window-body');
		}));
		const navigation = disposables.add(new Emitter<IBrowserViewNavigationEvent>());
		const model = new class extends mock<IBrowserViewModel>() {
			override readonly id = 'test-browser';
			override url = 'https://example.test/';
			override title = 'Example';
			override readonly onDidNavigate = navigation.event;
			override readonly onDidChangeLoadingState = Event.None;
			override readonly onDidChangeTitle = Event.None;
			override readonly onDidClose = Event.None;
			override async setVisible(): Promise<void> { }
			override async focus(): Promise<void> { }
			override async layout(): Promise<void> { }
			override async loadURL(url: string): Promise<void> {
				this.url = url;
				navigation.fire({ url, title: this.title, canGoBack: true, canGoForward: false, certificateError: undefined });
			}
		}();
		const input = new class extends mock<BrowserEditorInput>() {
			override readonly id = model.id;
			override isDisposed(): boolean { return false; }
			override async resolve(): Promise<IBrowserViewModel> { return model; }
		}();
		const auxiliary = new class extends mock<IAuxiliaryWindow>() {
			override readonly window = mainWindow;
			override readonly container = container;
			override readonly whenStylesHaveLoaded = Promise.resolve();
			override readonly onDidLayout = Event.None;
			override readonly onUnload = Event.None;
			override layout(): void { }
			override dispose(): void { }
		}();
		const service = new class extends mock<IAuxiliaryWindowService>() {
			override async open(): Promise<IAuxiliaryWindow> { return auxiliary; }
		}();
		const browser = disposables.add(new CodeScrimAuthorBrowserWindow(input, service, new TestConfigurationService(), () => input));
		await browser.open();
		await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
		return { model, container, address: container.querySelector('input')! };
	}

	test('navigation updates a focused address unless it contains an unsubmitted edit', async () => {
		const { model, address } = await setup();
		address.focus();
		await model.loadURL('https://example.test/settings');
		assert.strictEqual(address.value, model.url);
		address.value = 'my unfinished search';
		address.dispatchEvent(new mainWindow.Event('input'));
		await model.loadURL('https://example.test/redirect');
		assert.strictEqual(address.value, 'my unfinished search');
		address.blur();
		assert.strictEqual(address.value, model.url);
	});

	test('submitting an address allows subsequent redirect updates', async () => {
		const { model, container, address } = await setup();
		address.focus();
		address.value = 'https://example.test/start';
		address.dispatchEvent(new mainWindow.Event('input'));
		container.querySelector('form')!.dispatchEvent(new mainWindow.Event('submit', { cancelable: true }));
		await model.loadURL('https://example.test/destination');
		assert.strictEqual(address.value, model.url);
	});
});
