/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CodeScrimTerminalEventData, CodeScrimTerminalState, ICodeScrimTerminalCheckpoint } from './codeScrimTerminal.js';

export const CODE_SCRIM_START_RECORDING_COMMAND_ID = 'codescrim.startRecording';
export const CODE_SCRIM_STOP_RECORDING_COMMAND_ID = 'codescrim.stopRecording';
export const CODE_SCRIM_PAUSE_RECORDING_COMMAND_ID = 'codescrim.pauseRecording';
export const CODE_SCRIM_RESUME_RECORDING_COMMAND_ID = 'codescrim.resumeRecording';
export const CODE_SCRIM_DISCARD_RECORDING_COMMAND_ID = 'codescrim.discardRecording';

export interface ICodeScrimWorkspaceResource {
	readonly root: number;
	readonly path: string;
}

export interface ICodeScrimTextChange {
	readonly rangeOffset: number;
	readonly rangeLength: number;
	readonly text: string;
}

export interface ICodeScrimSelection {
	readonly selectionStartLineNumber: number;
	readonly selectionStartColumn: number;
	readonly positionLineNumber: number;
	readonly positionColumn: number;
}

export interface ICodeScrimDocumentCheckpoint {
	readonly resource: ICodeScrimWorkspaceResource;
	readonly languageId: string;
	readonly versionId: number;
	readonly eol: string;
	readonly text: string;
}

export interface ICodeScrimWorkspaceEntryCheckpoint {
	readonly resource: ICodeScrimWorkspaceResource;
	readonly type: 'file' | 'directory';
	readonly size?: number;
	readonly contents?: string;
	readonly text: boolean;
}

export interface ICodeScrimRecordingCheckpoint {
	readonly timestamp: number;
	/** Index of the first event not represented by this checkpoint. */
	readonly eventIndex: number;
	readonly activeResource?: ICodeScrimWorkspaceResource;
	readonly selections?: readonly ICodeScrimSelection[];
	readonly documents: readonly ICodeScrimDocumentCheckpoint[];
	readonly entries: readonly ICodeScrimWorkspaceEntryCheckpoint[];
	readonly skippedEntryCount: number;
	readonly terminals: readonly ICodeScrimTerminalCheckpoint[];
	readonly activeTerminalId?: number;
}

interface ICodeScrimEvent<TDomain extends 'workspace' | 'editor' | 'terminal', TKind extends string, TPayload> {
	readonly id: string;
	readonly version: 1;
	readonly timestamp: number;
	readonly sequence: number;
	readonly domain: TDomain;
	readonly kind: TKind;
	readonly payload: TPayload;
}

export type CodeScrimEditorEvent =
	| ICodeScrimEvent<'editor', 'editor.activeResourceChanged', { readonly resource?: ICodeScrimWorkspaceResource }>
	| ICodeScrimEvent<'editor', 'editor.documentChanged', {
		readonly resource: ICodeScrimWorkspaceResource;
		readonly languageId: string;
		readonly versionId: number;
		readonly eol: string;
		/** Full post-edit text anchor. Optional only for replaying drafts recorded before it was introduced. */
		readonly text?: string;
		readonly changes: readonly ICodeScrimTextChange[];
		readonly undoing: boolean;
		readonly redoing: boolean;
	}>
	| ICodeScrimEvent<'editor', 'editor.selectionChanged', {
		readonly resource: ICodeScrimWorkspaceResource;
		readonly modelVersionId: number;
		readonly selections: readonly ICodeScrimSelection[];
	}>
	| ICodeScrimEvent<'editor', 'editor.documentSaved', {
		readonly resource: ICodeScrimWorkspaceResource;
		readonly reason?: number;
	}>;

export type CodeScrimWorkspaceEvent = ICodeScrimEvent<'workspace', 'workspace.entriesChanged', {
	readonly deleted: readonly ICodeScrimWorkspaceResource[];
	readonly created: readonly ICodeScrimWorkspaceEntryCheckpoint[];
}>;

