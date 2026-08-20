/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICodeScrimNarrationSegment, ICodeScrimNarrationTrack } from '../common/codeScrimNarration.js';
import { CodeScrimReplayState } from '../common/codeScrimReplay.js';

const MAXIMUM_AUDIO_DRIFT_MICROSECONDS = 150_000;

/** Decodes packaged narration and schedules it against the authoritative replay clock. */
export class CodeScrimNarrationPlayback extends Disposable {
	private track: ICodeScrimNarrationTrack | undefined;
	private activeSegment: ICodeScrimNarrationSegment | undefined;
	private context: AudioContext | undefined;
	private decoded: AudioBuffer | undefined;
	private source: AudioBufferSourceNode | undefined;
	private sourcePosition = 0;
	private sourceContextTime = 0;
	private desiredPosition = 0;
	private shouldPlay = false;
	private generation = 0;
	private decodeFailed = false;

	constructor(private readonly logService: ILogService) {
		super();
	}

	load(track: ICodeScrimNarrationTrack | undefined): void {
		this.clear();
		this.track = track;
	}

	update(state: CodeScrimReplayState): void {
		this.desiredPosition = state.status === 'idle' ? 0 : state.position;
		this.shouldPlay = state.status === 'playing';
		const segment = this.findSegment(this.desiredPosition);
		if (segment !== this.activeSegment) {
			this.selectSegment(segment);
		}
		this.synchronize();
	}

	clear(): void {
		this.generation++;
		this.stopSource();
		this.track = undefined;
		this.activeSegment = undefined;
		this.decoded = undefined;
		this.shouldPlay = false;
		this.decodeFailed = false;
		if (this.context) {
			void this.context.close();
			this.context = undefined;
		}
	}

	private findSegment(position: number): ICodeScrimNarrationSegment | undefined {
		return this.track?.segments.find(segment => position >= segment.start && position < segment.start + segment.duration);
	}

	private selectSegment(segment: ICodeScrimNarrationSegment | undefined): void {
		const generation = ++this.generation;
		this.stopSource();
		this.activeSegment = segment;
		this.decoded = undefined;
		this.decodeFailed = false;
		if (!segment) {
			return;
		}

		const context = this.context ??= new mainWindow.AudioContext();
		const encoded = decodeBase64(segment.data);
		const bytes = new Uint8Array(encoded.byteLength);
		bytes.set(encoded.buffer);
		void context.decodeAudioData(bytes.buffer).then(decoded => {
			if (generation !== this.generation || segment !== this.activeSegment) {
				return;
			}
			this.decoded = decoded;
			this.synchronize();
		}, error => {
			if (generation !== this.generation) {
				return;
			}
			this.decodeFailed = true;
			this.logService.error(`[CodeScrim] Narration segment could not be decoded (${segment.mimeType}, ${encoded.byteLength} bytes).`, error);
		});
	}

	private synchronize(): void {
		const context = this.context;
		const segment = this.activeSegment;
		const decoded = this.decoded;
		if (!context || !segment || !decoded || this.decodeFailed) {
			return;
		}

		if (!this.shouldPlay) {
			this.stopSource();
			return;
		}

		const currentSourcePosition = this.source
			? this.sourcePosition + Math.round((context.currentTime - this.sourceContextTime) * 1_000_000)
			: undefined;
		if (currentSourcePosition !== undefined && Math.abs(currentSourcePosition - this.desiredPosition) <= MAXIMUM_AUDIO_DRIFT_MICROSECONDS) {
			return;
		}

		this.stopSource();
		const offsetSeconds = Math.max(0, (this.desiredPosition - segment.start) / 1_000_000);
		if (offsetSeconds >= decoded.duration) {
			return;
		}
		const source = context.createBufferSource();
		source.buffer = decoded;
		source.connect(context.destination);
		this.source = source;
		this.sourcePosition = this.desiredPosition;
		this.sourceContextTime = context.currentTime;
		source.onended = () => {
			if (this.source === source) {
				this.source = undefined;
			}
		};
		if (context.state === 'suspended') {
			void context.resume().catch(error => this.logService.warn('[CodeScrim] Narration audio context could not resume.', error));
		}
		source.start(0, offsetSeconds);
	}

	private stopSource(): void {
		const source = this.source;
		this.source = undefined;
		if (!source) {
			return;
		}
		source.onended = null;
		try {
			source.stop();
		} catch {
			// The browser may have already ended a short final segment.
		}
		source.disconnect();
	}

	override dispose(): void {
		this.clear();
		super.dispose();
	}
}
