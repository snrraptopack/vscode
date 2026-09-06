/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout, Limiter, raceTimeout, ThrottledDelayer } from '../../../../base/common/async.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IBrowserViewModel } from '../../browserView/common/browserView.js';
import { ICodeScrimBrowserPageEvent, ICodeScrimBrowserScroll, ICodeScrimBrowserSnapshot, ICodeScrimBrowserSurfaceEvent, ICodeScrimBrowserTrack, ICodeScrimBrowserVisibility } from '../common/codeScrimBrowser.js';
import { ICodeScrimBrowserWindowService } from './codeScrimBrowserWindowService.js';

const SNAPSHOT_SETTLE_DELAY_MS = 500;
const POST_LOAD_CAPTURE_DELAYS_MS = [750, 2000] as const;
const SNAPSHOT_MAX_PENDING = 1;
const SNAPSHOT_MIN_INTERVAL_MS = 2000;
const SNAPSHOT_MAX_HTML_LENGTH = 16 * 1024 * 1024;
const SNAPSHOT_MAX_TOTAL_HTML_LENGTH = 64 * 1024 * 1024;
const SNAPSHOT_MAX_COUNT = 1000;
const SNAPSHOT_TIMEOUT_MS = 3000;

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
	private readonly lastSnapshotRequestedAt = new Map<string, number>();
	private readonly disabledSnapshotPages = new Set<string>();
	private totalHtmlLength = 0;
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
		this.lastSnapshotRequestedAt.clear();
		this.disabledSnapshotPages.clear();
		this.totalHtmlLength = 0;
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
		const settledCaptures = listeners.add(new DisposableStore());
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
			// URL and settled DOM as timeline state too.
			if (!model.loading && this.active) {
				this.scheduleSettledCaptures(model, snapshotDelayer, settledCaptures);
			}
		}));
		listeners.add(model.onDidChangeTitle(() => this.recordPage('updated', model.id, undefined, model)));
		// Hidden pages must not keep expensive capture work alive while the
		// instructor is teaching elsewhere. Activating a page captures its latest
		// state through the visibility listener above.
		listeners.add(model.onDidChangeContent(() => this.captureSnapshot(model, snapshotDelayer)));
		listeners.add(model.onDidScroll(event => this.recordScroll(model.id, event.scrollX, event.scrollY)));
		listeners.add(model.onDidChangeLoadingState(() => {
			if (model.loading) {
				settledCaptures.clear();
				return;
			}
			if (this.active) {
				this.recordPage('updated', model.id, undefined, model);
				this.scheduleSettledCaptures(model, snapshotDelayer, settledCaptures);
			}
		}));
		listeners.add(model.onDidClose(() => {
			this.recordVisibility(model, false);
			this.pageListeners.deleteAndDispose(model.id);
		}));
	}

	/**
	 * Captures the committed document and two bounded post-load states. Modern
	 * pages often hydrate after `did-finish-load`; the later captures preserve
	 * that settled content without turning every mutation into a full snapshot.
	 */
	private scheduleSettledCaptures(model: IBrowserViewModel, delayer: ThrottledDelayer<void>, settledCaptures: DisposableStore): void {
		settledCaptures.clear();
		this.captureSnapshot(model, delayer);
		for (const delay of POST_LOAD_CAPTURE_DELAYS_MS) {
			disposableTimeout(() => this.captureSnapshot(model, delayer), delay, settledCaptures);
		}
	}

	/**
	 * Captures a DOM snapshot of every visible page. Used at recording boundaries
	 * (start, pause, stop) so seeks always have an exact state to restore.
	 */
	private async captureAllSnapshots(timestamp: number): Promise<void> {
		const captures: Promise<void>[] = [];
		for (const model of this.browserWindowService.authorPageModels) {
			if (model.visible) {
				captures.push(this.snapshotLimiter.queue(() => this.captureSnapshotNow(model, undefined, timestamp)));
			}
		}
		await Promise.all(captures);
	}

	private captureSnapshot(model: IBrowserViewModel, delayer: ThrottledDelayer<void>): void {
		if (!this.active || !model.visible || this.disabledSnapshotPages.has(model.id) || this.events.length >= SNAPSHOT_MAX_COUNT) {
			return;
		}
		const now = this.position?.() ?? 0;
		if (now - (this.lastSnapshotRequestedAt.get(model.id) ?? Number.NEGATIVE_INFINITY) < SNAPSHOT_MIN_INTERVAL_MS * 1000) {
			return;
		}
		this.lastSnapshotRequestedAt.set(model.id, now);
		const generation = this.generation;
		const timestamp = Math.max(0, Math.round(now));
		void delayer.trigger(() => this.snapshotLimiter.queue(() => this.captureSnapshotNow(model, generation, timestamp)))
			.catch(() => { /* The page or recording was disposed before the trailing capture. */ });
	}

	private async captureSnapshotNow(model: IBrowserViewModel, generation: number | undefined, timestamp: number): Promise<void> {
		if (this.disabledSnapshotPages.has(model.id) || this.events.length >= SNAPSHOT_MAX_COUNT) {
			return;
		}
		try {
			let timedOut = false;
			const snapshot = await raceTimeout(model.captureDomSnapshot(), SNAPSHOT_TIMEOUT_MS, () => timedOut = true);
			if (!snapshot || (generation !== undefined && generation !== this.generation)) {
				if (timedOut && (generation === undefined || generation === this.generation)) {
					this.disablePageCapture(model.id, 'the page did not produce a DOM snapshot within the capture deadline');
				}
				return;
			}
			if (snapshot.html.length > SNAPSHOT_MAX_HTML_LENGTH) {
				this.disablePageCapture(model.id, `a DOM snapshot exceeded ${SNAPSHOT_MAX_HTML_LENGTH} characters`);
				return;
			}
			if (this.totalHtmlLength + snapshot.html.length > SNAPSHOT_MAX_TOTAL_HTML_LENGTH) {
				this.disablePageCapture(model.id, `the recording reached its ${SNAPSHOT_MAX_TOTAL_HTML_LENGTH} character browser snapshot budget`);
				return;
			}
			const scrollTop = Math.max(0, Math.round(snapshot.scrollY));
			this.recordScroll(model.id, 0, snapshot.scrollY, timestamp);
			const dataHash = hash(`${snapshot.url}\0${snapshot.title}\0${snapshot.viewportWidth ?? 0}x${snapshot.viewportHeight ?? 0}\0${snapshot.html}`);
			if (this.lastSnapshotHash.get(model.id) === dataHash) {
				return;
			}
			this.lastSnapshotHash.set(model.id, dataHash);
			this.totalHtmlLength += snapshot.html.length;
			this.events.push(Object.freeze({
				timestamp,
				pageId: model.id,
				url: snapshot.url,
				title: snapshot.title,
				scrollTop,
				...(snapshot.viewportWidth ? { viewportWidth: Math.round(snapshot.viewportWidth) } : {}),
				...(snapshot.viewportHeight ? { viewportHeight: Math.round(snapshot.viewportHeight) } : {}),
				html: snapshot.html,
			}));
		} catch (error) {
			this.logService.warn('[CodeScrim] Could not capture an Integrated Browser DOM snapshot.', error);
		}
	}

	private disablePageCapture(pageId: string, reason: string): void {
		if (this.disabledSnapshotPages.has(pageId)) {
			return;
		}
		this.disabledSnapshotPages.add(pageId);
		this.logService.warn(`[CodeScrim] Stopped passive DOM capture for browser page ${pageId}: ${reason}.`);
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
