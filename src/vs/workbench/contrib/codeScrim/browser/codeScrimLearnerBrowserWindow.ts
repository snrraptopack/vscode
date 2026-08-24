/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { localize } from '../../../../nls.js';
import { IAuxiliaryWindow, IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { ICodeScrimBrowserPageState, ICodeScrimBrowserSnapshot, ICodeScrimBrowserSurfaceEvent } from '../common/codeScrimBrowser.js';
import { applyCodeScrimBrowserReplayDom } from './codeScrimBrowserReplayDom.js';

/** Owns the passive learner browser replay in a resizable auxiliary window. */
export class CodeScrimLearnerBrowserWindow extends Disposable {
	private readonly windowDisposables = this._register(new MutableDisposable<DisposableStore>());
	private auxiliaryWindow: IAuxiliaryWindow | undefined;
	private frame: HTMLIFrameElement | undefined;
	private tabs: HTMLElement | undefined;
	private title: HTMLElement | undefined;
	private address: HTMLInputElement | undefined;
	private snapshot: ICodeScrimBrowserSnapshot | undefined;
	private renderedSnapshot: ICodeScrimBrowserSnapshot | undefined;
	private scrollTop = 0;
	private pages: readonly ICodeScrimBrowserPageState[] = [];
	private browserActive = false;
	private renderedScrollTop = 0;
	private suppressed = false;
	private opening: Promise<void> | undefined;
	private navigationHandler: ((query: string) => Promise<boolean>) | undefined;

	constructor(private readonly auxiliaryWindowService: IAuxiliaryWindowService) {
		super();
	}

	setNavigationHandler(handler: (query: string) => Promise<boolean>): void {
		this.navigationHandler = handler;
	}

	clearNavigationHandler(handler: (query: string) => Promise<boolean>): void {
		if (this.navigationHandler === handler) {
			this.navigationHandler = undefined;
		}
	}

	show(snapshot: ICodeScrimBrowserSnapshot | undefined, scrollTop = snapshot?.scrollTop ?? 0, pages: readonly ICodeScrimBrowserPageState[] = [], activeSurface?: ICodeScrimBrowserSurfaceEvent): void {
		const wasActive = this.browserActive;
		this.snapshot = snapshot;
		this.scrollTop = scrollTop;
		this.pages = pages;
		this.browserActive = activeSurface ? activeSurface.surface === 'browser' : snapshot !== undefined;
		if (!snapshot) {
			this.close(false);
			return;
		}
		if (!this.auxiliaryWindow && !this.suppressed && this.browserActive) {
			void this.open();
			return;
		}
		this.render();
		if (!wasActive && this.browserActive) {
			this.auxiliaryWindow?.window.focus();
		} else if (wasActive && !this.browserActive) {
			mainWindow.focus();
		}
	}

	async toggle(): Promise<void> {
		if (this.auxiliaryWindow) {
			this.close(true);
			return;
		}
		this.suppressed = false;
		await this.open();
	}

	private async open(): Promise<void> {
		if (this.auxiliaryWindow) {
			this.auxiliaryWindow.window.focus();
			return;
		}
		if (this.opening) {
			return this.opening;
		}
		this.opening = this.doOpen();
		try {
			await this.opening;
		} finally {
			this.opening = undefined;
		}
	}

	private async doOpen(): Promise<void> {
		const auxiliaryWindow = await this.auxiliaryWindowService.open({
			bounds: { width: 1180, height: 780 },
			nativeTitlebar: false,
			noBackgroundThrottling: true,
			backgroundColor: '#181818',
		});
		await auxiliaryWindow.whenStylesHaveLoaded;
		this.auxiliaryWindow = auxiliaryWindow;
		this.buildWindow(auxiliaryWindow);
	}

	private buildWindow(auxiliaryWindow: IAuxiliaryWindow): void {
		const store = new DisposableStore();
		this.windowDisposables.value = store;
		store.add(auxiliaryWindow);
		store.add(auxiliaryWindow.onUnload(() => {
			if (this.auxiliaryWindow === auxiliaryWindow) {
				this.close(true);
			}
		}));

		const document = auxiliaryWindow.window.document;
		document.title = localize('codeScrim.learnerBrowserWindowTitle', "CodeScrim Lesson Preview");
		auxiliaryWindow.window.document.body.classList.add('codescrim-browser-window-body');
		auxiliaryWindow.container.classList.add('codescrim-browser-window', 'codescrim-browser-replay-window');
		auxiliaryWindow.container.textContent = '';

		const toolbar = mainWindow.document.createElement('form');
		toolbar.className = 'codescrim-browser-window-toolbar';
		const identity = mainWindow.document.createElement('div');
		identity.className = 'codescrim-browser-window-identity';
		this.title = mainWindow.document.createElement('strong');
		identity.append(this.title);
		this.address = mainWindow.document.createElement('input');
		this.address.className = 'codescrim-browser-window-address';
		this.address.type = 'search';
		this.address.spellcheck = false;
		this.address.placeholder = localize('codeScrim.searchRecordedPages', "Search recorded pages or enter a recorded URL");
		this.address.setAttribute('aria-label', localize('codeScrim.recordedBrowserAddress', "Recorded browser address"));
		const badge = mainWindow.document.createElement('span');
		badge.className = 'codescrim-browser-window-badge';
		badge.textContent = localize('codeScrim.lessonPreviewBadge', "Lesson Preview");
		toolbar.append(identity, this.address, badge);
		toolbar.addEventListener('submit', event => {
			event.preventDefault();
			void this.openRecordedPage(this.address?.value ?? '');
		});

		this.tabs = mainWindow.document.createElement('nav');
		this.tabs.className = 'codescrim-browser-window-tabs';
		this.tabs.setAttribute('aria-label', localize('codeScrim.recordedBrowserTabs', "Recorded browser tabs"));

		const frame = this.frame = mainWindow.document.createElement('iframe');
		frame.className = 'codescrim-browser-window-frame';
		frame.sandbox.add('allow-same-origin');
		frame.title = localize('codeScrim.recordedBrowserFrameTitle', "Recorded instructor page");
		frame.addEventListener('load', () => {
			this.renderedSnapshot = undefined;
			this.render();
		});
		auxiliaryWindow.container.append(this.tabs, toolbar, frame);
		this.render();
	}

	private render(): void {
		const snapshot = this.snapshot;
		const frame = this.frame;
		if (!snapshot || !frame) {
			return;
		}
		this.renderTabs();
		if (this.title) {
			this.title.textContent = snapshot.title || localize('codeScrim.untitledBrowserPage', "Browser");
		}
		if (this.address) {
			this.address.value = snapshot.url;
			this.address.setCustomValidity('');
		}
		const snapshotChanged = this.renderedSnapshot !== snapshot;
		if (snapshotChanged) {
			this.renderedSnapshot = snapshot;
			if (!applyCodeScrimBrowserReplayDom(frame, snapshot.html)) {
				return;
			}
		}
		if (snapshotChanged || this.renderedScrollTop !== this.scrollTop) {
			this.renderedScrollTop = this.scrollTop;
			frame.contentWindow?.requestAnimationFrame(() => frame.contentWindow?.scrollTo(0, this.scrollTop));
		}
	}

	private renderTabs(): void {
		const tabs = this.tabs;
		if (!tabs) {
			return;
		}
		tabs.textContent = '';
		for (const page of this.pages) {
			const tab = mainWindow.document.createElement('button');
			tab.type = 'button';
			tab.className = 'codescrim-browser-window-tab';
			tab.classList.toggle('active', page.active || page.pageId === this.snapshot?.pageId);
			tab.textContent = page.title || page.url;
			tab.title = page.url;
			tab.addEventListener('click', () => void this.openRecordedPage(page.pageId));
			tabs.appendChild(tab);
		}
	}

	private async openRecordedPage(query: string): Promise<void> {
		const address = this.address;
		const handled = await this.navigationHandler?.(query);
		if (!address || handled) {
			return;
		}
		address.setCustomValidity(localize('codeScrim.recordedPageNotFound', "That page is not present in this recording."));
		address.reportValidity();
	}

	private close(suppress: boolean): void {
		this.suppressed = suppress;
		this.auxiliaryWindow = undefined;
		this.frame = undefined;
		this.tabs = undefined;
		this.title = undefined;
		this.address = undefined;
		this.renderedSnapshot = undefined;
		this.renderedScrollTop = 0;
		this.browserActive = false;
		this.windowDisposables.clear();
	}
}
