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
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { EndOfLineSequence, ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CodeScrimRecordingBuffer, CodeScrimRecordingEvent, ICodeScrimDocumentCheckpoint, ICodeScrimRecordingCheckpoint, ICodeScrimRecordingDraft, ICodeScrimWorkspaceEntryCheckpoint, ICodeScrimWorkspaceResource } from '../common/codeScrimRecording.js';
import { CodeScrimLearnerOverlayStore, CodeScrimReplayCursor, CodeScrimReplayState, findCodeScrimCheckpoint, ICodeScrimLearnerExperiment, ICodeScrimLearnerState, ICodeScrimReplayService, ICodeScrimReplaySurface } from '../common/codeScrimReplay.js';
import { ICodeScrimTerminalState } from '../common/codeScrimTerminal.js';
import { CodeScrimTerminalReplay } from './codeScrimTerminalReplay.js';

const REPLAY_TICK_INTERVAL = 16;

export class CodeScrimReplayService extends Disposable implements ICodeScrimReplayService {

	declare readonly _serviceBrand: undefined;

	private readonly cursor = new CodeScrimReplayCursor();
	private readonly terminalReplay = this._register(new CodeScrimTerminalReplay());
	private readonly learnerOverlays = new CodeScrimLearnerOverlayStore();
	private readonly operations = new Sequencer();
	private readonly models = this._register(new DisposableMap<string, ITextModel>());
	private readonly instructorModels = this._register(new DisposableMap<string, ITextModel>());
	private readonly learnerModelListeners = this._register(new DisposableMap<string, IDisposable>());
	private readonly timer = this._register(new MutableDisposable());
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
	private _learnerExperiments: readonly ICodeScrimLearnerExperiment[] = [];
	private _activeLearnerExperimentId: string | undefined;
	private learnerExperimentSequence = 0;
	private replayActiveResource: ICodeScrimWorkspaceResource | undefined;
	private pendingActiveResource: ICodeScrimWorkspaceResource | undefined;
	private readonly _onDidChangeState = this._register(new Emitter<CodeScrimReplayState>());
	readonly onDidChangeState = this._onDidChangeState.event;
	private readonly _onDidChangeWorkspace = this._register(new Emitter<void>());
	readonly onDidChangeWorkspace = this._onDidChangeWorkspace.event;
	private readonly _onDidChangeLearnerState = this._register(new Emitter<ICodeScrimLearnerState>());
	readonly onDidChangeLearnerState = this._onDidChangeLearnerState.event;
	private readonly _onDidChangeLearnerExperiments = this._register(new Emitter<readonly ICodeScrimLearnerExperiment[]>());
	readonly onDidChangeLearnerExperiments = this._onDidChangeLearnerExperiments.event;
	readonly onDidChangeTerminalState = this.terminalReplay.onDidChangeState;
	private applyingInstructorText = false;

	get state(): CodeScrimReplayState {
		return this._state;
	}

	get workspaceEntries(): readonly ICodeScrimWorkspaceEntryCheckpoint[] {
		return [...this.entriesByResource.values()].sort((left, right) => left.resource.root - right.resource.root || left.resource.path.localeCompare(right.resource.path));
	}

	get activeResource(): ICodeScrimWorkspaceResource | undefined {
		return this._activeResource;
	}

	get learnerState(): ICodeScrimLearnerState {
		return this.learnerOverlays.state;
	}

	get learnerExperiments(): readonly ICodeScrimLearnerExperiment[] {
		return this._learnerExperiments;
	}

	get activeLearnerExperimentId(): string | undefined {
		return this._activeLearnerExperimentId;
	}

	get terminalState(): ICodeScrimTerminalState {
		return this.terminalReplay.state;
	}

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IModelService private readonly modelService: IModelService,
		@INotificationService private readonly notificationService: INotificationService,
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

	beginLearnerEdit(): void {
		if (this._state.status !== 'playing') {
			return;
		}
		// Editing is an immediate mode switch. Invalidate queued replay ticks before
		// they can advance beyond the instructor state currently visible to the learner.
		this.operationVersion++;
		this.timer.clear();
		this.publish('paused', this._state.position);
	}

	resume(): void {
		const operation = ++this.operationVersion;
		this.timer.clear();
		void this.operations.queue(() => this.doResume(operation));
	}

	stop(): void {
		this.captureLearnerExperiment();
		this.operationVersion++;
		this.timer.clear();
		this.ticking = false;
		this.terminalReplay.reset();
		this.publishIdle();
	}

