/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { getErrorMessage, onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { EndOfLineSequence, ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { CodeScrimRecordingBuffer, CodeScrimRecordingEvent, ICodeScrimDocumentCheckpoint, ICodeScrimRecordingDraft, ICodeScrimWorkspaceEntryCheckpoint, ICodeScrimWorkspaceResource } from '../common/codeScrimRecording.js';
import { CodeScrimReplayCursor, CodeScrimReplayState, CODE_SCRIM_RESTART_REPLAY_COMMAND_ID, CODE_SCRIM_STOP_REPLAY_COMMAND_ID, ICodeScrimReplayService } from '../common/codeScrimReplay.js';

const CODE_SCRIM_REPLAY_SCHEME = 'codescrim-replay';
const REPLAY_TICK_INTERVAL = 16;

export class CodeScrimReplayService extends Disposable implements ICodeScrimReplayService, ITextModelContentProvider {

	declare readonly _serviceBrand: undefined;

	private readonly cursor = new CodeScrimReplayCursor();
	private readonly modelReferences = this._register(new DisposableMap<string>());
	private readonly timer = this._register(new MutableDisposable());
	private readonly replayStatus = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly documentsByResource = new Map<string, ICodeScrimDocumentCheckpoint>();
	private readonly entriesByResource = new Map<string, ICodeScrimWorkspaceEntryCheckpoint>();
	private readonly urisByResource = new Map<string, URI>();
	private readonly resourcesByUri = new Map<string, ICodeScrimWorkspaceResource>();
	private _state: CodeScrimReplayState = Object.freeze({ status: 'idle' });
	private activeDraft: ICodeScrimRecordingDraft | undefined;
	private startedAt = 0;
	private ticking = false;
	private pendingActiveResource: ICodeScrimWorkspaceResource | undefined;
	private readonly _onDidChangeState = this._register(new Emitter<CodeScrimReplayState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	get state(): CodeScrimReplayState {
		return this._state;
	}

	constructor(
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IEditorService private readonly editorService: IEditorService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IModelService private readonly modelService: IModelService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ITextModelService private readonly textModelService: ITextModelService,
	) {
		super();
		this._register(this.textModelService.registerTextModelContentProvider(CODE_SCRIM_REPLAY_SCHEME, this));
	}

	async replay(draft: ICodeScrimRecordingDraft): Promise<boolean> {
		this.stop();
		await this.closeReplayEditors();
		this.modelReferences.clearAndDisposeAll();
		this.activeDraft = draft;
		this.publish('preparing', 0);

		try {
			this.prepareWorkspace(draft);
			await this.startPreparedReplay(draft);
			return true;
		} catch (error) {
			this.handleReplayError(error);
			return false;
		}
	}

	async restart(): Promise<boolean> {
		const draft = this.activeDraft;
		if (!draft) {
			return false;
		}

		this.timer.clear();
		this.publish('preparing', 0);
		try {
			await this.closeReplayEditors();
			this.modelReferences.clearAndDisposeAll();
			this.prepareWorkspace(draft);
			await this.startPreparedReplay(draft);
			return true;
		} catch (error) {
			this.handleReplayError(error);
			return false;
		}
	}

	stop(): void {
		this.timer.clear();
		this.ticking = false;
		this.publishIdle();
	}

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const existing = this.modelService.getModel(resource);
		if (existing && !existing.isDisposed()) {
			return existing;
		}

		const workspaceResource = this.resourcesByUri.get(resource.toString());
		if (!workspaceResource) {
			return null;
		}
		const key = CodeScrimRecordingBuffer.resourceKey(workspaceResource);
		const document = this.documentsByResource.get(key);
		const entry = this.entriesByResource.get(key);
		if (!document && (!entry || entry.type !== 'file' || !entry.text || entry.contents === undefined)) {
			return null;
		}
		const text = document?.text ?? decodeBase64(entry!.contents!).toString();
		const language = document
			? this.languageService.createById(document.languageId)
			: this.languageService.createByFilepathOrFirstLine(resource, text.split(/\r?\n/, 1)[0]);

		// Passive instructor replay must not be presented to extension-host language services as an
		// editable workspace document. The model still uses the recorded language for native syntax
		// highlighting, while this flag keeps virtual replay paths out of extension synchronization.
		const model = this.modelService.createModel(text, language, resource, true);
		if (document) {
			model.setEOL(document.eol === '\r\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF);
		}
		return model;
	}

	private prepareWorkspace(draft: ICodeScrimRecordingDraft): void {
		this.documentsByResource.clear();
		this.entriesByResource.clear();
		this.urisByResource.clear();
		this.resourcesByUri.clear();
		this.pendingActiveResource = undefined;

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
	}

	private async startPreparedReplay(draft: ICodeScrimRecordingDraft): Promise<void> {
		this.cursor.reset(draft.events);
		const initialResource = draft.events.find(event => event.kind === 'editor.activeResourceChanged' && event.payload.resource)?.payload.resource
			?? draft.checkpoint.documents[0]?.resource
			?? draft.checkpoint.entries.find(entry => entry.type === 'file' && entry.text)?.resource;
		if (initialResource) {
			await this.openResource(initialResource);
		}

		this.startedAt = this.now();
		this.publish('playing', 0);
		await this.tick();
		if (this._state.status !== 'playing') {
			return;
		}

		const handle = mainWindow.setInterval(() => {
			void this.tick().catch(error => {
				this.handleReplayError(error);
			});
		}, REPLAY_TICK_INTERVAL);
		this.timer.value = toDisposable(() => mainWindow.clearInterval(handle));
	}

	private async tick(): Promise<void> {
		if (this.ticking || this._state.status !== 'playing' || !this.activeDraft) {
			return;
		}

		this.ticking = true;
		try {
			const position = Math.min(this.activeDraft.duration, Math.round((this.now() - this.startedAt) * 1000));
			for (const event of this.cursor.advance(position)) {
				await this.applyEvent(event);
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

	private async applyEvent(event: CodeScrimRecordingEvent): Promise<void> {
		switch (event.kind) {
			case 'workspace.entriesChanged':
				await this.applyWorkspaceChanges(event.payload.deleted, event.payload.created);
				break;
			case 'editor.activeResourceChanged':
				if (event.payload.resource) {
					await this.openResource(event.payload.resource);
				}
				break;
			case 'editor.documentChanged': {
				const model = await this.ensureModel(event.payload.resource);
				if (!model) {
					break;
				}
				const edits = event.payload.changes.map(change => ({
					range: Range.fromPositions(model.getPositionAt(change.rangeOffset), model.getPositionAt(change.rangeOffset + change.rangeLength)),
					text: change.text,
				}));
				model.applyEdits(edits);
				model.setEOL(event.payload.eol === '\r\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF);
				break;
			}
			case 'editor.selectionChanged': {
				await this.openResource(event.payload.resource);
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

	private async openResource(resource: ICodeScrimWorkspaceResource): Promise<void> {
		const model = await this.ensureModel(resource);
		const uri = this.getUri(resource);
		if (!uri || !model) {
			this.pendingActiveResource = resource;
			return;
		}
		this.pendingActiveResource = undefined;

		if (this.codeEditorService.getActiveCodeEditor()?.getModel()?.uri.toString() !== uri.toString()) {
			await this.editorService.openEditor({ resource: uri, options: { pinned: true } });
		}
	}

	private getModel(resource: ICodeScrimWorkspaceResource): ITextModel | null {
		const uri = this.getUri(resource);
		return uri ? this.modelService.getModel(uri) : null;
	}

	private async ensureModel(resource: ICodeScrimWorkspaceResource): Promise<ITextModel | null> {
		const key = CodeScrimRecordingBuffer.resourceKey(resource);
		const uri = this.getUri(resource);
		if (!uri) {
			return null;
		}
		const existing = this.modelService.getModel(uri);
		if (existing && !existing.isDisposed()) {
			return existing;
		}
		if (!this.modelReferences.has(key)) {
			this.modelReferences.set(key, await this.textModelService.createModelReference(uri));
		}
		return this.modelService.getModel(uri);
	}

	private async applyWorkspaceChanges(deleted: readonly ICodeScrimWorkspaceResource[], created: readonly ICodeScrimWorkspaceEntryCheckpoint[]): Promise<void> {
		for (const resource of deleted) {
			await this.removeResourceTree(resource);
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
			await this.openResource(this.pendingActiveResource);
		}
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
			const uri = this.urisByResource.get(key);
			if (uri) {
				const editors = this.editorService.findEditors(uri);
				if (editors.length) {
					await this.editorService.closeEditors(editors, { preserveFocus: true });
				}
				this.resourcesByUri.delete(uri.toString());
			}
			this.modelReferences.deleteAndDispose(key);
			this.urisByResource.delete(key);
			this.entriesByResource.delete(key);
			this.documentsByResource.delete(key);
		}
	}

	private registerResource(draftId: string, resource: ICodeScrimWorkspaceResource): void {
		const key = CodeScrimRecordingBuffer.resourceKey(resource);
		if (this.urisByResource.has(key)) {
			return;
		}
		const uri = this.toReplayUri(draftId, resource);
		this.urisByResource.set(key, uri);
		this.resourcesByUri.set(uri.toString(), resource);
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
		});
	}

	private publish(status: 'preparing' | 'playing' | 'ended', position: number): void {
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
		const entry = {
			name: localize('codeScrim.replayStatusName', "CodeScrim Replay"),
			text: failed
				? '$(error) ' + localize('codeScrim.replayFailedStatus', "Replay failed")
				: ended
				? '$(debug-restart) ' + localize('codeScrim.replayCompleteStatus', "Replay complete")
				: this._state.status === 'preparing'
					? '$(loading~spin) ' + localize('codeScrim.replayPreparingStatus', "Preparing replay")
					: '$(play) ' + localize('codeScrim.replayStatusText', "Replaying · {0}/{1}", this._state.appliedEventCount, this._state.totalEventCount),
			ariaLabel: failed
				? localize('codeScrim.replayFailedAriaLabel', "CodeScrim replay failed: {0}. Click to try again.", this._state.error ?? '')
				: ended
				? localize('codeScrim.replayCompleteAriaLabel', "CodeScrim replay complete. Click to replay again.")
				: localize('codeScrim.replayStatusAriaLabel', "CodeScrim is replaying. {0} of {1} events applied. Click to stop.", this._state.appliedEventCount, this._state.totalEventCount),
			tooltip: failed
				? localize('codeScrim.retryReplayTooltip', "Retry CodeScrim replay: {0}", this._state.error ?? '')
				: ended
				? localize('codeScrim.replayAgainTooltip', "Replay the recording again")
				: localize('codeScrim.stopReplayTooltip', "Stop CodeScrim replay"),
			kind: failed ? 'error' as const : ended ? 'prominent' as const : undefined,
			command: failed || ended ? CODE_SCRIM_RESTART_REPLAY_COMMAND_ID : CODE_SCRIM_STOP_REPLAY_COMMAND_ID,
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
}