export type CodeScrimTerminalEvent = CodeScrimTerminalEventData extends infer TEvent
	? TEvent extends { readonly kind: infer TKind extends string; readonly payload: infer TPayload }
		? ICodeScrimEvent<'terminal', TKind, TPayload>
		: never
	: never;

export type CodeScrimRecordingEvent = CodeScrimEditorEvent | CodeScrimWorkspaceEvent | CodeScrimTerminalEvent;

export type CodeScrimRecordingEventData = CodeScrimRecordingEvent extends infer TEvent
	? TEvent extends CodeScrimRecordingEvent ? Pick<TEvent, 'domain' | 'kind' | 'payload'> : never
	: never;

export interface ICodeScrimRecordingDraft {
	readonly id: string;
	readonly duration: number;
	readonly checkpoints: readonly ICodeScrimRecordingCheckpoint[];
	readonly events: readonly CodeScrimRecordingEvent[];
}

export type CodeScrimRecordingState =
	| { readonly status: 'idle' }
	| { readonly status: 'preparing' }
	| { readonly status: 'recording' | 'paused'; readonly draftId: string; readonly eventCount: number; readonly checkpointEntryCount: number; readonly skippedEntryCount: number };

/**
 * Host-neutral append-only event buffer. The caller supplies monotonic milliseconds; the buffer
 * converts them to integer microseconds and assigns a sequence number for stable ordering.
 */
export class CodeScrimRecordingBuffer {
	private static readonly CHECKPOINT_INTERVAL = 30_000_000;
	private static readonly CHECKPOINT_EVENT_INTERVAL = 1_000;

	private draftId: string | undefined;
	private startedAt = 0;
	private pausedAt: number | undefined;
	private pausedDuration = 0;
	private sequence = 0;
	private readonly events: CodeScrimRecordingEvent[] = [];
	private readonly documents = new Map<string, ICodeScrimDocumentCheckpoint>();
	private readonly entries = new Map<string, ICodeScrimWorkspaceEntryCheckpoint>();
	private readonly checkpoints: ICodeScrimRecordingCheckpoint[] = [];
	private activeResource: ICodeScrimWorkspaceResource | undefined;
	private selections: readonly ICodeScrimSelection[] | undefined;
	private readonly terminalState = new CodeScrimTerminalState();
	private skippedEntries = 0;

	get isRecording(): boolean {
		return this.draftId !== undefined;
	}

	get eventCount(): number {
		return this.events.length;
	}

	get checkpointEntryCount(): number {
		return this.entries.size;
	}

	get skippedEntryCount(): number {
		return this.skippedEntries;
	}

	get activeDraftId(): string | undefined {
		return this.draftId;
	}

	get isPaused(): boolean {
		return this.pausedAt !== undefined;
	}

	start(draftId: string, now: number): void {
		if (this.isRecording) {
			throw new Error('A CodeScrim recording is already active.');
		}
		if (!draftId) {
			throw new Error('A CodeScrim recording requires a draft ID.');
		}

		this.draftId = draftId;
		this.startedAt = now;
		this.pausedAt = undefined;
		this.pausedDuration = 0;
		this.sequence = 0;
		this.events.length = 0;
		this.documents.clear();
		this.entries.clear();
		this.checkpoints.length = 0;
		this.activeResource = undefined;
		this.selections = undefined;
		this.terminalState.reset();
		this.skippedEntries = 0;
	}

	pause(now: number): boolean {
		if (!this.draftId || this.pausedAt !== undefined) {
			return false;
		}
		this.pausedAt = now;
		return true;
	}

	resume(now: number): boolean {
		if (!this.draftId || this.pausedAt === undefined) {
			return false;
		}
		this.pausedDuration += Math.max(0, now - this.pausedAt);
		this.pausedAt = undefined;
		return true;
	}

