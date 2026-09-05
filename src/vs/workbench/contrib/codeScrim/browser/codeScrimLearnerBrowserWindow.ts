/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ICodeScrimBrowserPageState, ICodeScrimBrowserSnapshot, ICodeScrimBrowserSurfaceEvent } from '../common/codeScrimBrowser.js';
import { applyCodeScrimBrowserReplayDom } from './codeScrimBrowserReplayDom.js';

interface IBrowserBounds { x: number; y: number; width: number; height: number }

/** Passive browser replay, hosted inside the lesson rather than in an OS window. */
export class CodeScrimLearnerBrowserWindow extends Disposable {
	private readonly hostDisposables = this._register(new MutableDisposable<DisposableStore>());
	private host: HTMLElement | undefined;
	private panel: HTMLElement | undefined;
	private frame: HTMLIFrameElement | undefined;
	private address: HTMLInputElement | undefined;
	private pagesSelect: HTMLSelectElement | undefined;
	private expandButton: HTMLButtonElement | undefined;
	private emptyState: HTMLElement | undefined;
	private snapshot: ICodeScrimBrowserSnapshot | undefined;
	private pages: readonly ICodeScrimBrowserPageState[] = [];
	private renderedSnapshot: ICodeScrimBrowserSnapshot | undefined;
	private scrollTop = 0;
	private renderedScrollTop = -1;
	private suppressed = false;
	private explicitlyOpened = false;
	private expanded = false;
	private bounds: IBrowserBounds = { x: 24, y: 56, width: 560, height: 380 };
	private navigationHandler: ((query: string) => Promise<boolean>) | undefined;