	getInstructorModel(resource: ICodeScrimWorkspaceResource): ITextModel | null {
		return this.getInstructorModelInternal(resource);
	}

	getLearnerModel(resource: ICodeScrimWorkspaceResource): ITextModel | null {
		return this.getModel(resource);
	}

	hasLearnerChanges(resource: ICodeScrimWorkspaceResource): boolean {
		return this.learnerOverlays.hasChanges(resource);
	}

	isLearnerVersionKept(resource: ICodeScrimWorkspaceResource): boolean {
		return this.learnerOverlays.isKept(resource);
	}

	keepLearnerVersion(resource: ICodeScrimWorkspaceResource): boolean {
		if (!this.learnerOverlays.keep(resource)) {
			return false;
		}
		this.publishLearnerState();
		return true;
	}

	restoreInstructorVersion(resource: ICodeScrimWorkspaceResource): boolean {
		const instructor = this.getInstructorModelInternal(resource);
		const learner = this.getModel(resource);
		if (!instructor || !learner || !this.learnerOverlays.restore(resource)) {
			return false;
		}
		this.syncLearnerModel(learner, instructor);
		this.publishLearnerState();
		return true;
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

	async openLearnerExperiment(id: string): Promise<void> {
		const experiment = this._learnerExperiments.find(candidate => candidate.id === id);
		if (!experiment) {
			return;
		}
		const operation = ++this.operationVersion;
		this.timer.clear();
		await this.operations.queue(() => this.doOpenLearnerExperiment(experiment, operation));
	}

	restoreLearnerExperiment(id: string): boolean {
		if (this._activeLearnerExperimentId !== id) {
			return false;
		}

		const experiment = this._learnerExperiments.find(candidate => candidate.id === id);
		if (!experiment) {
			return false;
		}

		for (const change of experiment.changes) {
			const instructor = this.getInstructorModelInternal(change.resource);
			const learner = this.getModel(change.resource);
			if (instructor && learner && this.learnerOverlays.restore(change.resource)) {
				this.syncLearnerModel(learner, instructor);
			}
		}
		this._activeLearnerExperimentId = undefined;
		this.publishLearnerState();
		this.publishLearnerExperiments();
		return true;
	}

	deleteLearnerExperiment(id: string): boolean {
		const experiment = this._learnerExperiments.find(candidate => candidate.id === id);
		if (!experiment) {
			return false;
		}

		if (this._activeLearnerExperimentId === id) {
			this.restoreLearnerExperiment(id);
		}
		this._learnerExperiments = Object.freeze(this._learnerExperiments.filter(candidate => candidate.id !== id));
		this.publishLearnerExperiments();
		return true;
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
			this.learnerOverlays.clear();
			this._learnerExperiments = [];
			this._activeLearnerExperimentId = undefined;
			this.learnerExperimentSequence = 0;
			this.publishLearnerState();
			this.publishLearnerExperiments();
			await this.closeReplayEditors();
			if (!this.isCurrentOperation(operation)) {
				return false;
			}
			this.surface?.clear();
			this.models.clearAndDisposeAll();
			this.instructorModels.clearAndDisposeAll();
			this.learnerModelListeners.clearAndDisposeAll();
			this.activeDraft = draft;
			this.publish('preparing', 0);
			this.prepareWorkspace(draft, draft.checkpoints[0]);
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

		this.captureLearnerExperiment();
		this.publish('preparing', 0);
		try {
			await this.closeReplayEditors();
			if (!this.isCurrentOperation(operation)) {
				return false;
			}
			this.surface?.clear();
			this.models.clearAndDisposeAll();
			this.instructorModels.clearAndDisposeAll();
			this.learnerModelListeners.clearAndDisposeAll();
			this.prepareWorkspace(draft, draft.checkpoints[0]);
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

		this.captureLearnerExperiment();
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
			this.instructorModels.clearAndDisposeAll();
			this.learnerModelListeners.clearAndDisposeAll();
			const checkpoint = findCodeScrimCheckpoint(draft.checkpoints, target);
			this.prepareWorkspace(draft, checkpoint);
			this.cursor.reset(draft.events, checkpoint.eventIndex, checkpoint.timestamp);
			const initialResource = this.getInitialResource(draft, checkpoint);
			if (initialResource) {
				await this.activateReplayResource(initialResource, operation);
				if (checkpoint.activeResource && checkpoint.selections?.length) {
					this.surface?.applySelections(checkpoint.activeResource, checkpoint.selections);
				}
			}
			for (const event of this.cursor.advance(target)) {
				if (!this.isCurrentOperation(operation)) {
					return;
				}
				await this.applyEvent(event, operation, false);
			}
			this.reconcileLearnerOverlays();
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

	private async doOpenLearnerExperiment(experiment: ICodeScrimLearnerExperiment, operation: number): Promise<void> {
		const draft = this.activeDraft;
		if (!draft || !this.isCurrentOperation(operation)) {
			return;
		}

		this.captureLearnerExperiment();
		const target = Math.min(draft.duration, Math.max(0, experiment.position));
		this.publish('preparing', target);
		try {
			await this.closeReplayEditors();
			if (!this.isCurrentOperation(operation)) {
				return;
			}
			this.surface?.clear();
			this.models.clearAndDisposeAll();
			this.instructorModels.clearAndDisposeAll();
			this.learnerModelListeners.clearAndDisposeAll();
			this.learnerOverlays.clear();
			const checkpoint = findCodeScrimCheckpoint(draft.checkpoints, target);
			this.prepareWorkspace(draft, checkpoint);
			this.cursor.reset(draft.events, checkpoint.eventIndex, checkpoint.timestamp);
			const initialResource = this.getInitialResource(draft, checkpoint);
			if (initialResource) {
				await this.activateReplayResource(initialResource, operation);
				if (checkpoint.activeResource && checkpoint.selections?.length) {
					this.surface?.applySelections(checkpoint.activeResource, checkpoint.selections);
				}
			}
			for (const event of this.cursor.advance(target)) {
				if (!this.isCurrentOperation(operation)) {
					return;
				}
				await this.applyEvent(event, operation, false);
			}

			for (const change of experiment.changes) {
				const learner = this.ensureModel(change.resource);
				const instructor = this.getInstructorModelInternal(change.resource);
				if (!learner || !instructor) {
					continue;
				}
				this.applyingInstructorText = true;
				try {
					learner.setValue(change.learnerText);
				} finally {
					this.applyingInstructorText = false;
				}
				this.learnerOverlays.record(change.resource, change.learnerText, instructor.getValue());
			}
			this._activeLearnerExperimentId = experiment.id;
			this.publishLearnerState();
			this.publishLearnerExperiments();
			const firstChange = experiment.changes[0];
			if (firstChange) {
				await this.showResource(firstChange.resource, operation);
			}
			if (!this.isCurrentOperation(operation)) {
				return;
			}
			this.startedAt = this.now() - target / 1000;
			this.publish('paused', target);
		} catch (error) {
			if (this.isCurrentOperation(operation)) {
				this.handleReplayError(error);
			}
		}
	}

	private async doResume(operation: number): Promise<void> {
		if (this._state.status !== 'paused' || !this.isCurrentOperation(operation)) {
			return;
		}
		this.captureLearnerExperiment();

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

	private prepareWorkspace(draft: ICodeScrimRecordingDraft, checkpoint: ICodeScrimRecordingCheckpoint): void {
		this.documentsByResource.clear();
		this.entriesByResource.clear();
		this.urisByResource.clear();
		this.replayWorkspaceVersion++;
		this._activeResource = undefined;
		this.replayActiveResource = undefined;
		this.pendingActiveResource = undefined;
		this.surface?.clear();
		this.terminalReplay.reset({ terminals: checkpoint.terminals, activeTerminalId: checkpoint.activeTerminalId });

		for (const entry of checkpoint.entries) {
			const key = CodeScrimRecordingBuffer.resourceKey(entry.resource);
			this.entriesByResource.set(key, entry);
			if (entry.type === 'file' && entry.text) {
				this.registerResource(draft.id, entry.resource);
			}
		}
		for (const document of checkpoint.documents) {
			this.documentsByResource.set(CodeScrimRecordingBuffer.resourceKey(document.resource), document);
			this.registerResource(draft.id, document.resource);
		}
		this._onDidChangeWorkspace.fire();
	}

	private async startPreparedReplay(draft: ICodeScrimRecordingDraft, operation: number): Promise<void> {
		const checkpoint = draft.checkpoints[0];
		this.cursor.reset(draft.events, checkpoint.eventIndex, checkpoint.timestamp);
		const initialResource = this.getInitialResource(draft, checkpoint);
		if (initialResource) {
			await this.activateReplayResource(initialResource, operation);
			if (checkpoint.activeResource && checkpoint.selections?.length) {
				this.surface?.applySelections(checkpoint.activeResource, checkpoint.selections);
			}
		}
		if (!this.isCurrentOperation(operation)) {
			return;
		}

		// Opening a lesson prepares its initial frame without advancing the instructor clock.
		// Playback begins only after the learner explicitly presses Play.
		this.publish('paused', 0);
	}

	private getInitialResource(draft: ICodeScrimRecordingDraft, checkpoint: ICodeScrimRecordingCheckpoint): ICodeScrimWorkspaceResource | undefined {
		const nextActiveResource = draft.events.slice(checkpoint.eventIndex).find((event): event is Extract<CodeScrimRecordingEvent, { readonly kind: 'editor.activeResourceChanged' }> =>
			event.kind === 'editor.activeResourceChanged' && event.payload.resource !== undefined)?.payload.resource;
		return checkpoint.activeResource
			?? nextActiveResource
			?? checkpoint.documents[0]?.resource
			?? checkpoint.entries.find(entry => entry.type === 'file' && entry.text)?.resource;
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
			let event: CodeScrimRecordingEvent | undefined;
			while ((event = this.cursor.advanceOne(position))) {
				if (!this.isCurrentOperation(operation)) {
					return;
				}
				if (await this.applyEvent(event, operation, true)) {
					this.timer.clear();
					this.publish('paused', event.timestamp);
					return;
				}
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

	private async applyEvent(event: CodeScrimRecordingEvent, operation: number, allowConflict: boolean): Promise<boolean> {
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
				const instructorModel = this.getInstructorModelInternal(event.payload.resource);
				if (!model || !instructorModel) {
					break;
				}
				this.applyDocumentChange(instructorModel, event.payload);
				const instructorText = instructorModel.getValue();
				const decision = this.learnerOverlays.advanceInstructor(event.payload.resource, instructorText, allowConflict);
				if (decision === 'apply') {
					// Incremental edits let Monaco move the caret and active-line state exactly as
					// it does during ordinary typing. Guard the mutation so the learner model's
					// content listener does not mistake replay-owned input for learner editing.
					this.applyingInstructorText = true;
					try {
						this.applyDocumentChange(model, event.payload);
					} finally {
						this.applyingInstructorText = false;
					}
				} else if (decision === 'conflict') {
					this.publishLearnerState();
					return true;
				}
				break;
			}
			case 'editor.selectionChanged': {
				await this.activateReplayResource(event.payload.resource, operation);
				if (!this.isCurrentOperation(operation)) {
					break;
				}
				// The lesson editor is an embedded native editor, so it is not guaranteed to be
				// returned as the active workbench editor. Route presentation through the
				// attached replay surface instead of guessing through global editor state.
				this.surface?.applySelections(event.payload.resource, event.payload.selections);
				break;
			}
			case 'editor.documentSaved':
				// Saves are presentation markers during passive replay. Instructor code is never written to disk here.
				break;
			default:
				this.terminalReplay.apply(event);
				break;
		}
		return false;
	}

	private applyDocumentChange(model: ITextModel, payload: Extract<CodeScrimRecordingEvent, { readonly kind: 'editor.documentChanged' }>['payload']): void {
		if (payload.changes.length) {
			try {
				model.applyEdits(payload.changes.map(change => ({
					range: Range.fromPositions(model.getPositionAt(change.rangeOffset), model.getPositionAt(change.rangeOffset + change.rangeLength)),
					text: change.text,
				})));
			} catch (error) {
				if (payload.text === undefined) {
					throw error;
				}
			}
		}
		if (payload.text !== undefined && model.getValue() !== payload.text) {
			model.setValue(payload.text);
		}
		model.setEOL(payload.eol === '\r\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF);
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

	private getInstructorModelInternal(resource: ICodeScrimWorkspaceResource): ITextModel | null {
		const model = this.instructorModels.get(CodeScrimRecordingBuffer.resourceKey(resource));
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
		const instructorText = document?.text ?? decodeBase64(entry!.contents!).toString();
		const language = document
			? this.languageService.createById(document.languageId)
			: this.languageService.createByFilepathOrFirstLine(uri, instructorText.split(/\r?\n/, 1)[0]);
		const instructorUri = uri.with({ scheme: 'codescrim-instructor' });
		const instructorModel = this.modelService.createModel(instructorText, language, instructorUri, true);
		// The learner model is intentionally not a simple-widget model: extension-host
		// language services must receive it just like a normal editable VS Code document.
		const model = this.modelService.createModel(this.learnerOverlays.getText(resource) ?? instructorText, language, uri, false);
		if (document) {
			instructorModel.setEOL(document.eol === '\r\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF);
			model.setEOL(document.eol === '\r\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF);
		}
		this.instructorModels.set(key, instructorModel);
		this.models.set(key, model);
		this.learnerModelListeners.set(key, model.onDidChangeContent(() => {
			if (this.applyingInstructorText) {
				return;
			}
			this.beginLearnerEdit();
			this.learnerOverlays.record(resource, model.getValue(), instructorModel.getValue());
			this.publishLearnerState();
		}));
		return model;
	}

	private syncLearnerModel(learner: ITextModel, instructor: ITextModel): void {
		this.applyingInstructorText = true;
		try {
			learner.setValue(instructor.getValue());
			learner.setEOL(instructor.getEOL() === '\r\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF);
		} finally {
			this.applyingInstructorText = false;
		}
	}

	private publishLearnerState(): void {
		this._onDidChangeLearnerState.fire(this.learnerOverlays.state);
	}

	private publishLearnerExperiments(): void {
		this._onDidChangeLearnerExperiments.fire(this._learnerExperiments);
	}

	private captureLearnerExperiment(): void {
		if (!this.activeDraft) {
			return;
		}
		const changes = this.learnerOverlays.state.changedResources.flatMap(resource => {
			const learner = this.getModel(resource);
			const instructor = this.getInstructorModelInternal(resource);
			return learner && instructor ? [{
				resource,
				learnerText: learner.getValue(),
				instructorText: instructor.getValue(),
			}] : [];
		});
		if (!changes.length) {
			this._activeLearnerExperimentId = undefined;
			return;
		}
		const activeExperiment = this._activeLearnerExperimentId
			? this._learnerExperiments.find(experiment => experiment.id === this._activeLearnerExperimentId)
			: undefined;
		const unchangedLoadedExperiment = activeExperiment
			&& activeExperiment.changes.length === changes.length
			&& activeExperiment.changes.every(change => changes.some(candidate =>
				CodeScrimRecordingBuffer.resourceKey(candidate.resource) === CodeScrimRecordingBuffer.resourceKey(change.resource)
				&& candidate.learnerText === change.learnerText));

		if (!unchangedLoadedExperiment) {
			const experiment: ICodeScrimLearnerExperiment = Object.freeze({
				id: `${this.activeDraft.id}:experiment:${++this.learnerExperimentSequence}`,
				position: this._state.status === 'idle' ? 0 : this._state.position,
				changes: Object.freeze(changes),
			});
			this._learnerExperiments = Object.freeze([...this._learnerExperiments, experiment]);
		}
		this._activeLearnerExperimentId = undefined;
		for (const change of changes) {
			const learner = this.getModel(change.resource);
			const instructor = this.getInstructorModelInternal(change.resource);
			if (learner && instructor) {
				this.syncLearnerModel(learner, instructor);
			}
		}
		this.learnerOverlays.clear();
		this.publishLearnerState();
		this.publishLearnerExperiments();
	}

	private reconcileLearnerOverlays(): void {
		for (const resource of this.learnerOverlays.state.changedResources) {
			const learner = this.ensureModel(resource);
			const instructor = this.getInstructorModelInternal(resource);
			if (learner && instructor) {
				this.learnerOverlays.record(resource, learner.getValue(), instructor.getValue());
			}
		}
		this.publishLearnerState();
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
			const instructorModel = this.getInstructorModelInternal(entry.resource);
			if (model && instructorModel) {
				instructorModel.setValue(decodeBase64(entry.contents).toString());
				if (!this.learnerOverlays.hasChanges(entry.resource)) {
					this.syncLearnerModel(model, instructorModel);
				}
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
			this.instructorModels.deleteAndDispose(key);
			this.learnerModelListeners.deleteAndDispose(key);
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
			// Untitled is VS Code's generic editable-document contract. It gives every
			// installed language provider its normal opt-in path without writing to disk.
			scheme: Schemas.untitled,
			authority: draftId,
			path: `/codescrim/${resource.root}/${resource.path}`,
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
			this._onDidChangeState.fire(this._state);
		}
		this.notificationService.error(localize('codeScrim.replayFailed', "CodeScrim replay failed: {0}", message));
	}

	private publishIdle(): void {
		this._state = Object.freeze({ status: 'idle' });
		this._onDidChangeState.fire(this._state);
	}

	private now(): number {
		return mainWindow.performance.now();
	}

	private isCurrentOperation(operation: number): boolean {
		return operation === this.operationVersion;
	}
}