	captureDocument(document: ICodeScrimDocumentCheckpoint): void {
		if (!this.draftId) {
			throw new Error('A CodeScrim recording is not active.');
		}

		const key = CodeScrimRecordingBuffer.resourceKey(document.resource);
		if (!this.checkpoints.length && this.documents.has(key)) {
			return;
		}
		this.documents.set(key, Object.freeze({
			...document,
			resource: Object.freeze({ ...document.resource }),
		}));
	}

	captureWorkspaceEntry(entry: ICodeScrimWorkspaceEntryCheckpoint): void {
		if (!this.draftId) {
			throw new Error('A CodeScrim recording is not active.');
		}

		const key = CodeScrimRecordingBuffer.resourceKey(entry.resource);
		if (!this.entries.has(key)) {
			this.entries.set(key, CodeScrimRecordingBuffer.freezeEntry(entry));
		}
	}

	recordSkippedWorkspaceEntry(): void {
		if (!this.draftId) {
			throw new Error('A CodeScrim recording is not active.');
		}
		this.skippedEntries++;
	}

	append(event: CodeScrimRecordingEventData, now: number): CodeScrimRecordingEvent {
		if (!this.draftId) {
			throw new Error('A CodeScrim recording is not active.');
		}

		this.ensureInitialCheckpoint();
		const sequence = this.sequence++;
		const normalizedEvent = event.kind === 'workspace.entriesChanged'
			? {
				...event,
				payload: Object.freeze({
					deleted: Object.freeze(event.payload.deleted.map(resource => Object.freeze({ ...resource }))),
					created: Object.freeze(event.payload.created.map(entry => CodeScrimRecordingBuffer.freezeEntry(entry))),
				}),
			}
			: event;
		const timestamp = Math.max(this.events[this.events.length - 1]?.timestamp ?? 0, this.toMicroseconds(now));
		const recordedEvent = Object.freeze({
			...normalizedEvent,
			id: `${this.draftId}:${sequence}`,
			version: 1 as const,
			timestamp,
			sequence,
		}) as CodeScrimRecordingEvent;
		this.events.push(recordedEvent);
		this.applyToCheckpointState(recordedEvent);
		this.captureAutomaticCheckpoint(recordedEvent.timestamp);
		return recordedEvent;
	}

	captureCheckpoint(now: number): void {
		if (!this.draftId) {
			return;
		}
		this.ensureInitialCheckpoint();
		this.captureCheckpointAt(this.toMicroseconds(now));
	}

	stop(now: number): ICodeScrimRecordingDraft | undefined {
		if (!this.draftId) {
			return undefined;
		}

		this.ensureInitialCheckpoint();
		this.captureCheckpointAt(this.toMicroseconds(now));
		const draft = Object.freeze({
			id: this.draftId,
			duration: this.toMicroseconds(now),
			checkpoints: Object.freeze([...this.checkpoints]),
			events: Object.freeze([...this.events]),
		});
		this.draftId = undefined;
		this.startedAt = 0;
		this.pausedAt = undefined;
		this.pausedDuration = 0;
		this.sequence = 0;
		this.events.length = 0;
		this.documents.clear();
		this.entries.clear();
		this.checkpoints.length = 0;
		this.activeResource = undefined;
		this.selections = undefined;
		this.terminalState.reset();
		this.skippedEntries = 0;
		return draft;
	}

	private ensureInitialCheckpoint(): void {
		if (!this.checkpoints.length) {
			this.captureCheckpointAt(0);
		}
	}

	private captureAutomaticCheckpoint(timestamp: number): void {
		const previous = this.checkpoints[this.checkpoints.length - 1];
		if (timestamp - previous.timestamp >= CodeScrimRecordingBuffer.CHECKPOINT_INTERVAL ||
			this.events.length - previous.eventIndex >= CodeScrimRecordingBuffer.CHECKPOINT_EVENT_INTERVAL) {
			this.captureCheckpointAt(timestamp);
		}
	}

