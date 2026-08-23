/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { encodeBase64 } from '../../../../base/common/buffer.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { ICodeScrimBrowserFrame, ICodeScrimBrowserTrack, ICodeScrimBrowserVisibility } from '../common/codeScrimBrowser.js';

const BROWSER_CAPTURE_INTERVAL = 750;

/** Captures visible Integrated Browser pages as passive, non-executable lesson frames. */
export class CodeScrimBrowserCapture extends Disposable {
	private readonly pageListeners = this._register(new DisposableMap<string, DisposableStore>());
	private readonly timer = this._register(new MutableDisposable());
	private readonly pendingCaptures = new Set<Promise<void>>();
	private readonly capturingPages = new Set<string>();
	private readonly frames: ICodeScrimBrowserFrame[] = [];
	private readonly visibility: ICodeScrimBrowserVisibility[] = [];
	private readonly visiblePages = new Map<string, boolean>();
	private readonly lastFrame = new Map<string, Pick<ICodeScrimBrowserFrame, 'data' | 'url' | 'title'>>();
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
		this.startTimer();
		await this.captureVisiblePages(0);
	}

	async pause(position: number): Promise<void> {
		if (!this.active) {
			return;
		}
		await this.captureVisiblePages(position);
		this.active = false;
		this.timer.clear();
		await this.waitForPendingCaptures();
	}

	resume(): void {
		if (this.active || !this.position) {
			return;
		}
		this.active = true;
		this.attachKnownPages();
		this.startTimer();
		void this.captureVisiblePages();
	}

	async finish(position: number): Promise<ICodeScrimBrowserTrack | undefined> {
		if (this.active) {
			await this.captureVisiblePages(position);
		}
		this.active = false;
		this.timer.clear();
		await this.waitForPendingCaptures();
		if (!this.frames.length) {
			this.reset();
			return undefined;
		}

		const track: ICodeScrimBrowserTrack = Object.freeze({
			frames: Object.freeze([...this.frames].sort((left, right) => left.timestamp - right.timestamp)),
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
		this.timer.clear();
		this.pageListeners.clearAndDisposeAll();
		this.frames.length = 0;
		this.visibility.length = 0;
		this.visiblePages.clear();
		this.lastFrame.clear();
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
			if (model.visible) {
				this.capture(model);
			}
			listeners.add(model.onDidChangeVisibility(() => {
				this.recordVisibility(model);
				if (model.visible) {
					this.capture(model, undefined, true);
				}
			}));
			listeners.add(model.onDidChangeFocus(() => {
				if (model.focused) {
					this.recordVisibility(model, true);
					this.capture(model);
				}
			}));
			listeners.add(model.onDidNavigate(() => this.capture(model, undefined, true)));
			listeners.add(model.onDidChangeTitle(() => this.capture(model)));
			listeners.add(model.onDidChangeLoadingState(() => {
				if (!model.loading) {
					this.capture(model, undefined, true);
				}
			}));
			listeners.add(model.onDidClose(() => this.recordVisibility(model, false)));
		}, error => this.logService.warn('[CodeScrim] Could not attach browser capture to an Integrated Browser page.', error));
	}

	private startTimer(): void {
		const handle = mainWindow.setInterval(() => void this.captureVisiblePages(), BROWSER_CAPTURE_INTERVAL);
		this.timer.value = toDisposable(() => mainWindow.clearInterval(handle));
	}

	private async captureVisiblePages(timestamp = this.position?.() ?? 0): Promise<void> {
		if (!this.active) {
			return;
		}
		for (const input of this.browserViewService.getKnownBrowserViews().values()) {
			const model = input.model;
			if (model?.visible) {
				this.recordVisibility(model, true, timestamp);
				this.capture(model, timestamp);
			}
		}
		await this.waitForPendingCaptures();
	}

	private capture(model: IBrowserViewModel, timestamp = this.position?.() ?? 0, awaitNextPaint = false): void {
		if (!this.active || !model.visible || this.capturingPages.has(model.id)) {
			return;
		}

		const generation = this.generation;
		this.capturingPages.add(model.id);
		const pending = model.captureScreenshot({ format: 'jpeg', quality: 72, awaitNextPaint }).then(screenshot => {
			if (generation !== this.generation) {
				return;
			}
			const data = encodeBase64(screenshot);
			const previous = this.lastFrame.get(model.id);
			if (previous?.data === data && previous.url === model.url && previous.title === model.title) {
				return;
			}
			const frame: ICodeScrimBrowserFrame = Object.freeze({
				timestamp: Math.max(0, Math.round(timestamp)),
				pageId: model.id,
				url: model.url,
				title: model.title,
				mimeType: 'image/jpeg',
				data,
			});
			this.frames.push(frame);
			this.lastFrame.set(model.id, frame);
		}, error => this.logService.warn('[CodeScrim] Could not capture an Integrated Browser frame.', error)).finally(() => {
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
