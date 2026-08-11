/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const CODE_SCRIM_START_RECORDING_COMMAND_ID = 'codescrim.startRecording';
export const CODE_SCRIM_STOP_RECORDING_COMMAND_ID = 'codescrim.stopRecording';

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
	readonly documents: readonly ICodeScrimDocumentCheckpoint[];
	readonly entries: readonly ICodeScrimWorkspaceEntryCheckpoint[];
	readonly skippedEntryCount: number;
}

interface ICodeScrimEvent<TDomain extends 'workspace' | 'editor', TKind extends string, TPayload> {
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

export type CodeScrimRecordingEvent = CodeScrimEditorEvent | CodeScrimWorkspaceEvent;

export type CodeScrimRecordingEventData = CodeScrimRecordingEvent extends infer TEvent
	? TEvent extends CodeScrimRecordingEvent ? Pick<TEvent, 'domain' | 'kind' | 'payload'> : never
	: never;

export interface ICodeScrimRecordingDraft {
	readonly id: string;
	readonly duration: number;
	readonly checkpoint: ICodeScrimRecordingCheckpoint;
	readonly events: readonly CodeScrimRecordingEvent[];
}

export type CodeScrimRecordingState =
	| { readonly status: 'idle' }
	| { readonly status: 'preparing' }
	| { readonly status: 'recording'; readonly draftId: string; readonly eventCount: number; readonly checkpointEntryCount: number; readonly skippedEntryCount: number };

/**
 * Host-neutral append-only event buffer. The caller supplies monotonic milliseconds; the buffer
 * converts them to integer microseconds and assigns a sequence number for stable ordering.
 */
export class CodeScrimRecordingBuffer {

	private draftId: string | undefined;
	private startedAt = 0;
	private sequence = 0;
	private readonly events: CodeScrimRecordingEvent[] = [];
	private readonly documents = new Map<string, ICodeScrimDocumentCheckpoint>();
	private readonly entries = new Map<string, ICodeScrimWorkspaceEntryCheckpoint>();
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

	start(draftId: string, now: number): void {
		if (this.isRecording) {
			throw new Error('A CodeScrim recording is already active.');
		}
		if (!draftId) {
			throw new Error('A CodeScrim recording requires a draft ID.');
		}

		this.draftId = draftId;
		this.startedAt = now;
		this.sequence = 0;
		this.events.length = 0;
		this.documents.clear();
		this.entries.clear();
		this.skippedEntries = 0;
	}

	captureDocument(document: ICodeScrimDocumentCheckpoint): void {
		if (!this.draftId) {
			throw new Error('A CodeScrim recording is not active.');
		}

		const key = CodeScrimRecordingBuffer.resourceKey(document.resource);
		if (!this.documents.has(key)) {
			this.documents.set(key, Object.freeze({
				...document,
				resource: Object.freeze({ ...document.resource }),
			}));
		}
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
		const recordedEvent = Object.freeze({
			...normalizedEvent,
			id: `${this.draftId}:${sequence}`,
			version: 1 as const,
			timestamp: this.toMicroseconds(now),
			sequence,
		}) as CodeScrimRecordingEvent;
		this.events.push(recordedEvent);
		return recordedEvent;
	}

	stop(now: number): ICodeScrimRecordingDraft | undefined {
		if (!this.draftId) {
			return undefined;
		}

		const draft = Object.freeze({
			id: this.draftId,
			duration: this.toMicroseconds(now),
			checkpoint: Object.freeze({
				documents: Object.freeze([...this.documents.values()]),
				entries: Object.freeze([...this.entries.values()]),
				skippedEntryCount: this.skippedEntries,
			}),
			events: Object.freeze([...this.events]),
		});
		this.draftId = undefined;
		this.startedAt = 0;
		this.sequence = 0;
		this.events.length = 0;
		this.documents.clear();
		this.entries.clear();
		this.skippedEntries = 0;
		return draft;
	}

	static resourceKey(resource: ICodeScrimWorkspaceResource): string {
		return `${resource.root}:${resource.path}`;
	}

	static freezeEntry(entry: ICodeScrimWorkspaceEntryCheckpoint): ICodeScrimWorkspaceEntryCheckpoint {
		return Object.freeze({ ...entry, resource: Object.freeze({ ...entry.resource }) });
	}

	private toMicroseconds(now: number): number {
		return Math.round(Math.max(0, now - this.startedAt) * 1000);
	}
}

export const ICodeScrimRecorderService = createDecorator<ICodeScrimRecorderService>('codeScrimRecorderService');

export interface ICodeScrimRecorderService {
	readonly _serviceBrand: undefined;
	readonly state: CodeScrimRecordingState;
	readonly lastDraft: ICodeScrimRecordingDraft | undefined;
	readonly onDidChangeState: Event<CodeScrimRecordingState>;

	startRecording(): Promise<boolean>;
	stopRecording(): Promise<ICodeScrimRecordingDraft | undefined>;
}
