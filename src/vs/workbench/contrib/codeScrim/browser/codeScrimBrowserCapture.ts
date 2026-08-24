/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Limiter, ThrottledDelayer } from '../../../../base/common/async.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IBrowserViewModel } from '../../browserView/common/browserView.js';
import { ICodeScrimBrowserPageEvent, ICodeScrimBrowserScroll, ICodeScrimBrowserSnapshot, ICodeScrimBrowserSurfaceEvent, ICodeScrimBrowserTrack, ICodeScrimBrowserVisibility } from '../common/codeScrimBrowser.js';
import { ICodeScrimBrowserWindowService } from './codeScrimBrowserWindowService.js';

const SNAPSHOT_SETTLE_DELAY_MS = 120;
const SNAPSHOT_MAX_PENDING = 2;

/**
 * Records the instructor Integrated Browser as serialized DOM states plus page
 * visibility. Snapshots are passive documents: scripts and event-handler
 * attributes are stripped before they leave the page, so replay can rebuild the
 * recorded page offline without ever executing recorded content.
 */
export class CodeScrimBrowserCapture extends Disposable {
	private readonly pageListeners = this._register(new DisposableMap<string, DisposableStore>());
	private readonly snapshotLimiter = new Limiter<void>(SNAPSHOT_MAX_PENDING);
	private readonly events: ICodeScrimBrowserSnapshot[] = [];
	private readonly visibility: ICodeScrimBrowserVisibility[] = [];
	private readonly scrolls: ICodeScrimBrowserScroll[] = [];
	private readonly pages: ICodeScrimBrowserPageEvent[] = [];
	private readonly surfaces: ICodeScrimBrowserSurfaceEvent[] = [];
	private readonly visiblePages = new Map<string, boolean>();
	private readonly lastSnapshotHash = new Map<string, number>();
	private readonly lastScroll = new Map<string, { readonly left: number; readonly top: number }>();
	private position: (() => number) | undefined;
	private active = false;
	private generation = 0;

	constructor(
		private readonly browserWindowService: ICodeScrimBrowserWindowService,
		private readonly logService: ILogService,
	) {
		super();
		this._register(this.browserWindowService.onDidChangeAuthorPage(event => {
			if (event.kind === 'opened') {
				this.attachKnownPages();
			}
			const model = this.browserWindowService.authorPageModels.find(candidate => candidate.id === event.pageId);
			this.recordPage(event.kind, event.pageId, undefined, model);
		}));
		this._register(addDisposableListener(mainWindow, 'focus', () => this.recordSurface('workbench')));
	}

	async start(position: () => number): Promise<void> {
		this.reset();
		this.position = position;
		this.active = true;
		this.attachKnownPages();
		for (const model of this.browserWindowService.authorPageModels) {
			this.recordPage('opened', model.id, 0, model);
		}
		if (this.browserWindowService.activeAuthorPageId) {
			const model = this.browserWindowService.authorPageModels.find(candidate => candidate.id === this.browserWindowService.activeAuthorPageId);
			this.recordPage('activated', this.browserWindowService.activeAuthorPageId, 0, model);
		}
		const focused = this.browserWindowService.authorPageModels.find(model => model.focused);
		this.recordSurface(focused ? 'browser' : 'workbench', focused?.id, 0);
		await this.captureAllSnapshots(0);
	}

	async pause(position: number): Promise<void> {
		if (!this.active) {
			return;
		}
		await this.captureAllSnapshots(position);
		this.active = false;
	}

	resume(): void {
		if (this.active || !this.position) {
			return;
		}
		this.active = true;
		this.attachKnownPages();
	}

	async finish(position: number): Promise<ICodeScrimBrowserTrack | undefined> {
		if (this.active) {
			await this.captureAllSnapshots(position);
		}
		this.active = false;
		if (!this.events.length && !this.visibility.length && !this.scrolls.length && !this.pages.length) {
			this.reset();
			return undefined;
		}

		const track: ICodeScrimBrowserTrack = Object.freeze({
			snapshots: Object.freeze([...this.events].sort((left, right) => left.timestamp - right.timestamp)),
			visibility: Object.freeze([...this.visibility].sort((left, right) => left.timestamp - right.timestamp)),
			scrolls: Object.freeze([...this.scrolls].sort((left, right) => left.timestamp - right.timestamp)),
			pages: Object.freeze([...this.pages].sort((left, right) => left.timestamp - right.timestamp)),
			surfaces: Object.freeze([...this.surfaces].sort((left, right) => left.timestamp - right.timestamp)),
		});
		this.reset();
		return track;
	}

	discard(): void {
		this.reset();
	}

	private reset(): void {
		this.generation++;
		this.active = false;
		this.position = undefined;
		this.pageListeners.clearAndDisposeAll();
		this.events.length = 0;
		this.visibility.length = 0;
		this.scrolls.length = 0;
		this.pages.length = 0;
		this.surfaces.length = 0;
		this.visiblePages.clear();
		this.lastSnapshotHash.clear();
		this.lastScroll.clear();
	}

	private attachKnownPages(): void {
		for (const model of this.browserWindowService.authorPageModels) {
			this.attachPage(model);
		}
	}

