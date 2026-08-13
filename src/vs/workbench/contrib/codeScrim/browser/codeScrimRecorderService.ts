/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { FileChangesEvent, IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../nls.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { ICodeScrimPackageService } from '../common/codeScrimPackage.js';
import { CodeScrimRecordingBuffer, CodeScrimRecordingEventData, CodeScrimRecordingState, CODE_SCRIM_PAUSE_RECORDING_COMMAND_ID, CODE_SCRIM_RESUME_RECORDING_COMMAND_ID, CODE_SCRIM_STOP_RECORDING_COMMAND_ID, ICodeScrimRecorderService, ICodeScrimRecordingDraft, ICodeScrimSelection, ICodeScrimWorkspaceEntryCheckpoint, ICodeScrimWorkspaceResource } from '../common/codeScrimRecording.js';

const MAX_CHECKPOINT_FILE_SIZE = 2 * 1024 * 1024;
const MAX_CHECKPOINT_TOTAL_SIZE = 64 * 1024 * 1024;
const MAX_CHECKPOINT_ENTRY_COUNT = 5000;
const EXCLUDED_CHECKPOINT_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules']);

interface ICodeScrimSnapshotBudget {
	entryCount: number;
	totalSize: number;
	skippedEntryCount: number;
}

export class CodeScrimRecorderService extends Disposable implements ICodeScrimRecorderService {

	declare readonly _serviceBrand: undefined;

	private readonly buffer = new CodeScrimRecordingBuffer();
	private readonly recordingListeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly recordingStatus = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly stopRecordingStatus = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private _state: CodeScrimRecordingState = Object.freeze({ status: 'idle' });
	private _lastDraft: ICodeScrimRecordingDraft | undefined;
	private initialization: Promise<void> | undefined;
	private pendingWorkspaceChanges: Promise<void> = Promise.resolve();
	private readonly knownWorkspaceResources = new Set<string>();
	private readonly _onDidChangeState = this._register(new Emitter<CodeScrimRecordingState>());
	readonly onDidChangeState = this._onDidChangeState.event;
	private readonly _onDidChangeDraft = this._register(new Emitter<ICodeScrimRecordingDraft | undefined>());
	readonly onDidChangeDraft = this._onDidChangeDraft.event;

	get state(): CodeScrimRecordingState {
		return this._state;
	}

	get lastDraft(): ICodeScrimRecordingDraft | undefined {
		return this._lastDraft;
	}

	constructor(
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IModelService private readonly modelService: IModelService,
		@ICodeScrimPackageService private readonly packageService: ICodeScrimPackageService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this.syncStatusbar();
	}

	initialize(): Promise<void> {
		return this.initialization ??= this.restoreLastDraft();
	}

	setLastDraft(draft: ICodeScrimRecordingDraft): void {
		this._lastDraft = draft;
		this._onDidChangeDraft.fire(draft);
	}

	async startRecording(): Promise<boolean> {
		await this.initialize();
		if (this._state.status !== 'idle') {
			return false;
		}

		const draftId = generateUuid();
		this.publishPreparing();
		this.knownWorkspaceResources.clear();
		try {
			const budget = this.createSnapshotBudget();
			const entries: ICodeScrimWorkspaceEntryCheckpoint[] = [];
			for (const folder of this.workspaceContextService.getWorkspace().folders) {
				const stat = await this.fileService.resolve(folder.uri);
				for (const child of stat.children ?? []) {
					entries.push(...await this.snapshotEntry(child, budget, true));
				}
			}

			// Timeline zero begins only after preparation. Snapshot I/O is not instructor activity and
			// must never become a blank delay at the beginning of every replay.
			this.buffer.start(draftId, this.now());
			for (const entry of entries) {
				this.buffer.captureWorkspaceEntry(entry);
				this.knownWorkspaceResources.add(CodeScrimRecordingBuffer.resourceKey(entry.resource));
			}
			for (let i = 0; i < budget.skippedEntryCount; i++) {
				this.buffer.recordSkippedWorkspaceEntry();
			}

			this.pendingWorkspaceChanges = Promise.resolve();
			this.recordingListeners.value = this.createRecordingListeners();
			this.recordActiveResource();
			this.publishState();
			return true;
		} catch (error) {
			if (this.buffer.isRecording) {
				this.buffer.stop(this.now());
			}
			this.publishIdle();
			throw error;
		}
	}

	async pauseRecording(): Promise<boolean> {
		if (!this.buffer.pause(this.now())) {
			return false;
		}
		this.recordingListeners.clear();
		await this.pendingWorkspaceChanges;
		this.buffer.captureCheckpoint(this.now());
		this.publishState();
		return true;
	}

	resumeRecording(): boolean {
		if (!this.buffer.resume(this.now())) {
			return false;
		}
		// Listeners are recreated because pause intentionally detached every event source.
		this.recordingListeners.value = this.createRecordingListeners(false);
		this.recordActiveResource();
		this.publishState();
		return true;
	}

	async stopRecording(): Promise<ICodeScrimRecordingDraft | undefined> {
		if (!this.buffer.isRecording) {
			return undefined;
		}

		this.recordingListeners.clear();
		this.recordingStatus.clear();
		await this.pendingWorkspaceChanges;
		const draft = this.buffer.stop(this.now());
		if (draft) {
			this._lastDraft = draft;
			this._onDidChangeDraft.fire(draft);
		}
		this.publishState();
		if (draft) {
			// The recorder is already safely idle if persistence fails, and the in-memory draft remains replayable.
			await this.packageService.saveDraft(draft);
		}
		return draft;
	}

	async discardLastDraft(): Promise<boolean> {
		if (this._state.status !== 'idle' || !this._lastDraft) {
			return false;
		}
		await this.packageService.deleteDraft();
		this._lastDraft = undefined;
		this._onDidChangeDraft.fire(undefined);
		return true;
	}

	private async restoreLastDraft(): Promise<void> {
		const draft = await this.packageService.loadDraft();
		if (draft && !this._lastDraft) {
			this._lastDraft = draft;
			this._onDidChangeDraft.fire(draft);
		}
	}

	private createRecordingListeners(captureExistingAsCheckpoint = true): DisposableStore {
		const listeners = new DisposableStore();
		for (const model of this.modelService.getModels()) {
			this.listenToModel(model, listeners, captureExistingAsCheckpoint);
		}
		listeners.add(this.modelService.onModelAdded(model => this.listenToModel(model, listeners, false)));
		listeners.add(this.editorService.onDidActiveEditorChange(() => this.recordActiveResource()));
		for (const editor of this.codeEditorService.listCodeEditors()) {
			this.listenToEditor(editor, listeners);
		}
		listeners.add(this.codeEditorService.onCodeEditorAdd(editor => this.listenToEditor(editor, listeners)));
		listeners.add(this.textFileService.files.onDidSave(event => {
			const resource = this.toWorkspaceResource(event.model.resource);
			if (resource) {
				this.append({
					domain: 'editor',
					kind: 'editor.documentSaved',
					payload: { resource, reason: event.reason },
				});
			}
		}));
		listeners.add(this.fileService.onDidFilesChange(event => {
			this.pendingWorkspaceChanges = this.pendingWorkspaceChanges
				.then(() => this.recordWorkspaceChanges(event));
		}));
		return listeners;
	}

	private listenToModel(model: ITextModel, listeners: DisposableStore, captureCheckpoint: boolean): void {
		const resource = this.toWorkspaceResource(model.uri);
		if (!resource) {
			return;
		}
		if (captureCheckpoint) {
			this.buffer.captureDocument({
				resource,
				languageId: model.getLanguageId(),
				versionId: model.getVersionId(),
				eol: model.getEOL(),
				text: model.getValue(),
			});
		} else {
			const key = CodeScrimRecordingBuffer.resourceKey(resource);
			if (!this.knownWorkspaceResources.has(key)) {
				const content = VSBuffer.fromString(model.getValue());
				this.knownWorkspaceResources.add(key);
				this.append({
					domain: 'workspace',
					kind: 'workspace.entriesChanged',
					payload: {
						deleted: [],
						created: [{
							resource,
							type: 'file',
							size: content.byteLength,
							contents: encodeBase64(content),
							text: true,
						}],
					},
				});
			}
		}
		if (!captureCheckpoint) {
			this.buffer.captureDocument({
				resource,
				languageId: model.getLanguageId(),
				versionId: model.getVersionId(),
				eol: model.getEOL(),
				text: model.getValue(),
			});
		}

		listeners.add(model.onDidChangeContent(event => this.append({
			domain: 'editor',
			kind: 'editor.documentChanged',
			payload: {
				resource,
				languageId: model.getLanguageId(),
				versionId: event.versionId,
				eol: event.eol,
				text: model.getValue(),
				changes: event.changes.map(change => ({
					rangeOffset: change.rangeOffset,
					rangeLength: change.rangeLength,
					text: change.text,
				})),
				undoing: event.isUndoing,
				redoing: event.isRedoing,
			},
		})));
	}

	private listenToEditor(editor: ICodeEditor, listeners: DisposableStore): void {
		listeners.add(editor.onDidChangeCursorSelection(event => {
			if (this.codeEditorService.getActiveCodeEditor() !== editor) {
				return;
			}

			const model = editor.getModel();
			const resource = model && this.toWorkspaceResource(model.uri);
			if (!resource) {
				return;
			}

			const selections: ICodeScrimSelection[] = [event.selection, ...event.secondarySelections].map(selection => ({
				selectionStartLineNumber: selection.selectionStartLineNumber,
				selectionStartColumn: selection.selectionStartColumn,
				positionLineNumber: selection.positionLineNumber,
				positionColumn: selection.positionColumn,
			}));
			this.append({
				domain: 'editor',
				kind: 'editor.selectionChanged',
				payload: { resource, modelVersionId: event.modelVersionId, selections },
			});
		}));
	}

	private recordActiveResource(): void {
		const uri = EditorResourceAccessor.getOriginalUri(this.editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
		this.append({
			domain: 'editor',
			kind: 'editor.activeResourceChanged',
			payload: { resource: uri ? this.toWorkspaceResource(uri) : undefined },
		});
	}

	private append(event: CodeScrimRecordingEventData): void {
		if (!this.buffer.isRecording || this.buffer.isPaused) {
			return;
		}

		this.buffer.append(event, this.now());
		this.publishState();
	}

	private async recordWorkspaceChanges(event: FileChangesEvent): Promise<void> {
		if (!this.buffer.isRecording || this.buffer.isPaused) {
			return;
		}

		const deleted = event.rawDeleted
			.map(resource => this.toWorkspaceResource(resource))
			.filter((resource): resource is ICodeScrimWorkspaceResource => resource !== undefined);
		for (const resource of deleted) {
			const prefix = resource.path ? `${resource.path}/` : '';
			for (const key of [...this.knownWorkspaceResources]) {
				const separator = key.indexOf(':');
				const root = Number(key.slice(0, separator));
				const path = key.slice(separator + 1);
				if (root === resource.root && (path === resource.path || (prefix && path.startsWith(prefix)))) {
					this.knownWorkspaceResources.delete(key);
				}
			}
		}
		const budget = this.createSnapshotBudget();
		const created = new Map<string, ICodeScrimWorkspaceEntryCheckpoint>();
		for (const resource of event.rawAdded) {
			const workspaceResource = this.toWorkspaceResource(resource);
			if (!workspaceResource || this.knownWorkspaceResources.has(CodeScrimRecordingBuffer.resourceKey(workspaceResource))) {
				continue;
			}
			await this.snapshotChangedResource(resource, budget, true, false, created);
		}
		for (const resource of event.rawUpdated) {
			await this.snapshotChangedResource(resource, budget, false, true, created);
		}
		for (let i = 0; i < budget.skippedEntryCount; i++) {
			this.buffer.recordSkippedWorkspaceEntry();
		}

		if (deleted.length || created.size) {
			this.append({
				domain: 'workspace',
				kind: 'workspace.entriesChanged',
				payload: { deleted, created: [...created.values()] },
			});
		}
	}

	private async snapshotChangedResource(resource: URI, budget: ICodeScrimSnapshotBudget, recursive: boolean, replaceExisting: boolean, target: Map<string, ICodeScrimWorkspaceEntryCheckpoint>): Promise<void> {
		if (!this.toWorkspaceResource(resource)) {
			return;
		}
		try {
			const stat = await this.fileService.resolve(resource);
			for (const entry of await this.snapshotEntry(stat, budget, recursive)) {
				const key = CodeScrimRecordingBuffer.resourceKey(entry.resource);
				if (!replaceExisting && this.knownWorkspaceResources.has(key)) {
					continue;
				}
				target.set(key, entry);
				this.knownWorkspaceResources.add(key);
			}
		} catch {
			// A short-lived file can disappear between the watcher event and the snapshot read.
		}
	}

	private async snapshotEntry(stat: IFileStat, budget: ICodeScrimSnapshotBudget, recursive: boolean): Promise<readonly ICodeScrimWorkspaceEntryCheckpoint[]> {
		const resource = this.toWorkspaceResource(stat.resource);
		if (!resource || stat.isSymbolicLink || budget.entryCount >= MAX_CHECKPOINT_ENTRY_COUNT) {
			budget.skippedEntryCount++;
			return [];
		}

		if (stat.isDirectory) {
			if (EXCLUDED_CHECKPOINT_DIRECTORIES.has(stat.name.toLowerCase())) {
				budget.skippedEntryCount++;
				return [];
			}
			budget.entryCount++;
			const entries: ICodeScrimWorkspaceEntryCheckpoint[] = [{ resource, type: 'directory', text: false }];
			if (recursive) {
				const resolved = stat.children ? stat : await this.fileService.resolve(stat.resource);
				for (const child of resolved.children ?? []) {
					entries.push(...await this.snapshotEntry(child, budget, true));
				}
			}
			return entries;
		}

		if (!stat.isFile || (typeof stat.size === 'number' && stat.size > MAX_CHECKPOINT_FILE_SIZE) || budget.totalSize >= MAX_CHECKPOINT_TOTAL_SIZE) {
			budget.skippedEntryCount++;
			return [];
		}

		try {
			const content = await this.fileService.readFile(stat.resource, { atomic: true, limits: { size: MAX_CHECKPOINT_FILE_SIZE } });
			if (budget.totalSize + content.value.byteLength > MAX_CHECKPOINT_TOTAL_SIZE) {
				budget.skippedEntryCount++;
				return [];
			}
			budget.entryCount++;
			budget.totalSize += content.value.byteLength;
			return [{
				resource,
				type: 'file',
				size: content.value.byteLength,
				contents: encodeBase64(content.value),
				text: this.isProbablyText(content.value),
			}];
		} catch {
			budget.skippedEntryCount++;
			return [];
		}
	}

	private createSnapshotBudget(): ICodeScrimSnapshotBudget {
		return { entryCount: 0, totalSize: 0, skippedEntryCount: 0 };
	}

	private isProbablyText(buffer: VSBuffer): boolean {
		const length = Math.min(buffer.byteLength, 8192);
		for (let i = 0; i < length; i++) {
			if (buffer.buffer[i] === 0) {
				return false;
			}
		}
		return true;
	}

	private toWorkspaceResource(resource: URI): ICodeScrimWorkspaceResource | undefined {
		const folder = this.workspaceContextService.getWorkspaceFolder(resource);
		if (!folder) {
			return undefined;
		}

		const path = this.uriIdentityService.extUri.relativePath(folder.uri, resource);
		if (path === undefined) {
			return undefined;
		}

		return Object.freeze({ root: folder.index, path: path.replace(/\\/g, '/') });
	}

	private publishState(): void {
		const draftId = this.buffer.activeDraftId;
		this._state = draftId
			? Object.freeze({
				status: this.buffer.isPaused ? 'paused' : 'recording',
				draftId,
				eventCount: this.buffer.eventCount,
				checkpointEntryCount: this.buffer.checkpointEntryCount,
				skippedEntryCount: this.buffer.skippedEntryCount,
			})
			: Object.freeze({ status: 'idle' });
		this.syncStatusbar();
		this._onDidChangeState.fire(this._state);
	}

	private publishPreparing(): void {
		this._state = Object.freeze({ status: 'preparing' });
		this.syncStatusbar();
		this._onDidChangeState.fire(this._state);
	}

	private publishIdle(): void {
		this._state = Object.freeze({ status: 'idle' });
		this.syncStatusbar();
		this._onDidChangeState.fire(this._state);
	}

	private syncStatusbar(): void {
		if (this._state.status === 'idle') {
			this.recordingStatus.clear();
			this.stopRecordingStatus.clear();
			return;
		}

		if (this._state.status === 'preparing') {
			const entry = {
				name: localize('codeScrim.preparingRecordingStatusName', "CodeScrim Recording"),
				text: '$(loading~spin) ' + localize('codeScrim.preparingRecordingStatusText', "Preparing workspace snapshot"),
				ariaLabel: localize('codeScrim.preparingRecordingStatusAriaLabel', "CodeScrim is preparing an immutable workspace snapshot."),
				tooltip: localize('codeScrim.preparingRecordingTooltip', "Preparing CodeScrim recording"),
			};
			if (this.recordingStatus.value) {
				this.recordingStatus.value.update(entry);
			} else {
				this.recordingStatus.value = this.statusbarService.addEntry(entry, 'status.codescrimRecording', StatusbarAlignment.RIGHT, 100);
			}
			this.stopRecordingStatus.clear();
			return;
		}

		const paused = this._state.status === 'paused';
		const entry = {
			name: localize('codeScrim.recordingStatusName', "CodeScrim Recording"),
			text: paused
				? '$(debug-continue) ' + localize('codeScrim.pausedStatusText', "Resume recording - {0} events", this._state.eventCount)
				: '$(debug-pause) ' + localize('codeScrim.recordingStatusText', "Pause recording - {0} events", this._state.eventCount),
			ariaLabel: paused
				? localize('codeScrim.pausedStatusAriaLabel', "CodeScrim recording paused with {0} events. Click to resume.", this._state.eventCount)
				: localize('codeScrim.recordingStatusAriaLabel', "CodeScrim is recording. {0} events captured. Click to pause.", this._state.eventCount),
			tooltip: paused ? localize('codeScrim.resumeRecordingTooltip', "Resume recording") : localize('codeScrim.pauseRecordingTooltip', "Pause recording"),
			kind: paused ? undefined : 'error' as const,
			command: paused ? CODE_SCRIM_RESUME_RECORDING_COMMAND_ID : CODE_SCRIM_PAUSE_RECORDING_COMMAND_ID,
		};
		if (this.recordingStatus.value) {
			this.recordingStatus.value.update(entry);
		} else {
			this.recordingStatus.value = this.statusbarService.addEntry(entry, 'status.codescrimRecording', StatusbarAlignment.RIGHT, 100);
		}

		const stopEntry = {
			name: localize('codeScrim.stopRecordingStatusName', "CodeScrim Stop Recording"),
			text: '$(debug-stop) ' + localize('codeScrim.stopRecordingStatusText', "Stop"),
			ariaLabel: localize('codeScrim.stopRecordingStatusAriaLabel', "Stop and keep the CodeScrim recording"),
			tooltip: localize('codeScrim.stopRecordingTooltip', "Stop and keep recording"),
			command: CODE_SCRIM_STOP_RECORDING_COMMAND_ID,
		};
		if (this.stopRecordingStatus.value) {
			this.stopRecordingStatus.value.update(stopEntry);
		} else {
			this.stopRecordingStatus.value = this.statusbarService.addEntry(stopEntry, 'status.codescrimStopRecording', StatusbarAlignment.RIGHT, 99);
		}
	}

	private now(): number {
		return mainWindow.performance.now();
	}
}
