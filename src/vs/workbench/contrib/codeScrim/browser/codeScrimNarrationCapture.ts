/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICodeScrimNarrationSegment, ICodeScrimNarrationTrack } from '../common/codeScrimNarration.js';

interface IActiveNarrationSegment {
	readonly recorder: MediaRecorder;
	readonly start: number;
	readonly chunks: Blob[];
}

/** Owns microphone resources for one recording without coupling CodeScrim to Chat voice mode. */
export class CodeScrimNarrationCapture extends Disposable {
	private stream: MediaStream | undefined;
	private activeSegment: IActiveNarrationSegment | undefined;
	private readonly segments: ICodeScrimNarrationSegment[] = [];

	constructor(
		private readonly notificationService: INotificationService,
		private readonly logService: ILogService,
	) {
		super();
	}

	async prepare(): Promise<boolean> {
		this.discard();
		if (typeof mainWindow.MediaRecorder === 'undefined' || !mainWindow.navigator.mediaDevices?.getUserMedia) {
			this.notificationService.warn(localize('codeScrim.narrationUnsupported', "Microphone recording is unavailable. CodeScrim will continue without narration."));
			return false;
		}

		try {
			this.stream = await mainWindow.navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true,
				},
				video: false,
			});
			return true;
		} catch (error) {
			this.logService.warn('[CodeScrim] Microphone acquisition failed. Recording will continue without narration.', error);
			this.notificationService.warn(localize('codeScrim.narrationUnavailable', "CodeScrim could not access the microphone. Recording will continue without narration."));
			return false;
		}
	}

	startSegment(start: number): void {
		if (!this.stream || this.activeSegment) {
			return;
		}
		for (const track of this.stream.getAudioTracks()) {
			track.enabled = true;
		}

		try {
			const mimeType = this.selectMimeType();
			const recorder = new mainWindow.MediaRecorder(this.stream, {
				...(mimeType ? { mimeType } : {}),
				audioBitsPerSecond: 96_000,
			});
			const segment: IActiveNarrationSegment = { recorder, start, chunks: [] };
			recorder.ondataavailable = event => {
				if (event.data.size) {
					segment.chunks.push(event.data);
				}
			};
			recorder.onerror = event => this.logService.error('[CodeScrim] Narration MediaRecorder failed.', event);
			this.activeSegment = segment;
			recorder.start(1_000);
		} catch (error) {
			this.logService.error('[CodeScrim] Could not start narration capture.', error);
			this.notificationService.warn(localize('codeScrim.narrationStartFailed', "Microphone narration stopped, but the CodeScrim recording will continue."));
			this.releaseStream();
		}
	}

	async pause(end: number): Promise<void> {
		await this.stopSegment(end);
		for (const track of this.stream?.getAudioTracks() ?? []) {
			track.enabled = false;
		}
	}

	async finish(end: number): Promise<ICodeScrimNarrationTrack | undefined> {
		await this.stopSegment(end);
		this.releaseStream();
		if (!this.segments.length) {
			return undefined;
		}
		return Object.freeze({ segments: Object.freeze([...this.segments]) });
	}

	discard(): void {
		const active = this.activeSegment;
		this.activeSegment = undefined;
		if (active) {
			active.recorder.ondataavailable = null;
			active.recorder.onstop = null;
			active.recorder.onerror = null;
			if (active.recorder.state !== 'inactive') {
				active.recorder.stop();
			}
		}
		this.releaseStream();
		this.segments.length = 0;
	}

	private async stopSegment(end: number): Promise<void> {
		const segment = this.activeSegment;
		this.activeSegment = undefined;
		if (!segment) {
			return;
		}

		if (segment.recorder.state !== 'inactive') {
			await new Promise<void>(resolve => {
				segment.recorder.onstop = () => resolve();
				segment.recorder.requestData();
				segment.recorder.stop();
			});
		}
		segment.recorder.ondataavailable = null;
		segment.recorder.onstop = null;
		segment.recorder.onerror = null;

		const duration = Math.max(0, end - segment.start);
		if (!duration || !segment.chunks.length) {
			return;
		}
		const blob = new Blob(segment.chunks, { type: segment.recorder.mimeType || segment.chunks[0].type });
		const bytes = new Uint8Array(await blob.arrayBuffer());
		if (!bytes.byteLength) {
			return;
		}
		this.segments.push(Object.freeze({
			start: segment.start,
			duration,
			mimeType: blob.type || 'audio/webm',
			data: encodeBase64(VSBuffer.wrap(bytes)),
		}));
	}

	private selectMimeType(): string | undefined {
		for (const candidate of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
			if (mainWindow.MediaRecorder.isTypeSupported(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}

	private releaseStream(): void {
		for (const track of this.stream?.getTracks() ?? []) {
			track.stop();
		}
		this.stream = undefined;
	}

	override dispose(): void {
		this.discard();
		super.dispose();
	}
}