	constructor(private readonly storageService: IStorageService) {
		super();
		const saved = storageService.getObject<IBrowserBounds>('codeScrim.learnerBrowserBounds', StorageScope.PROFILE);
		if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) && saved.width > 0 && saved.height > 0) {
			this.bounds = saved;
		}
	}

	attach(host: HTMLElement): IDisposable {
		this.hostDisposables.clear();
		this.host = host;
		const store = new DisposableStore();
		this.hostDisposables.value = store;
		const panel = this.panel = DOM.append(host, DOM.$('section.codescrim-learner-browser', {
			'aria-label': localize('codeScrim.browserPreview', "Lesson browser"),
		}));
		panel.hidden = true;
		store.add(toDisposable(() => panel.remove()));
		const header = DOM.append(panel, DOM.$('header.codescrim-learner-browser-header', { tabindex: '0',
			'aria-label': localize('codeScrim.moveBrowser', "Move Browser. Drag or use arrow keys.") }));
		DOM.append(header, DOM.$('span.codescrim-learner-browser-title', undefined, localize('codeScrim.browserLabel', "Browser")));
		this.pagesSelect = DOM.append(header, DOM.$('select.codescrim-learner-browser-tabs', {
			'aria-label': localize('codeScrim.recordedTabs', "Recorded tabs"),
		}));
		store.add(DOM.addDisposableListener(this.pagesSelect, DOM.EventType.CHANGE, () => {
			void this.navigationHandler?.(this.pagesSelect?.value ?? '');
		}));
		this.expandButton = this.addButton(header, localize('codeScrim.expandBrowser', "Expand"), () => {
			this.expanded = !this.expanded;
			this.layout();
		}, store);
		this.addButton(header, localize('codeScrim.hideBrowser', "Hide"), () => {
			this.suppressed = true;
			panel.hidden = true;
		}, store);
		const toolbar = DOM.append(panel, DOM.$('div.codescrim-learner-browser-toolbar'));
		this.address = DOM.append(toolbar, DOM.$('input.codescrim-browser-window-address', {
			type: 'text', readonly: 'true', 'aria-label': localize('codeScrim.recordedAddress', "Recorded page address"),
		}));
		this.emptyState = DOM.append(panel, DOM.$('div.codescrim-learner-browser-empty', undefined,
			localize('codeScrim.noBrowserFrame', "No recorded browser page at this point in the lesson.")));
		this.frame = DOM.append(panel, DOM.$('iframe.codescrim-browser-window-frame', {
			title: localize('codeScrim.recordedBrowserFrameTitle', "Recorded instructor page"),
		}));
		this.frame.sandbox.add('allow-same-origin');
		store.add(DOM.addDisposableListener(this.frame, 'load', () => {
			this.renderedSnapshot = undefined;
			this.render();
		}));
		const resize = this.addButton(panel, localize('codeScrim.resizeBrowser', "Resize Browser"), () => {}, store);
		resize.classList.add('codescrim-learner-browser-resize');
		resize.textContent = '↘';
		resize.setAttribute('aria-label', localize('codeScrim.resizeBrowserKeys', "Resize Browser. Drag or use arrow keys."));
		this.bindBoundsControl(header, false, store);
		this.bindBoundsControl(resize, true, store);
		const observer = new ResizeObserver(() => this.layout());
		observer.observe(host);
		store.add(toDisposable(() => observer.disconnect()));
		this.renderedSnapshot = undefined;
		this.render();
		return toDisposable(() => {
			if (this.panel === panel) {
				this.hostDisposables.clear();
				this.host = undefined;
				this.panel = undefined;
				this.frame = undefined;
				this.address = undefined;
				this.pagesSelect = undefined;
				this.expandButton = undefined;
				this.emptyState = undefined;
				this.explicitlyOpened = false;
				this.suppressed = false;
			}
		});
	}

	private addButton(parent: HTMLElement, label: string, action: () => void, store: DisposableStore): HTMLButtonElement {
		const button = DOM.append(parent, DOM.$<HTMLButtonElement>('button', { type: 'button' }, label));
		store.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, action));
		return button;
	}

	private bindBoundsControl(control: HTMLElement, resize: boolean, store: DisposableStore): void {
		let drag: { x: number; y: number; bounds: IBrowserBounds } | undefined;
		store.add(DOM.addDisposableListener(control, DOM.EventType.POINTER_DOWN, (event: PointerEvent) => {
			if (event.button !== 0 || this.expanded || (!resize && (event.target as HTMLElement).closest('button, input, select'))) {
				return;
			}
			event.preventDefault();
			control.focus();
			drag = { x: event.clientX, y: event.clientY, bounds: { ...this.bounds } };
			control.setPointerCapture(event.pointerId);
			this.panel?.classList.add('adjusting');
		}));
		store.add(DOM.addDisposableListener(control, DOM.EventType.POINTER_MOVE, (event: PointerEvent) => {
			if (!drag) {
				return;
			}
			const dx = event.clientX - drag.x;
			const dy = event.clientY - drag.y;
			this.bounds = resize
				? { ...drag.bounds, width: drag.bounds.width + dx, height: drag.bounds.height + dy }
				: { ...drag.bounds, x: drag.bounds.x + dx, y: drag.bounds.y + dy };
			this.layout();
		}));
		const finish = () => {
			drag = undefined;
			this.panel?.classList.remove('adjusting');
			this.saveBounds();
		};
		store.add(DOM.addDisposableListener(control, DOM.EventType.POINTER_UP, finish));
		store.add(DOM.addDisposableListener(control, 'pointercancel', finish));
		store.add(DOM.addDisposableListener(control, 'lostpointercapture', finish));
		store.add(DOM.addDisposableListener(control, DOM.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.target !== control || this.expanded || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
				return;
			}
			event.preventDefault();
			const dx = event.key === 'ArrowLeft' ? -20 : event.key === 'ArrowRight' ? 20 : 0;
			const dy = event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0;
			if (resize) {
				this.bounds.width += dx;
				this.bounds.height += dy;
			} else {
				this.bounds.x += dx;
				this.bounds.y += dy;
			}
			this.layout();
			this.saveBounds();
		}));
	}

	private saveBounds(): void {
		this.storageService.store('codeScrim.learnerBrowserBounds', this.bounds, StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private layout(): void {
		if (!this.host || !this.panel || !this.host.clientWidth || !this.host.clientHeight) {
			return;
		}
		const availableWidth = Math.max(1, this.host.clientWidth - 32);
		// The host is the entire workbench, including the terminal. Leave the title bar accessible.
		const topInset = Math.min(48, Math.max(0, this.host.clientHeight - 1));
		const availableHeight = Math.max(1, this.host.clientHeight - topInset - 16);
		this.bounds.width = Math.min(availableWidth, Math.max(320, this.bounds.width));
		this.bounds.height = Math.min(availableHeight, Math.max(220, this.bounds.height));
		this.bounds.x = Math.max(16, Math.min(this.bounds.x, this.host.clientWidth - this.bounds.width - 16));
		this.bounds.y = Math.max(topInset, Math.min(this.bounds.y, this.host.clientHeight - this.bounds.height - 16));
		const bounds = this.expanded ? { x: 16, y: topInset, width: availableWidth, height: availableHeight } : this.bounds;
		Object.assign(this.panel.style, { left: bounds.x + 'px', top: bounds.y + 'px', width: bounds.width + 'px', height: bounds.height + 'px' });
		this.panel.classList.toggle('expanded', this.expanded);
		if (this.expandButton) {
			this.expandButton.textContent = this.expanded ? localize('codeScrim.restoreBrowserSize', "Restore Size") : localize('codeScrim.expandBrowser', "Expand");
			this.expandButton.setAttribute('aria-pressed', String(this.expanded));
		}
	}

	setNavigationHandler(handler: (query: string) => Promise<boolean>): void {
		this.navigationHandler = handler;
	}

	clearNavigationHandler(handler: (query: string) => Promise<boolean>): void {
		if (this.navigationHandler === handler) {
			this.navigationHandler = undefined;
		}
	}

	show(snapshot: ICodeScrimBrowserSnapshot | undefined, scrollTop = snapshot?.scrollTop ?? 0, pages: readonly ICodeScrimBrowserPageState[] = [], _activeSurface?: ICodeScrimBrowserSurfaceEvent): void {
		this.snapshot = snapshot;
		this.scrollTop = scrollTop;
		this.pages = pages;
		if (!snapshot) {
			this.renderedSnapshot = undefined;
		}
		this.render();
	}

	async toggle(): Promise<void> {
		this.suppressed = this.panel ? !this.panel.hidden : false;
		this.explicitlyOpened = !this.suppressed;
		this.render();
	}

	private render(): void {
		if (!this.panel || !this.frame) {
			return;
		}
		this.panel.hidden = (!this.snapshot && !this.explicitlyOpened) || this.suppressed;
		if (this.panel.hidden) {
			return;
		}
		this.layout();
		if (this.address) {
			this.address.value = this.snapshot?.url ?? '';
			this.address.placeholder = localize('codeScrim.recordedBrowserAddress', "Recorded browser");
		}
		this.frame.hidden = !this.snapshot;
		if (this.emptyState) {
			this.emptyState.hidden = !!this.snapshot;
		}
		if (this.pagesSelect) {
			this.pagesSelect.hidden = this.pages.length < 2;
			const signature = JSON.stringify(this.pages.map(page => [page.pageId, page.title, page.url]));
			if (this.pagesSelect.dataset.pages !== signature) {
				this.pagesSelect.dataset.pages = signature;
				DOM.clearNode(this.pagesSelect);
				for (const page of this.pages) {
					DOM.append(this.pagesSelect, DOM.$('option', { value: page.pageId }, page.title || page.url));
				}
			}
			this.pagesSelect.value = this.snapshot?.pageId ?? '';
		}
		if (!this.snapshot) {
			return;
		}
		const changed = this.renderedSnapshot !== this.snapshot;
		if (changed) {
			if (!applyCodeScrimBrowserReplayDom(this.frame, this.snapshot.html)) {
				return;
			}
			this.renderedSnapshot = this.snapshot;
		}
		if (changed || this.renderedScrollTop !== this.scrollTop) {
			this.renderedScrollTop = this.scrollTop;
			this.frame.contentWindow?.scrollTo(0, this.scrollTop);
		}
	}
}
