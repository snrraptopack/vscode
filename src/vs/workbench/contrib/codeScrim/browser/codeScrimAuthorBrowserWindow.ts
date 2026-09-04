/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getZoomFactor } from '../../../../base/browser/browser.js';
import { getWindowId } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IBrowserViewEditorOpenOptions } from '../../../../platform/browserView/common/browserView.js';
import { IAuxiliaryWindow, IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import { IBrowserViewModel } from '../../browserView/common/browserView.js';

/** Hosts CodeScrim's real Integrated Browser pages without creating editor tabs. */
export class CodeScrimAuthorBrowserWindow extends Disposable {
	private readonly _onDidChangePage = this._register(new Emitter<{ readonly kind: 'opened' | 'closed' | 'activated'; readonly pageId: string }>());
	readonly onDidChangePage: Event<{ readonly kind: 'opened' | 'closed' | 'activated'; readonly pageId: string }> = this._onDidChangePage.event;
	private readonly windowDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly pageDisposables = this._register(new DisposableMap<string, DisposableStore>());
	private readonly pages = new Map<string, IBrowserViewModel>();
	private readonly pageOrder: string[] = [];
	private auxiliaryWindow: IAuxiliaryWindow | undefined;
	private browserHost: HTMLElement | undefined;
	private tabs: HTMLElement | undefined;
	private address: HTMLInputElement | undefined;
	private back: HTMLButtonElement | undefined;
	private forward: HTMLButtonElement | undefined;
	private reload: HTMLButtonElement | undefined;
	private activePageId: string | undefined;

	constructor(
		private readonly initialInput: BrowserEditorInput,
		private readonly auxiliaryWindowService: IAuxiliaryWindowService,
	) {
		super();
	}

	get pageModels(): readonly IBrowserViewModel[] {
		return [...this.pages.values()];
	}

	get activeModelId(): string | undefined {
		return this.activePageId;
	}

	async open(): Promise<void> {
		if (this.auxiliaryWindow && !this.auxiliaryWindow.window.closed) {
			this.auxiliaryWindow.window.focus();
			return;
		}
		if (this.auxiliaryWindow) {
			this.closeWindow();
		}

		await this.addPage(this.initialInput, true);
		const auxiliaryWindow = await this.auxiliaryWindowService.open({
			bounds: { width: 1180, height: 780 },
			nativeTitlebar: false,
			noBackgroundThrottling: true,
			backgroundColor: '#181818',
		});
		try {
			await auxiliaryWindow.whenStylesHaveLoaded;
			this.auxiliaryWindow = auxiliaryWindow;
			this.buildWindow(auxiliaryWindow);
		} catch (error) {
			if (this.auxiliaryWindow === auxiliaryWindow) {
				this.auxiliaryWindow = undefined;
			}
			auxiliaryWindow.dispose();
			throw error;
		}
	}

	/** Claims a popup whose opener is already hosted by this CodeScrim window. */
	acceptCreatedPage(input: BrowserEditorInput, openOptions: IBrowserViewEditorOpenOptions): boolean {
		if (!openOptions.parentViewId || !this.pages.has(openOptions.parentViewId)) {
			return false;
		}
		void this.addPage(input, !openOptions.background);
		return true;
	}

	private async addPage(input: BrowserEditorInput, activate: boolean): Promise<void> {
		let model = this.pages.get(input.id);
		if (!model) {
			model = await input.resolve();
			this.pages.set(model.id, model);
			this.pageOrder.push(model.id);
			this._onDidChangePage.fire({ kind: 'opened', pageId: model.id });
			const store = new DisposableStore();
			this.pageDisposables.set(model.id, store);
			const refresh = () => {
				this.renderTabs();
				this.refreshNavigation();
			};
			store.add(model.onDidNavigate(refresh));
			store.add(model.onDidChangeLoadingState(refresh));
			store.add(model.onDidChangeTitle(refresh));
			store.add(model.onDidClose(() => this.removePage(model!.id)));
		}
		if (activate || !this.activePageId) {
			this.activatePage(model.id);
		} else {
			this.renderTabs();
		}
	}

	private buildWindow(auxiliaryWindow: IAuxiliaryWindow): void {
		const store = new DisposableStore();
		this.windowDisposables.value = store;
		store.add(auxiliaryWindow);

		const targetDocument = auxiliaryWindow.window.document;
		targetDocument.title = localize('codeScrim.authorBrowserWindowTitle', "CodeScrim Browser");
		targetDocument.body.classList.add('codescrim-browser-window-body');
		auxiliaryWindow.container.classList.add('codescrim-browser-window', 'codescrim-browser-author-window');
		auxiliaryWindow.container.textContent = '';

		this.tabs = mainWindow.document.createElement('nav');
		this.tabs.className = 'codescrim-browser-window-tabs';
		this.tabs.setAttribute('aria-label', localize('codeScrim.browserTabs', "Browser tabs"));

		const toolbar = mainWindow.document.createElement('form');
		toolbar.className = 'codescrim-browser-window-toolbar';
		this.back = this.createIconButton(Codicon.arrowLeft, localize('codeScrim.browserBack', "Back"));
		this.forward = this.createIconButton(Codicon.arrowRight, localize('codeScrim.browserForward', "Forward"));
		this.reload = this.createIconButton(Codicon.refresh, localize('codeScrim.browserReload', "Reload"));
		this.address = mainWindow.document.createElement('input');
		this.address.className = 'codescrim-browser-window-address';
		this.address.type = 'text';
		this.address.spellcheck = false;
		this.address.setAttribute('aria-label', localize('codeScrim.browserAddress', "Browser address"));
		toolbar.append(this.back, this.forward, this.reload, this.address);

		this.browserHost = mainWindow.document.createElement('main');
		this.browserHost.className = 'codescrim-browser-window-content';
		auxiliaryWindow.container.append(this.tabs, toolbar, this.browserHost);

		store.add(auxiliaryWindow.onDidLayout(() => this.layoutBrowser()));
		store.add(auxiliaryWindow.onUnload(() => {
			if (this.auxiliaryWindow === auxiliaryWindow) {
				this.closeWindow();
			}
		}));
		store.add({ dispose: () => this.hideAllPages() });

		this.back.addEventListener('click', event => { event.preventDefault(); void this.activeModel?.goBack(); });
		this.forward.addEventListener('click', event => { event.preventDefault(); void this.activeModel?.goForward(); });
		this.reload.addEventListener('click', event => { event.preventDefault(); void this.activeModel?.reload(); });
		toolbar.addEventListener('submit', event => {
			event.preventDefault();
			void this.activeModel?.loadURL(this.address?.value.trim() || 'about:blank');
		});

		this.renderTabs();
		this.refreshNavigation();
		auxiliaryWindow.layout();
		auxiliaryWindow.window.requestAnimationFrame(() => this.activatePage(this.activePageId));
	}

	private get activeModel(): IBrowserViewModel | undefined {
		return this.activePageId ? this.pages.get(this.activePageId) : undefined;
	}

	private activatePage(pageId: string | undefined): void {
		if (!pageId || !this.pages.has(pageId)) {
			return;
		}
		const previous = this.activeModel;
		this.activePageId = pageId;
		const active = this.activeModel;
		if (previous && previous !== active) {
			void previous.setVisible(false);
		}
		this.renderTabs();
		this.refreshNavigation();
		this._onDidChangePage.fire({ kind: 'activated', pageId });
		if (this.auxiliaryWindow && active) {
			this.layoutBrowser();
			void active.setVisible(true);
			void active.focus();
		}
	}

	private renderTabs(): void {
		if (!this.tabs) {
			return;
		}
		this.tabs.textContent = '';
		for (const pageId of this.pageOrder) {
			const model = this.pages.get(pageId);
			if (!model) {
				continue;
			}
			const tab = mainWindow.document.createElement('button');
			tab.type = 'button';
			tab.className = 'codescrim-browser-window-tab';
			tab.classList.toggle('active', pageId === this.activePageId);
			tab.title = model.title || model.url || localize('codeScrim.untitledBrowserPage', "Browser");
			const icon = mainWindow.document.createElement('span');
			icon.className = ThemeIcon.asClassName(Codicon.globe);
			const label = mainWindow.document.createElement('span');
			label.textContent = model.title || model.url || localize('codeScrim.untitledBrowserPage', "Browser");
			tab.append(icon, label);
			tab.addEventListener('click', () => this.activatePage(pageId));
			this.tabs.append(tab);
		}
	}

	private refreshNavigation(): void {
		const model = this.activeModel;
		if (!model) {
			return;
		}
		if (this.address) {
			this.address.value = model.url || 'about:blank';
		}
		if (this.back) {
			this.back.disabled = !model.canGoBack;
		}
		if (this.forward) {
			this.forward.disabled = !model.canGoForward;
		}
		this.reload?.classList.toggle('loading', model.loading);
		if (this.auxiliaryWindow) {
			this.auxiliaryWindow.window.document.title = model.title ? `${model.title} - CodeScrim Browser` : localize('codeScrim.authorBrowserWindowTitle', "CodeScrim Browser");
		}
	}

	private layoutBrowser(): void {
		const auxiliaryWindow = this.auxiliaryWindow;
		const model = this.activeModel;
		const host = this.browserHost;
		if (!auxiliaryWindow || !model || !host) {
			return;
		}
		const bounds = host.getBoundingClientRect();
		void model.layout({
			windowId: getWindowId(auxiliaryWindow.window),
			x: bounds.left,
			y: bounds.top,
			width: bounds.width,
			height: bounds.height,
			zoomFactor: getZoomFactor(auxiliaryWindow.window),
			cornerRadius: 0,
		});
	}

	private removePage(pageId: string): void {
		this.pages.delete(pageId);
		this._onDidChangePage.fire({ kind: 'closed', pageId });
		this.pageDisposables.deleteAndDispose(pageId);
		const index = this.pageOrder.indexOf(pageId);
		if (index >= 0) {
			this.pageOrder.splice(index, 1);
		}
		if (this.activePageId === pageId) {
			this.activePageId = this.pageOrder.at(-1);
			this.activatePage(this.activePageId);
		} else {
			this.renderTabs();
		}
	}

	private hideAllPages(): void {
		for (const model of this.pages.values()) {
			void model.setVisible(false);
		}
	}

	private closeWindow(): void {
		this.hideAllPages();
		this.auxiliaryWindow = undefined;
		this.browserHost = undefined;
		this.tabs = undefined;
		this.address = undefined;
		this.back = undefined;
		this.forward = undefined;
		this.reload = undefined;
		this.windowDisposables.clear();
	}

	private createIconButton(icon: ThemeIcon, title: string): HTMLButtonElement {
		const button = mainWindow.document.createElement('button');
		button.type = 'button';
		button.className = 'codescrim-browser-window-button';
		button.title = title;
		button.setAttribute('aria-label', title);
		const glyph = mainWindow.document.createElement('span');
		glyph.className = ThemeIcon.asClassName(icon);
		button.appendChild(glyph);
		return button;
	}
}
