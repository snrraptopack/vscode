/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CodeScrimRecordingEvent, ICodeScrimRecordingDraft, ICodeScrimWorkspaceEntryCheckpoint, ICodeScrimWorkspaceResource } from './codeScrimRecording.js';

export const CODE_SCRIM_REPLAY_LAST_RECORDING_COMMAND_ID = 'codescrim.replayLastRecording';
export const CODE_SCRIM_RESTART_REPLAY_COMMAND_ID = 'codescrim.restartReplay';
export const CODE_SCRIM_RESUME_REPLAY_COMMAND_ID = 'codescrim.resumeReplay';
export const CODE_SCRIM_STOP_REPLAY_COMMAND_ID = 'codescrim.stopReplay';

export type CodeScrimReplayState =
	| { readonly status: 'idle' }
	| {
		readonly status: 'preparing' | 'playing' | 'paused' | 'ended' | 'error';
		readonly draftId: string;
		readonly position: number;
		readonly duration: number;
		readonly appliedEventCount: number;
		readonly totalEventCount: number;
		readonly error?: string;
	};

export interface ICodeScrimReplaySurface {
	openResource(resource: ICodeScrimWorkspaceResource, model: ITextModel): void;
	closeResource(resource: ICodeScrimWorkspaceResource): void;
	clear(): void;
}

/** Host-neutral cursor that releases recorded events in timestamp and sequence order. */
export class CodeScrimReplayCursor {

	private events: readonly CodeScrimRecordingEvent[] = [];
	private nextIndex = 0;
	private position = 0;

	get appliedEventCount(): number {
		return this.nextIndex;
	}

	get totalEventCount(): number {
		return this.events.length;
	}

	get ended(): boolean {
		return this.nextIndex >= this.events.length;
	}

	reset(events: readonly CodeScrimRecordingEvent[]): void {
		this.events = events;
		this.nextIndex = 0;
		this.position = 0;
	}

	advance(position: number): readonly CodeScrimRecordingEvent[] {
		if (!Number.isFinite(position)) {
			return [];
		}

		this.position = Math.max(this.position, Math.max(0, Math.round(position)));
		const start = this.nextIndex;
		while (this.nextIndex < this.events.length && this.events[this.nextIndex].timestamp <= this.position) {
			this.nextIndex++;
		}
		return this.events.slice(start, this.nextIndex);
	}
}

export const ICodeScrimReplayService = createDecorator<ICodeScrimReplayService>('codeScrimReplayService');

export interface ICodeScrimReplayService {
	readonly _serviceBrand: undefined;
	readonly state: CodeScrimReplayState;
	readonly workspaceEntries: readonly ICodeScrimWorkspaceEntryCheckpoint[];
	readonly activeResource: ICodeScrimWorkspaceResource | undefined;
	readonly onDidChangeState: Event<CodeScrimReplayState>;
	readonly onDidChangeWorkspace: Event<void>;

	replay(draft: ICodeScrimRecordingDraft): Promise<boolean>;
	restart(): Promise<boolean>;
	seek(position: number): Promise<void>;
	pause(): Promise<void>;
	resume(): void;
	stop(): void;
	openResource(resource: ICodeScrimWorkspaceResource): Promise<void>;
	attachSurface(surface: ICodeScrimReplaySurface): IDisposable;
}
