/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Sequencer } from '../../../../base/common/async.js';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { getErrorMessage, onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { EndOfLineSequence, ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { CodeScrimRecordingBuffer, CodeScrimRecordingEvent, ICodeScrimDocumentCheckpoint, ICodeScrimRecordingDraft, ICodeScrimWorkspaceEntryCheckpoint, ICodeScrimWorkspaceResource } from '../common/codeScrimRecording.js';
import { CodeScrimReplayCursor, CodeScrimReplayState, CODE_SCRIM_RESTART_REPLAY_COMMAND_ID, CODE_SCRIM_RESUME_REPLAY_COMMAND_ID, CODE_SCRIM_STOP_REPLAY_COMMAND_ID, ICodeScrimReplayService, ICodeScrimReplaySurface } from '../common/codeScrimReplay.js';

const CODE_SCRIM_REPLAY_SCHEME = 'codescrim-replay';
const REPLAY_TICK_INTERVAL = 16;

export class CodeScrimReplayService extends Disposable implements ICodeScrimReplayService {

	declare readonly _serviceBrand: undefined;

	private readonly cursor = new CodeScrimReplayCursor();
	private readonly operations = new Sequencer();
	private readonly models = this._register(new DisposableMap<string, ITextModel>());
	private readonly timer = this._register(new MutableDisposable());
	private readonly replayStatus = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly documentsByResource = new Map<string, ICodeScrimDocumentCheckpoint>();
	private readonly entriesByResource = new Map<string, ICodeScrimWorkspaceEntryCheckpoint>();
	private readonly urisByResource = new Map<string, URI>();
	private _state: CodeScrimReplayState = Object.freeze({ status: 'idle' });
	private activeDraft: ICodeScrimRecordingDraft | undefined;
	private replayWorkspaceVersion = 0;
	private startedAt = 0;
	private ticking = false;
	private timerTickQueued = false;
	private operationVersion = 0;
	private surface: ICodeScrimReplaySurface | undefined;
	private _activeResource: ICodeScrimWorkspaceResource | undefined;
	private replayActiveResource: ICodeScrimWorkspaceResource | undefined;
	private pendingActiveResource: ICodeScrimWorkspaceResource | undefined;
	private readonly _onDidChangeState = this._register(new Emitter<CodeScrimReplayState>());
	readonly onDidChangeState = this._onDidChangeState.event;
	private readonly _onDidChangeWorkspace = this._register(new Emitter<void>());
	readonly onDidChangeWorkspace = this._onDidChangeWorkspace.event;

	get state(): CodeScrimReplayState {
		return this._state;
	}

	get workspaceEntries(): readonly ICodeScrimWorkspaceEntryCheckpoint[] {
		return [...this.entriesByResource.values()].sort((left, right) => left.resource.root - right.resource.root || left.resource.path.localeCompare(right.resource.path));
	}

	get activeResource(): ICodeScrimWorkspaceResource | undefined {
		return this._activeResource;
	}

	constructor(
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IEditorService private readonly editorService: IEditorService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IModelService private readonly modelService: IModelService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
	) {
		super();
	}

	async replay(draft: ICodeScrimRecordingDraft): Promise<boolean> {
		const operation = ++this.operationVersion;
		this.timer.clear();
		return this.operations.queue(() => this.doReplay(draft, operation));
	}

	async restart(): Promise<boolean> {
		const operation = ++this.operationVersion;
		this.timer.clear();
		return this.operations.queue(() => this.doRestart(operation));
	}

	async seek(position: number): Promise<void> {
		const operation = ++this.operationVersion;
		this.timer.clear();
		await this.operations.queue(() => this.doSeek(position, operation));
	}

	async pause(): Promise<void> {
		const operation = ++this.operationVersion;
		this.timer.clear();
		await this.operations.queue(() => this.doPause(operation));
	}

	resume(): void {
		const operation = ++this.operationVersion;
		this.timer.clear();
		void this.operations.queue(() => this.doResume(operation));
	}

	stop(): void {
		this.operationVersion++;
		this.timer.clear();
		this.ticking = false;
		this.publishIdle();
	}

	async openResource(resource: ICodeScrimWorkspaceResource): Promise<void> {
		const operation = ++this.operationVersion;
		const pauseForInspection = this._state.status === 'playing';
		if (pauseForInspection) {
			this.timer.clear();
		}
		await this.operations.queue(async () => {
			if (!this.isCurrentOperation(operation)) {
				return;
			}
			if (pauseForInspection) {
				await this.doPause(operation);
			}
			await this.showResource(resource, operation);
		});
	}

	attachSurface(surface: ICodeScrimReplaySurface): IDisposable {
		this.surface = surface;
		const activeResource = this._activeResource;
		const activeModel = activeResource && this.getModel(activeResource);
		if (activeResource && activeModel) {
			surface.openResource(activeResource, activeModel);
		}
		return toDisposable(() => {
			if (this.surface === surface) {
				this.surface = undefined;
			}
		});
	}

	private async doReplay(draft: ICodeScrimRecordingDraft, operation: number): Promise<boolean> {
		if (!this.isCurrentOperation(operation)) {
			return false;
		}

		try {
			await this.closeReplayEditors();
			if (!this.isCurrentOperation(operation)) {
				return false;
			}
			this.surface?.clear();
			this.models.clearAndDisposeAll();
			this.activeDraft = draft;
			this.publish('preparing', 0);
			this.prepareWorkspace(draft);
			await this.startPreparedReplay(draft, operation);
			return this.isCurrentOperation(operation);
		} catch (error) {
			if (this.isCurrentOperation(operation)) {
				this.handleReplayError(error);
			}
			return false;
		}
	}

	private async doRestart(operation: number): Promise<boolean> {
		const draft = this.activeDraft;
		if (!draft || !this.isCurrentOperation(operation)) {
			return false;
		}

		this.publish('preparing', 0);
		try {
			await this.closeReplayEditors();
			if (!this.isCurrentOperation(operation)) {
				return false;
			}
			this.surface?.clear();
			this.models.clearAndDisposeAll();
			this.prepareWorkspace(draft);
			await this.startPreparedReplay(draft, operation);
			return this.isCurrentOperation(operation);
		} catch (error) {
			if (this.isCurrentOperation(operation)) {
				this.handleReplayError(error);
			}
			return false;
		}
	}

	private async doSeek(position: number, operation: number): Promise<void> {
		const draft = this.activeDraft;
		if (!draft || this._state.status === 'idle' || !this.isCurrentOperation(operation)) {
			return;
		}

		const target = Math.min(draft.duration, Math.max(0, Math.round(position)));
		const resumeAfterSeek = this._state.status === 'playing';
		this.publish('preparing', target);
		try {
			await this.closeReplayEditors();
			if (!this.isCurrentOperation(operation)) {
				return;
			}
			this.surface?.clear();
			this.models.clearAndDisposeAll();
			this.prepareWorkspace(draft);
			this.cursor.reset(draft.events);
			const initialResource = this.getInitialResource(draft);
			if (initialResource) {
				await this.activateReplayResource(initialResource, operation);
			}
			for (const event of this.cursor.advance(target)) {
				if (!this.isCurrentOperation(operation)) {
					return;
				}
				await this.applyEvent(event, operation);
			}
			if (!this.isCurrentOperation(operation)) {
				return;
			}
			this.startedAt = this.now() - target / 1000;
			this.publish(target >= draft.duration ? 'ended' : resumeAfterSeek ? 'playing' : 'paused', target);
			if (resumeAfterSeek && target < draft.duration) {
				this.startTimer(operation);
			}
		} catch (error) {
			if (this.isCurrentOperation(operation)) {
				this.handleReplayError(error);
			}
		}
	}

	private async doPause(operation: number): Promise<void> {
		if (this._state.status !== 'playing' || !this.isCurrentOperation(operation)) {
			return;
		}

		await this.tick(operation);
		if (this._state.status === 'playing' && this.isCurrentOperation(operation)) {
			this.timer.clear();
			this.publish('paused', this._state.position);
		}
	}

	private async doResume(operation: number): Promise<void> {
		if (this._state.status !== 'paused' || !this.isCurrentOperation(operation)) {
			return;
		}

		if (this.replayActiveResource) {
			await this.showResource(this.replayActiveResource, operation);
		}
		if (!this.isCurrentOperation(operation) || this._state.status !== 'paused') {
			return;
		}
		this.startedAt = this.now() - this._state.position / 1000;
		this.publish('playing', this._state.position);
		this.startTimer(operation);
	}

	private prepareWorkspace(draft: ICodeScrimRecordingDraft): void {
		this.documentsByResource.clear();
		this.entriesByResource.clear();
		this.urisByResource.clear();
		this.replayWorkspaceVersion++;
		this._activeResource = undefined;
		this.replayActiveResource = undefined;
		this.pendingActiveResource = undefined;
		this.surface?.clear();

		for (const entry of draft.checkpoint.entries) {
			const key = CodeScrimRecordingBuffer.resourceKey(entry.resource);
			this.entriesByResource.set(key, entry);
			if (entry.type === 'file' && entry.text) {
				this.registerResource(draft.id, entry.resource);
			}
		}
		for (const document of draft.checkpoint.documents) {
			this.documentsByResource.set(CodeScrimRecordingBuffer.resourceKey(document.resource), document);
			this.registerResource(draft.id, document.resource);
		}
		this._onDidChangeWorkspace.fire();
	}

	private async startPreparedReplay(draft: ICodeScrimRecordingDraft, operation: number): Promise<void> {
		this.cursor.reset(draft.events);
		const initialResource = this.getInitialResource(draft);
		if (initialResource) {
			await this.activateReplayResource(initialResource, operation);
		}
		if (!this.isCurrentOperation(operation)) {
			return;
		}

		this.startedAt = this.now();
		this.publish('playing', 0);
		await this.tick(operation);
		if (this._state.status !== 'playing' || !this.isCurrentOperation(operation)) {
			return;
		}

		this.startTimer(operation);
	}

	private getInitialResource(draft: ICodeScrimRecordingDraft): ICodeScrimWorkspaceResource | undefined {
		return draft.events.find(event => event.kind === 'editor.activeResourceChanged' && event.payload.resource)?.payload.resource
			?? draft.checkpoint.documents[0]?.resource
			?? draft.checkpoint.entries.find(entry => entry.type === 'file' && entry.text)?.resource;
	}

	private startTimer(operation: number): void {
		if (!this.isCurrentOperation(operation)) {
			return;
		}
		const handle = mainWindow.setInterval(() => {
			if (this.timerTickQueued || !this.isCurrentOperation(operation)) {
				return;
			}
			this.timerTickQueued = true;
			void this.operations.queue(() => this.tick(operation)).catch(error => {
				if (this.isCurrentOperation(operation)) {
					this.handleReplayError(error);
				}
			}).finally(() => this.timerTickQueued = false);
		}, REPLAY_TICK_INTERVAL);
		this.timer.value = toDisposable(() => mainWindow.clearInterval(handle));
	}

	private async tick(operation: number): Promise<void> {
		if (this.ticking || this._state.status !== 'playing' || !this.activeDraft || !this.isCurrentOperation(operation)) {
			return;
		}

		this.ticking = true;
		try {
			const position = Math.min(this.activeDraft.duration, Math.round((this.now() - this.startedAt) * 1000));
			for (const event of this.cursor.advance(position)) {
				if (!this.isCurrentOperation(operation)) {
					return;
				}
				await this.applyEvent(event, operation);
			}
			if (!this.isCurrentOperation(operation)) {
				return;
			}
			if (position >= this.activeDraft.duration && this.cursor.ended) {
				this.timer.clear();
				this.publish('ended', this.activeDraft.duration);
			} else {
				this.publish('playing', position);
			}
		} finally {
			this.ticking = false;
		}
	}

	private async applyEvent(event: CodeScrimRecordingEvent, operation: number): Promise<void> {
		switch (event.kind) {
			case 'workspace.entriesChanged':
				await this.applyWorkspaceChanges(event.payload.deleted, event.payload.created, operation);
				break;
			case 'editor.activeResourceChanged':
				if (event.payload.resource) {
					await this.activateReplayResource(event.payload.resource, operation);
				}
				break;
			case 'editor.documentChanged': {
				const model = await this.ensureModel(event.payload.resource);
				if (!model) {
					break;
				}
				if (event.payload.text !== undefined) {
					model.setValue(event.payload.text);
				} else {
					const edits = event.payload.changes.map(change => ({
						range: Range.fromPositions(model.getPositionAt(change.rangeOffset), model.getPositionAt(change.rangeOffset + change.rangeLength)),
						text: change.text,
					}));
					model.applyEdits(edits);
				}
				model.setEOL(event.payload.eol === '\r\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF);
				break;
			}
			case 'editor.selectionChanged': {
				await this.activateReplayResource(event.payload.resource, operation);
				if (!this.isCurrentOperation(operation)) {
					break;
				}
				const editor = this.codeEditorService.getActiveCodeEditor();
				if (editor?.getModel() === this.getModel(event.payload.resource)) {
					editor.setSelections(event.payload.selections.map(selection => new Selection(
						selection.selectionStartLineNumber,
						selection.selectionStartColumn,
						selection.positionLineNumber,
						selection.positionColumn,
					)));
				}
				break;
			}
			case 'editor.documentSaved':
				// Saves are presentation markers during passive replay. Instructor code is never written to disk here.
				break;
		}
	}

	private async activateReplayResource(resource: ICodeScrimWorkspaceResource, operation: number): Promise<void> {
		this.replayActiveResource = resource;
		await this.showResource(resource, operation);
	}

	private async showResource(resource: ICodeScrimWorkspaceResource, operation: number): Promise<void> {
		const model = await this.ensureModel(resource);
		if (!this.isCurrentOperation(operation)) {
			return;
		}
		this._activeResource = resource;
		const uri = this.getUri(resource);
		if (!uri || !model) {
			this.pendingActiveResource = resource;
			return;
		}
		this.pendingActiveResource = undefined;
		if (this.surface) {
			this.surface.openResource(resource, model);
			return;
		}
		// Replay is owned by the learner lesson surface. If that surface is not available, retain
		// the intended active resource without leaking recorded files into the creator workbench.
		this.pendingActiveResource = resource;
	}

	private getModel(resource: ICodeScrimWorkspaceResource): ITextModel | null {
		const model = this.models.get(CodeScrimRecordingBuffer.resourceKey(resource));
		return model && !model.isDisposed() ? model : null;
	}

	private ensureModel(resource: ICodeScrimWorkspaceResource): ITextModel | null {
		const key = CodeScrimRecordingBuffer.resourceKey(resource);
		const uri = this.getUri(resource);
		if (!uri) {
			return null;
		}
		const existing = this.models.get(key);
		if (existing && !existing.isDisposed()) {
			return existing;
		}

		const document = this.documentsByResource.get(key);
		const entry = this.entriesByResource.get(key);
		if (!document && (!entry || entry.type !== 'file' || !entry.text || entry.contents === undefined)) {
			return null;
		}
		const text = document?.text ?? decodeBase64(entry!.contents!).toString();
		const language = document
			? this.languageService.createById(document.languageId)
			: this.languageService.createByFilepathOrFirstLine(uri, text.split(/\r?\n/, 1)[0]);
		const model = this.modelService.createModel(text, language, uri, true);
		if (document) {
			model.setEOL(document.eol === '\r\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF);
		}
		this.models.set(key, model);
		return model;
	}

	private async applyWorkspaceChanges(deleted: readonly ICodeScrimWorkspaceResource[], created: readonly ICodeScrimWorkspaceEntryCheckpoint[], operation: number): Promise<void> {
		for (const resource of deleted) {
			await this.removeResourceTree(resource);
			if (!this.isCurrentOperation(operation)) {
				return;
			}
		}

		const draft = this.activeDraft;
		if (!draft) {
			return;
		}
		for (const entry of created) {
			const key = CodeScrimRecordingBuffer.resourceKey(entry.resource);
			this.entriesByResource.set(key, CodeScrimRecordingBuffer.freezeEntry(entry));
			if (entry.type !== 'file' || !entry.text || entry.contents === undefined) {
				continue;
			}
			this.registerResource(draft.id, entry.resource);
			const model = this.getModel(entry.resource);
			if (model) {
				model.setValue(decodeBase64(entry.contents).toString());
			}
		}

		if (this.pendingActiveResource && this.getUri(this.pendingActiveResource)) {
			await this.showResource(this.pendingActiveResource, operation);
		}
		this._onDidChangeWorkspace.fire();
	}

	private async removeResourceTree(resource: ICodeScrimWorkspaceResource): Promise<void> {
		const prefix = resource.path ? `${resource.path}/` : '';
		const keys = new Set<string>();
		for (const [key, entry] of this.entriesByResource) {
			if (entry.resource.root === resource.root && (entry.resource.path === resource.path || (prefix && entry.resource.path.startsWith(prefix)))) {
				keys.add(key);
			}
		}
		for (const [key, document] of this.documentsByResource) {
			if (document.resource.root === resource.root && (document.resource.path === resource.path || (prefix && document.resource.path.startsWith(prefix)))) {
				keys.add(key);
			}
		}

		for (const key of keys) {
			const removedResource = this.entriesByResource.get(key)?.resource ?? this.documentsByResource.get(key)?.resource;
			const uri = this.urisByResource.get(key);
			if (uri) {
				const editors = this.editorService.findEditors(uri);
				if (editors.length) {
					await this.editorService.closeEditors(editors, { preserveFocus: true });
				}
			}
			this.models.deleteAndDispose(key);
			this.urisByResource.delete(key);
			this.entriesByResource.delete(key);
			this.documentsByResource.delete(key);
			if (removedResource) {
				this.surface?.closeResource(removedResource);
			}
		}
		if (this._activeResource && keys.has(CodeScrimRecordingBuffer.resourceKey(this._activeResource))) {
			this._activeResource = undefined;
		}
		if (this.replayActiveResource && keys.has(CodeScrimRecordingBuffer.resourceKey(this.replayActiveResource))) {
			this.replayActiveResource = undefined;
		}
	}

	private registerResource(draftId: string, resource: ICodeScrimWorkspaceResource): void {
		const key = CodeScrimRecordingBuffer.resourceKey(resource);
		if (this.urisByResource.has(key)) {
			return;
		}
		const uri = this.toReplayUri(draftId, resource);
		this.urisByResource.set(key, uri);
	}

	private async closeReplayEditors(): Promise<void> {
		const editors = [...this.urisByResource.values()].flatMap(uri => this.editorService.findEditors(uri));
		if (editors.length) {
			await this.editorService.closeEditors(editors, { preserveFocus: true });
		}
	}

	private getUri(resource: ICodeScrimWorkspaceResource): URI | undefined {
		return this.urisByResource.get(CodeScrimRecordingBuffer.resourceKey(resource));
	}

	private toReplayUri(draftId: string, resource: ICodeScrimWorkspaceResource): URI {
		return URI.from({
			scheme: CODE_SCRIM_REPLAY_SCHEME,
			authority: draftId,
			path: `/${resource.root}/${resource.path}`,
			query: `workspace=${this.replayWorkspaceVersion}`,
		});
	}

	private publish(status: 'preparing' | 'playing' | 'paused' | 'ended', position: number): void {
		if (!this.activeDraft) {
			return;
		}

		this._state = Object.freeze({
			status,
			draftId: this.activeDraft.id,
			position,
			duration: this.activeDraft.duration,
			appliedEventCount: this.cursor.appliedEventCount,
			totalEventCount: this.cursor.totalEventCount,
		});
		this.syncStatusbar();
		this._onDidChangeState.fire(this._state);
	}

	private handleReplayError(error: unknown): void {
		this.timer.clear();
		this.ticking = false;
		onUnexpectedError(error);
		const message = getErrorMessage(error);
		if (this.activeDraft) {
			this._state = Object.freeze({
				status: 'error',
				draftId: this.activeDraft.id,
				position: this._state.status === 'idle' ? 0 : this._state.position,
				duration: this.activeDraft.duration,
				appliedEventCount: this.cursor.appliedEventCount,
				totalEventCount: this.cursor.totalEventCount,
				error: message,
			});
			this.syncStatusbar();
			this._onDidChangeState.fire(this._state);
		}
		this.notificationService.error(localize('codeScrim.replayFailed', "CodeScrim replay failed: {0}", message));
	}

	private publishIdle(): void {
		this._state = Object.freeze({ status: 'idle' });
		this.syncStatusbar();
		this._onDidChangeState.fire(this._state);
	}

	private syncStatusbar(): void {
		if (this._state.status === 'idle') {
			this.replayStatus.clear();
			return;
		}

		const ended = this._state.status === 'ended';
		const failed = this._state.status === 'error';
		const paused = this._state.status === 'paused';
		const entry = {
			name: localize('codeScrim.replayStatusName', "CodeScrim Replay"),
			text: failed
				? '$(error) ' + localize('codeScrim.replayFailedStatus', "Replay failed")
				: ended
				? '$(debug-restart) ' + localize('codeScrim.replayCompleteStatus', "Replay complete")
				: paused
					? '$(debug-pause) ' + localize('codeScrim.replayPausedStatus', "Replay paused")
				: this._state.status === 'preparing'
					? '$(loading~spin) ' + localize('codeScrim.replayPreparingStatus', "Preparing replay")
					: '$(play) ' + localize('codeScrim.replayStatusText', "Replaying · {0}/{1}", this._state.appliedEventCount, this._state.totalEventCount),
			ariaLabel: failed
				? localize('codeScrim.replayFailedAriaLabel', "CodeScrim replay failed: {0}. Click to try again.", this._state.error ?? '')
				: ended
				? localize('codeScrim.replayCompleteAriaLabel', "CodeScrim replay complete. Click to replay again.")
				: paused
					? localize('codeScrim.replayPausedAriaLabel', "CodeScrim replay paused. Click to resume.")
				: localize('codeScrim.replayStatusAriaLabel', "CodeScrim is replaying. {0} of {1} events applied. Click to stop.", this._state.appliedEventCount, this._state.totalEventCount),
			tooltip: failed
				? localize('codeScrim.retryReplayTooltip', "Retry CodeScrim replay: {0}", this._state.error ?? '')
				: ended
				? localize('codeScrim.replayAgainTooltip', "Replay the recording again")
				: paused
					? localize('codeScrim.resumeReplayTooltip', "Resume CodeScrim replay")
				: localize('codeScrim.stopReplayTooltip', "Stop CodeScrim replay"),
			kind: failed ? 'error' as const : ended ? 'prominent' as const : undefined,
			command: failed || ended ? CODE_SCRIM_RESTART_REPLAY_COMMAND_ID : paused ? CODE_SCRIM_RESUME_REPLAY_COMMAND_ID : CODE_SCRIM_STOP_REPLAY_COMMAND_ID,
		};
		if (this.replayStatus.value) {
			this.replayStatus.value.update(entry);
		} else {
			this.replayStatus.value = this.statusbarService.addEntry(entry, 'status.codescrimReplay', StatusbarAlignment.RIGHT, 99);
		}
	}

	private now(): number {
		return mainWindow.performance.now();
	}

	private isCurrentOperation(operation: number): boolean {
		return operation === this.operationVersion;
	}
}