	private captureCheckpointAt(timestamp: number): void {
		const previous = this.checkpoints[this.checkpoints.length - 1];
		if (previous?.eventIndex === this.events.length) {
			return;
		}
		this.checkpoints.push(Object.freeze({
			timestamp,
			eventIndex: this.events.length,
			...(this.activeResource ? { activeResource: Object.freeze({ ...this.activeResource }) } : {}),
			...(this.selections ? { selections: Object.freeze(this.selections.map(selection => Object.freeze({ ...selection }))) } : {}),
			documents: Object.freeze([...this.documents.values()]),
			entries: Object.freeze([...this.entries.values()]),
			skippedEntryCount: this.skippedEntries,
			...this.terminalState.snapshot,
		}));
	}

	private applyToCheckpointState(event: CodeScrimRecordingEvent): void {
		switch (event.kind) {
			case 'workspace.entriesChanged':
				for (const resource of event.payload.deleted) {
					const prefix = `${resource.path}/`;
					for (const [key, entry] of this.entries) {
						if (entry.resource.root === resource.root && (entry.resource.path === resource.path || entry.resource.path.startsWith(prefix))) {
							this.entries.delete(key);
							this.documents.delete(key);
						}
					}
				}
				for (const entry of event.payload.created) {
					this.entries.set(CodeScrimRecordingBuffer.resourceKey(entry.resource), CodeScrimRecordingBuffer.freezeEntry(entry));
				}
				break;
			case 'editor.activeResourceChanged':
				this.activeResource = event.payload.resource ? Object.freeze({ ...event.payload.resource }) : undefined;
				this.selections = undefined;
				break;
			case 'editor.documentChanged': {
				const key = CodeScrimRecordingBuffer.resourceKey(event.payload.resource);
				if (event.payload.text !== undefined) {
					this.documents.set(key, Object.freeze({
						resource: Object.freeze({ ...event.payload.resource }),
						languageId: event.payload.languageId,
						versionId: event.payload.versionId,
						eol: event.payload.eol,
						text: event.payload.text,
					}));
				}
				break;
			}
			case 'editor.selectionChanged':
				this.activeResource = Object.freeze({ ...event.payload.resource });
				this.selections = Object.freeze(event.payload.selections.map(selection => Object.freeze({ ...selection })));
				break;
			case 'editor.documentSaved':
				break;
			default:
				this.terminalState.apply(event);
				break;
		}
	}

	static resourceKey(resource: ICodeScrimWorkspaceResource): string {
		return `${resource.root}:${resource.path}`;
	}

	static freezeEntry(entry: ICodeScrimWorkspaceEntryCheckpoint): ICodeScrimWorkspaceEntryCheckpoint {
		return Object.freeze({ ...entry, resource: Object.freeze({ ...entry.resource }) });
	}

	private toMicroseconds(now: number): number {
		const effectiveNow = this.pausedAt ?? now;
		return Math.round(Math.max(0, effectiveNow - this.startedAt - this.pausedDuration) * 1000);
	}
}

export const ICodeScrimRecorderService = createDecorator<ICodeScrimRecorderService>('codeScrimRecorderService');

export interface ICodeScrimRecorderService {
	readonly _serviceBrand: undefined;
	readonly state: CodeScrimRecordingState;
	readonly lastDraft: ICodeScrimRecordingDraft | undefined;
	readonly onDidChangeState: Event<CodeScrimRecordingState>;
	readonly onDidChangeDraft: Event<ICodeScrimRecordingDraft | undefined>;

	initialize(): Promise<void>;
	startRecording(): Promise<boolean>;
	pauseRecording(): Promise<boolean>;
	resumeRecording(): boolean;
	stopRecording(): Promise<ICodeScrimRecordingDraft | undefined>;
	setLastDraft(draft: ICodeScrimRecordingDraft): void;
	discardLastDraft(): Promise<boolean>;
}
