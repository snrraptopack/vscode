/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64 } from '../../../../base/common/buffer.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { CodeScrimBrowserEventData, ICodeScrimBrowserThumbnail, ICodeScrimBrowserTrack, ICodeScrimBrowserVisibility } from '../common/codeScrimBrowser.js';

const THUMBNAIL_FORMAT = 'jpeg';
const THUMBNAIL_QUALITY = 60;

/**
 * Records the instructor Integrated Browser as semantic state events plus sparse
 * scrubber thumbnails. Replay reconstructs the page in a live read-only browser;
 * recording never captures executable page content and never drives the page.
 */
export class CodeScrimBrowserCapture extends Disposable {
	private readonly pageListeners = this._register(new DisposableMap<string, DisposableStore>());
	private readonly pendingCaptures = new Set<Promise<void>>();
	private readonly capturingPages = new Set<string>();
	private readonly events: (CodeScrimBrowserEventData & { readonly timestamp: number })[] = [];
	private readonly thumbnails: ICodeScrimBrowserThumbnail[] = [];
	private readonly visibility: ICodeScrimBrowserVisibility[] = [];
	private readonly visiblePages = new Map<string, boolean>();
	/** Deduplication state per page: only a cheap content hash is retained. */
	private readonly lastThumbnail = new Map<string, { url: string; title: string; dataHash: number }>();
	private position: (() => number) | undefined;
	private active = false;
	private generation = 0;

	constructor(
		private readonly browserViewService: IBrowserViewWorkbenchService,
		private readonly logService: ILogService,
	) {
		super();
		this._register(this.browserViewService.onDidChangeBrowserViews(() => this.attachKnownPages()));
	}

	async start(position: () => number): Promise<void> {
		this.reset();
		this.position = position;
		this.active = true;
		this.attachKnownPages();
		await this.captureBoundaryThumbnails(0);
	}

	async pause(position: number): Promise<void> {
		if (!this.active) {
			return;
		}
		await this.captureBoundaryThumbnails(position);
		this.active = false;
		await this.waitForPendingCaptures();
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
			await this.captureBoundaryThumbnails(position);
		}
		this.active = false;
		await this.waitForPendingCaptures();
		if (!this.events.length && !this.thumbnails.length && !this.visibility.length) {
			this.reset();
			return undefined;
		}

		const track: ICodeScrimBrowserTrack = Object.freeze({
			events: Object.freeze([...this.events].sort((left, right) => left.timestamp - right.timestamp)),
			thumbnails: Object.freeze([...this.thumbnails].sort((left, right) => left.timestamp - right.timestamp)),
			visibility: Object.freeze([...this.visibility].sort((left, right) => left.timestamp - right.timestamp)),
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
		this.thumbnails.length = 0;
		this.visibility.length = 0;
		this.visiblePages.clear();
		this.lastThumbnail.clear();
		this.pendingCaptures.clear();
		this.capturingPages.clear();
	}

	private attachKnownPages(): void {
		for (const input of this.browserViewService.getKnownBrowserViews().values()) {
			this.attachPage(input);
		}
	}

	private attachPage(input: BrowserEditorInput): void {
		if (this.pageListeners.has(input.id)) {
			return;
		}
		const listeners = new DisposableStore();
		this.pageListeners.set(input.id, listeners);
		void input.resolve().then(model => {
			if (!this.pageListeners.has(input.id)) {
				return;
			}
			this.recordVisibility(model);
			if (model.visible && this.active) {
				this.recordVisibility(model, true);
				this.captureThumbnail(model);
			}
			listeners.add(model.onDidChangeVisibility(() => {
				this.recordVisibility(model);
				if (model.visible && this.active) {
					this.captureThumbnail(model);
				}
			}));
			listeners.add(model.onDidChangeFocus(() => {
				if (model.focused) {
					this.recordVisibility(model, true);
				}
			}));
			listeners.add(model.onDidNavigate(event => {
				this.append({ kind: 'browser.navigated', payload: { pageId: model.id, url: event.url } });
				if (model.visible && this.active) {
					this.captureThumbnail(model);
				}
			}));
			listeners.add(model.onDidChangeTitle(event => this.append({ kind: 'browser.titleChanged', payload: { pageId: model.id, title: event.title } })));
			listeners.add(model.onDidChangeZoom(() => this.append({ kind: 'browser.zoomChanged', payload: { pageId: model.id, zoomFactor: model.zoomFactor } })));
			listeners.add(model.onDidChangeDevice(() => this.append({
				kind: 'browser.deviceChanged',
				payload: { pageId: model.id, ...(model.device?.width !== undefined ? { width: model.device.width } : {}), ...(model.device?.height !== undefined ? { height: model.device.height } : {}) },
			})));
			listeners.add(model.onDidClose(() => {
				this.recordVisibility(model, false);
				this.append({ kind: 'browser.pageClosed', payload: { pageId: model.id } });
				this.pageListeners.deleteAndDispose(model.id);
			}));
		}, error => this.logService.warn('[CodeScrim] Could not attach browser capture to an Integrated Browser page.', error));
	}

	private append(event: CodeScrimBrowserEventData): void {
		if (!this.active) {
			return;
		}
		this.events.push(Object.freeze({
			timestamp: Math.max(0, Math.round(this.position?.() ?? 0)),
			...event,
		}) as CodeScrimBrowserEventData & { readonly timestamp: number });
	}

	/**
	 * Captures a pinned thumbnail at boundaries the sparse cadence cannot guarantee
	 * (recording start, pause, stop, navigation): these must exist exactly at their
	 * clock position even if nothing else changed.
	 */
	private async captureBoundaryThumbnails(timestamp: number): Promise<void> {
		for (const input of this.browserViewService.getKnownBrowserViews().values()) {
			if (input.model?.visible) {
				this.captureThumbnail(input.model, timestamp);
			}
		}
		await this.waitForPendingCaptures();
	}

	private captureThumbnail(model: IBrowserViewModel, timestamp?: number): void {
		if (!this.active || !model.visible || this.capturingPages.has(model.id)) {
			return;
		}

		const generation = this.generation;
		this.capturingPages.add(model.id);
		const pending = model.captureScreenshot({ format: THUMBNAIL_FORMAT, quality: THUMBNAIL_QUALITY }).then(screenshot => {
			if (generation !== this.generation) {
				return;
			}
			const data = encodeBase64(screenshot);
			const dataHash = hash(data);
			const previous = this.lastThumbnail.get(model.id);
			if (previous?.dataHash === dataHash && previous.url === model.url && previous.title === model.title) {
				return;
			}
			this.lastThumbnail.set(model.id, { url: model.url, title: model.title, dataHash });
			this.thumbnails.push(Object.freeze({
				timestamp: Math.max(0, Math.round(timestamp ?? this.position?.() ?? 0)),
				pageId: model.id,
				url: model.url,
				title: model.title,
				mimeType: 'image/jpeg' as const,
				data,
			}));
		}, error => this.logService.warn('[CodeScrim] Could not capture an Integrated Browser thumbnail.', error)).finally(() => {
			this.pendingCaptures.delete(pending);
			if (generation === this.generation) {
				this.capturingPages.delete(model.id);
			}
		});
		this.pendingCaptures.add(pending);
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

	private async waitForPendingCaptures(): Promise<void> {
		if (this.pendingCaptures.size) {
			await Promise.allSettled([...this.pendingCaptures]);
		}
	}
}