	private attachPage(model: IBrowserViewModel): void {
		if (this.pageListeners.has(model.id)) {
			return;
		}
		const listeners = new DisposableStore();
		const snapshotDelayer = listeners.add(new ThrottledDelayer<void>(SNAPSHOT_SETTLE_DELAY_MS));
		this.pageListeners.set(model.id, listeners);
		this.recordVisibility(model);
		if (model.visible && this.active) {
			this.recordVisibility(model, true);
			this.captureSnapshot(model, snapshotDelayer);
		}
		listeners.add(model.onDidChangeVisibility(() => {
			this.recordVisibility(model);
			if (model.visible && this.active) {
				this.captureSnapshot(model, snapshotDelayer);
			}
		}));
			listeners.add(model.onDidChangeFocus(() => {
				if (model.focused) {
					this.recordVisibility(model, true);
					this.recordPage('activated', model.id);
					this.recordSurface('browser', model.id);
				}
			}));
			listeners.add(model.onDidNavigate(() => {
				this.recordPage('updated', model.id, undefined, model);
				// Full navigations are captured after loading. Same-document and SPA
				// navigations do not necessarily enter a loading state, so retain their
				// URL and current DOM as a timeline state too.
				if (!model.loading && this.active) {
					this.captureSnapshot(model, snapshotDelayer, true);
				}
			}));
			listeners.add(model.onDidChangeTitle(() => this.recordPage('updated', model.id, undefined, model)));
			listeners.add(model.onDidChangeContent(() => this.captureSnapshot(model, snapshotDelayer)));
			listeners.add(model.onDidScroll(event => this.recordScroll(model.id, event.scrollX, event.scrollY)));
			listeners.add(model.onDidChangeLoadingState(() => {
				if (!model.loading && this.active) {
					this.recordPage('updated', model.id, undefined, model);
					this.captureSnapshot(model, snapshotDelayer, true);
				}
			}));
			listeners.add(model.onDidClose(() => {
				this.recordVisibility(model, false);
				this.pageListeners.deleteAndDispose(model.id);
			}));
	}

	/**
	 * Captures a DOM snapshot of every visible page. Used at recording boundaries
	 * (start, pause, stop) so seeks always have an exact state to restore.
	 */
	private async captureAllSnapshots(timestamp: number): Promise<void> {
		const captures: Promise<void>[] = [];
		for (const model of this.browserWindowService.authorPageModels) {
			captures.push(this.snapshotLimiter.queue(() => this.captureSnapshotNow(model, undefined, timestamp)));
		}
		await Promise.all(captures);
	}

	private captureSnapshot(model: IBrowserViewModel, delayer: ThrottledDelayer<void>, includeBackground = false): void {
		if (!this.active || (!includeBackground && !model.visible)) {
			return;
		}
		const generation = this.generation;
		const timestamp = Math.max(0, Math.round(this.position?.() ?? 0));
		void delayer.trigger(() => this.snapshotLimiter.queue(() => this.captureSnapshotNow(model, generation, timestamp)))
			.catch(() => { /* The page or recording was disposed before the trailing capture. */ });
	}

	private async captureSnapshotNow(model: IBrowserViewModel, generation: number | undefined, timestamp: number): Promise<void> {
		try {
			const snapshot = await model.captureDomSnapshot();
			if (!snapshot || (generation !== undefined && generation !== this.generation)) {
				return;
			}
			const scrollTop = Math.max(0, Math.round(snapshot.scrollY));
			this.recordScroll(model.id, 0, snapshot.scrollY, timestamp);
			const dataHash = hash(`${snapshot.url}\0${snapshot.title}\0${snapshot.html}`);
			if (this.lastSnapshotHash.get(model.id) === dataHash) {
				return;
			}
			this.lastSnapshotHash.set(model.id, dataHash);
			this.events.push(Object.freeze({
				timestamp,
				pageId: model.id,
				url: snapshot.url,
				title: snapshot.title,
				scrollTop,
				html: snapshot.html,
			}));
		} catch (error) {
			this.logService.warn('[CodeScrim] Could not capture an Integrated Browser DOM snapshot.', error);
		}
	}

	private recordScroll(pageId: string, scrollLeft: number, scrollTop: number, timestamp = this.position?.() ?? 0): void {
		if (!this.active) {
			return;
		}
		const left = Math.round(scrollLeft);
		const top = Math.max(0, Math.round(scrollTop));
		const previous = this.lastScroll.get(pageId);
		if (previous?.left === left && previous.top === top) {
			return;
		}
		this.lastScroll.set(pageId, { left, top });
		this.scrolls.push(Object.freeze({
			timestamp: Math.max(0, Math.round(timestamp)),
			pageId,
			scrollLeft: left,
			scrollTop: top,
		}));
	}

	private recordVisibility(model: IBrowserViewModel, visible = model.visible, timestamp = this.position?.() ?? 0): void {
		if (!this.active || this.visiblePages.get(model.id) === visible) {
			return;
		}
		this.visiblePages.set(model.id, visible);
		this.visibility.push(Object.freeze({
			timestamp: Math.max(0, Math.round(timestamp)),
			pageId: model.id,
			visible,
		}));
	}

	private recordPage(kind: ICodeScrimBrowserPageEvent['kind'], pageId: string, timestamp = this.position?.() ?? 0, model?: IBrowserViewModel): void {
		if (!this.active) {
			return;
		}
		const previous = this.pages.at(-1);
		const url = model?.url || undefined;
		const title = model?.title || undefined;
		if (previous?.kind === kind && previous.pageId === pageId && previous.url === url && previous.title === title) {
			return;
		}
		this.pages.push(Object.freeze({
			timestamp: Math.max(0, Math.round(timestamp)),
			pageId,
			kind,
			...(url ? { url } : {}),
			...(title ? { title } : {}),
		}));
	}

	private recordSurface(surface: ICodeScrimBrowserSurfaceEvent['surface'], pageId?: string, timestamp = this.position?.() ?? 0): void {
		if (!this.active) {
			return;
		}
		const previous = this.surfaces.at(-1);
		if (previous?.surface === surface && previous.pageId === pageId) {
			return;
		}
		this.surfaces.push(Object.freeze({
			timestamp: Math.max(0, Math.round(timestamp)),
			surface,
			...(pageId ? { pageId } : {}),
		}));
	}
}
