/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CodeScrimRecordingBuffer, CodeScrimRecordingEvent, ICodeScrimRecordingDraft, ICodeScrimSelection, ICodeScrimWorkspaceEntryCheckpoint, ICodeScrimWorkspaceResource } from './codeScrimRecording.js';

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
	applySelections(resource: ICodeScrimWorkspaceResource, selections: readonly ICodeScrimSelection[]): void;
	closeResource(resource: ICodeScrimWorkspaceResource): void;
	clear(): void;
}

export interface ICodeScrimLearnerConflict {
	readonly resource: ICodeScrimWorkspaceResource;
	readonly learnerText: string;
	readonly instructorText: string;
}

export interface ICodeScrimLearnerState {
	readonly changedResources: readonly ICodeScrimWorkspaceResource[];
	readonly keptResources: readonly ICodeScrimWorkspaceResource[];
	readonly conflict: ICodeScrimLearnerConflict | undefined;
}

export interface ICodeScrimLearnerExperimentChange {
	readonly resource: ICodeScrimWorkspaceResource;
	readonly learnerText: string;
	readonly instructorText: string;
}

export interface ICodeScrimLearnerExperiment {
	readonly id: string;
	readonly position: number;
	readonly changes: readonly ICodeScrimLearnerExperimentChange[];
}

interface ICodeScrimLearnerOverlay {
	readonly resource: ICodeScrimWorkspaceResource;
	readonly text: string;
	readonly kept: boolean;
}

/** Host-neutral learner branch layered over the instructor's immutable timeline. */
export class CodeScrimLearnerOverlayStore {

	private readonly overlays = new Map<string, ICodeScrimLearnerOverlay>();
	private _conflict: ICodeScrimLearnerConflict | undefined;

	get state(): ICodeScrimLearnerState {
		const overlays = [...this.overlays.values()];
		return Object.freeze({
			changedResources: Object.freeze(overlays.map(overlay => overlay.resource)),
			keptResources: Object.freeze(overlays.filter(overlay => overlay.kept).map(overlay => overlay.resource)),
			conflict: this._conflict,
		});
	}

	clear(): void {
		this.overlays.clear();
		this._conflict = undefined;
	}

	getText(resource: ICodeScrimWorkspaceResource): string | undefined {
		return this.overlays.get(CodeScrimRecordingBuffer.resourceKey(resource))?.text;
	}

	hasChanges(resource: ICodeScrimWorkspaceResource): boolean {
		return this.overlays.has(CodeScrimRecordingBuffer.resourceKey(resource));
	}

	isKept(resource: ICodeScrimWorkspaceResource): boolean {
		return this.overlays.get(CodeScrimRecordingBuffer.resourceKey(resource))?.kept ?? false;
	}

	record(resource: ICodeScrimWorkspaceResource, learnerText: string, instructorText: string): void {
		const key = CodeScrimRecordingBuffer.resourceKey(resource);
		if (learnerText === instructorText) {
			this.overlays.delete(key);
			if (this._conflict && CodeScrimRecordingBuffer.resourceKey(this._conflict.resource) === key) {
				this._conflict = undefined;
			}
			return;
		}

		const previous = this.overlays.get(key);
		this.overlays.set(key, Object.freeze({ resource, text: learnerText, kept: previous?.kept ?? false }));
	}

	advanceInstructor(resource: ICodeScrimWorkspaceResource, instructorText: string, allowConflict: boolean): 'apply' | 'keep' | 'conflict' {
		const key = CodeScrimRecordingBuffer.resourceKey(resource);
		const overlay = this.overlays.get(key);
		if (!overlay) {
			return 'apply';
		}
		// A seek reconstructs the instructor timeline event-by-event. Keep the learner
		// branch intact until the final target state can be compared as a whole.
		if (!allowConflict) {
			return 'keep';
		}
		if (overlay.text === instructorText) {
			this.overlays.delete(key);
			this._conflict = undefined;
			return 'apply';
		}
		if (overlay.kept) {
			return 'keep';
		}

		this._conflict = Object.freeze({ resource, learnerText: overlay.text, instructorText });
		return 'conflict';
	}

	keep(resource: ICodeScrimWorkspaceResource): boolean {
		const key = CodeScrimRecordingBuffer.resourceKey(resource);
		const overlay = this.overlays.get(key);
		if (!overlay) {
			return false;
		}
		this.overlays.set(key, Object.freeze({ ...overlay, kept: true }));
		if (this._conflict && CodeScrimRecordingBuffer.resourceKey(this._conflict.resource) === key) {
			this._conflict = undefined;
		}
		return true;
	}

	restore(resource: ICodeScrimWorkspaceResource): boolean {
		const key = CodeScrimRecordingBuffer.resourceKey(resource);
		const restored = this.overlays.delete(key);
		if (this._conflict && CodeScrimRecordingBuffer.resourceKey(this._conflict.resource) === key) {
			this._conflict = undefined;
		}
		return restored;
	}
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

	advanceOne(position: number): CodeScrimRecordingEvent | undefined {
		if (!Number.isFinite(position)) {
			return undefined;
		}

		this.position = Math.max(this.position, Math.max(0, Math.round(position)));
		const event = this.events[this.nextIndex];
		if (!event || event.timestamp > this.position) {
			return undefined;
		}
		this.nextIndex++;
		return event;
	}
}

export const ICodeScrimReplayService = createDecorator<ICodeScrimReplayService>('codeScrimReplayService');

export interface ICodeScrimReplayService {
	readonly _serviceBrand: undefined;
	readonly state: CodeScrimReplayState;
	readonly workspaceEntries: readonly ICodeScrimWorkspaceEntryCheckpoint[];
	readonly activeResource: ICodeScrimWorkspaceResource | undefined;
	readonly learnerState: ICodeScrimLearnerState;
	readonly learnerExperiments: readonly ICodeScrimLearnerExperiment[];
	readonly activeLearnerExperimentId: string | undefined;
	readonly onDidChangeState: Event<CodeScrimReplayState>;
	readonly onDidChangeWorkspace: Event<void>;
	readonly onDidChangeLearnerState: Event<ICodeScrimLearnerState>;
	readonly onDidChangeLearnerExperiments: Event<readonly ICodeScrimLearnerExperiment[]>;

	replay(draft: ICodeScrimRecordingDraft): Promise<boolean>;
	restart(): Promise<boolean>;
	seek(position: number): Promise<void>;
	pause(): Promise<void>;
	beginLearnerEdit(): void;
	resume(): void;
	stop(): void;
	openResource(resource: ICodeScrimWorkspaceResource): Promise<void>;
	openLearnerExperiment(id: string): Promise<void>;
	getLearnerModel(resource: ICodeScrimWorkspaceResource): ITextModel | null;
	getInstructorModel(resource: ICodeScrimWorkspaceResource): ITextModel | null;
	hasLearnerChanges(resource: ICodeScrimWorkspaceResource): boolean;
	isLearnerVersionKept(resource: ICodeScrimWorkspaceResource): boolean;
	keepLearnerVersion(resource: ICodeScrimWorkspaceResource): boolean;
	restoreInstructorVersion(resource: ICodeScrimWorkspaceResource): boolean;
	attachSurface(surface: ICodeScrimReplaySurface): IDisposable;
}
