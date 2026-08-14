/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, extname, joinPath } from '../../../../base/common/resources.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';
import { CODE_SCRIM_OPEN_RECORDING_COMMAND_ID, CODE_SCRIM_PACKAGE_EXTENSION, CODE_SCRIM_SAVE_RECORDING_COMMAND_ID, ICodeScrimPackageService } from '../common/codeScrimPackage.js';
import { CODE_SCRIM_DISCARD_RECORDING_COMMAND_ID, CODE_SCRIM_PAUSE_RECORDING_COMMAND_ID, CODE_SCRIM_RESUME_RECORDING_COMMAND_ID, CODE_SCRIM_START_RECORDING_COMMAND_ID, CODE_SCRIM_STOP_RECORDING_COMMAND_ID, ICodeScrimRecorderService, ICodeScrimRecordingDraft } from '../common/codeScrimRecording.js';
import { CODE_SCRIM_REPLAY_LAST_RECORDING_COMMAND_ID, CODE_SCRIM_RESTART_REPLAY_COMMAND_ID, CODE_SCRIM_RESUME_REPLAY_COMMAND_ID, CODE_SCRIM_STOP_REPLAY_COMMAND_ID, ICodeScrimReplayService } from '../common/codeScrimReplay.js';
import { CODE_SCRIM_OPEN_COURSE_HOME_COMMAND_ID, CODE_SCRIM_OPEN_DEMO_LESSON_COMMAND_ID, ICodeScrimLayoutService, ICodeScrimLessonDescriptor, ICodeScrimSessionService } from '../common/codeScrimSession.js';
import { CodeScrimCourseEditor } from './codeScrimCourseEditor.js';
import { CodeScrimCourseEditorInput } from './codeScrimCourseEditorInput.js';
import { CodeScrimAuthoringDockContribution } from './codeScrimAuthoringDock.js';
import { CodeScrimLayoutService } from './codeScrimLayoutService.js';
import { CodeScrimLessonEditor } from './codeScrimLessonEditor.js';
import { CodeScrimLessonEditorInput } from './codeScrimLessonEditorInput.js';
import { CodeScrimPackageService } from './codeScrimPackageService.js';
import { CodeScrimRecorderService } from './codeScrimRecorderService.js';
import { CodeScrimReplayService } from './codeScrimReplayService.js';
import { CodeScrimSessionService } from './codeScrimSessionService.js';

registerSingleton(ICodeScrimSessionService, CodeScrimSessionService, InstantiationType.Delayed);
registerSingleton(ICodeScrimLayoutService, CodeScrimLayoutService, InstantiationType.Delayed);
registerSingleton(ICodeScrimPackageService, CodeScrimPackageService, InstantiationType.Delayed);
registerSingleton(ICodeScrimRecorderService, CodeScrimRecorderService, InstantiationType.Eager);
registerSingleton(ICodeScrimReplayService, CodeScrimReplayService, InstantiationType.Delayed);

class CodeScrimRecordingControlsContribution {

	static readonly ID = 'workbench.contrib.codeScrimRecordingControls';

	constructor(
		@ICodeScrimRecorderService recorderService: ICodeScrimRecorderService,
	) {
		// Resolve the recorder after workbench restoration so its native controls and listeners are
		// available without requiring the command palette to instantiate the service first.
		void recorderService.initialize();
	}
}

registerWorkbenchContribution2(CodeScrimRecordingControlsContribution.ID, CodeScrimRecordingControlsContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(CodeScrimAuthoringDockContribution.ID, CodeScrimAuthoringDockContribution, WorkbenchPhase.AfterRestored);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		CodeScrimCourseEditor,
		CodeScrimCourseEditor.ID,
		localize('codeScrim.courseEditor', "CodeScrim Course Home")
	),
	[
		new SyncDescriptor(CodeScrimCourseEditorInput)
	]
);

class CodeScrimCourseEditorInputSerializer implements IEditorSerializer {

	canSerialize(input: EditorInput): boolean {
		return input instanceof CodeScrimCourseEditorInput;
	}

	serialize(): string {
		return '';
	}

	deserialize(instantiationService: IInstantiationService): CodeScrimCourseEditorInput {
		return instantiationService.createInstance(CodeScrimCourseEditorInput);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	CodeScrimCourseEditorInput.ID,
	CodeScrimCourseEditorInputSerializer
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		CodeScrimLessonEditor,
		CodeScrimLessonEditor.ID,
		localize('codeScrim.lessonEditor', "CodeScrim Lesson")
	),
	[
		new SyncDescriptor(CodeScrimLessonEditorInput)
	]
);

class CodeScrimLessonEditorInputSerializer implements IEditorSerializer {

	canSerialize(input: EditorInput): input is CodeScrimLessonEditorInput {
		return input instanceof CodeScrimLessonEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		if (!this.canSerialize(input)) {
			return undefined;
		}

		return JSON.stringify(input.lesson);
	}

	deserialize(instantiationService: IInstantiationService, serializedEditor: string): CodeScrimLessonEditorInput | undefined {
		const lesson = parseLessonDescriptor(serializedEditor);
		return lesson ? instantiationService.createInstance(CodeScrimLessonEditorInput, lesson) : undefined;
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	CodeScrimLessonEditorInput.ID,
	CodeScrimLessonEditorInputSerializer
);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.codeScrim.toggleLearnerTerminal',
			title: localize2('codeScrim.toggleLearnerTerminal', "Toggle Terminal"),
			icon: Codicon.terminal,
			toggled: TerminalContextKeys.viewShowing,
			f1: false,
			menu: {
				id: MenuId.TitleBar,
				group: 'navigation',
				order: 9000,
				when: ActiveEditorContext.isEqualTo(CodeScrimLessonEditorInput.EDITOR_ID),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const activeEditorPane = accessor.get(IEditorService).activeEditorPane;
		if (activeEditorPane instanceof CodeScrimLessonEditor) {
			await activeEditorPane.toggleTerminalPanel();
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CODE_SCRIM_OPEN_COURSE_HOME_COMMAND_ID,
			title: localize2('codeScrim.openCourseHome', "Open CodeScrim"),
			category: localize2('codeScrim.category', "CodeScrim"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<boolean> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		const input = instantiationService.createInstance(CodeScrimCourseEditorInput);
		await editorService.openEditor(input, { pinned: true });
		return true;
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CODE_SCRIM_SAVE_RECORDING_COMMAND_ID,
			title: localize2('codeScrim.saveRecording', "Save Recording"),
			category: localize2('codeScrim.category', "CodeScrim"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<boolean> {
		const recorderService = accessor.get(ICodeScrimRecorderService);
		const packageService = accessor.get(ICodeScrimPackageService);
		const fileDialogService = accessor.get(IFileDialogService);
		const notificationService = accessor.get(INotificationService);
		await recorderService.initialize();
		const draft = recorderService.lastDraft;
		if (!draft) {
			notificationService.info(localize('codeScrim.noRecordingToSave', "Record and stop a CodeScrim session before saving it."));
			return false;
		}

		const defaultFolder = await fileDialogService.defaultFilePath(Schemas.file);
		let resource = await fileDialogService.showSaveDialog({
			forceNative: true,
			title: localize('codeScrim.saveRecordingDialogTitle', "Save CodeScrim Recording"),
			saveLabel: localize('codeScrim.saveRecordingDialogLabel', "Save Recording"),
			defaultUri: joinPath(defaultFolder, `recording-${draft.id.slice(0, 8)}.${CODE_SCRIM_PACKAGE_EXTENSION}`),
			filters: [{ name: localize('codeScrim.packageFileFilter', "CodeScrim Recording"), extensions: [CODE_SCRIM_PACKAGE_EXTENSION] }],
			availableFileSystems: [Schemas.file],
		});
		if (!resource) {
			return false;
		}
		if (extname(resource).toLowerCase() !== `.${CODE_SCRIM_PACKAGE_EXTENSION}`) {
			resource = resource.with({ path: `${resource.path}.${CODE_SCRIM_PACKAGE_EXTENSION}` });
		}

		await packageService.savePackage(resource, draft);
		notificationService.info(localize('codeScrim.recordingSaved', "CodeScrim recording saved as {0}.", basename(resource)));
		return true;
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CODE_SCRIM_OPEN_RECORDING_COMMAND_ID,
			title: localize2('codeScrim.openRecording', "Open Recording"),
			category: localize2('codeScrim.category', "CodeScrim"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const recorderService = accessor.get(ICodeScrimRecorderService);
		const packageService = accessor.get(ICodeScrimPackageService);
		const fileDialogService = accessor.get(IFileDialogService);
		const notificationService = accessor.get(INotificationService);
		if (recorderService.state.status !== 'idle') {
			notificationService.info(localize('codeScrim.stopRecordingBeforeOpen', "Stop the active CodeScrim recording before opening another recording."));
			return;
		}

		const resources = await fileDialogService.showOpenDialog({
			forceNative: true,
			title: localize('codeScrim.openRecordingDialogTitle', "Open CodeScrim Recording"),
			openLabel: localize('codeScrim.openRecordingDialogLabel', "Open Recording"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: [{ name: localize('codeScrim.packageFileFilter', "CodeScrim Recording"), extensions: [CODE_SCRIM_PACKAGE_EXTENSION] }],
			availableFileSystems: [Schemas.file],
		});
		const resource = resources?.[0];
		if (!resource) {
			return;
		}

		try {
			const draft = await packageService.openPackage(resource);
			// Opening a package establishes the current authoring context, so the same verified
			// recording must be available after restart rather than an older recovery draft.
			await packageService.saveDraft(draft);
			recorderService.setLastDraft(draft);
			notificationService.info(localize('codeScrim.recordingOpened', "Opened and verified CodeScrim recording {0}. It is ready to replay.", basename(resource)));
		} catch (error) {
			notificationService.error(error);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CODE_SCRIM_REPLAY_LAST_RECORDING_COMMAND_ID,
			title: localize2('codeScrim.replayLastRecording', "Replay Last Recording"),
			category: localize2('codeScrim.category', "CodeScrim"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const recorderService = accessor.get(ICodeScrimRecorderService);
		const replayService = accessor.get(ICodeScrimReplayService);
		const notificationService = accessor.get(INotificationService);
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		await recorderService.initialize();
		if (recorderService.state.status !== 'idle') {
			notificationService.info(localize('codeScrim.stopRecordingBeforeReplay', "Stop the active CodeScrim recording before replaying it."));
			return;
		}

		const draft = recorderService.lastDraft;
		if (!draft) {
			notificationService.info(localize('codeScrim.noRecordingToReplay', "Record and stop a CodeScrim session before replaying it."));
			return;
		}

		await openRecordingPreview(editorService, instantiationService, draft);
		if (await replayService.replay(draft)) {
			notificationService.info(localize('codeScrim.replayStarted', "Replaying the last CodeScrim recording in isolated editor models."));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CODE_SCRIM_STOP_REPLAY_COMMAND_ID,
			title: localize2('codeScrim.stopReplay', "Stop Replay"),
			category: localize2('codeScrim.category', "CodeScrim"),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(ICodeScrimReplayService).stop();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CODE_SCRIM_RESUME_REPLAY_COMMAND_ID,
			title: localize2('codeScrim.resumeReplay', "Resume Replay"),
			category: localize2('codeScrim.category', "CodeScrim"),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(ICodeScrimReplayService).resume();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CODE_SCRIM_RESTART_REPLAY_COMMAND_ID,
			title: localize2('codeScrim.restartReplay', "Restart Replay"),
			category: localize2('codeScrim.category', "CodeScrim"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const replayService = accessor.get(ICodeScrimReplayService);
		const notificationService = accessor.get(INotificationService);
		const restarted = await replayService.restart();
		if (!restarted) {
			notificationService.info(localize('codeScrim.noReplayToRestart', "There is no CodeScrim replay to restart."));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CODE_SCRIM_START_RECORDING_COMMAND_ID,
			title: localize2('codeScrim.startRecording', "Start Recording"),
			category: localize2('codeScrim.category', "CodeScrim"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const recorderService = accessor.get(ICodeScrimRecorderService);
		const replayService = accessor.get(ICodeScrimReplayService);
		const notificationService = accessor.get(INotificationService);
		const dialogService = accessor.get(IDialogService);
		const commandService = accessor.get(ICommandService);
		if (replayService.state.status !== 'idle') {
			notificationService.info(localize('codeScrim.stopReplayBeforeRecording', "Stop the active CodeScrim replay before starting a recording."));
			return;
		}
		await recorderService.initialize();
		if (recorderService.lastDraft) {
			const { result } = await dialogService.prompt({
				type: 'info',
				message: localize('codeScrim.replaceDraftPrompt', "A recording is already ready. What should CodeScrim do before starting a new one?"),
				detail: localize('codeScrim.replaceDraftDetail', "Saving exports a named .scrim package. Discarding removes the restart-recovery copy."),
				buttons: [
					{ label: localize('codeScrim.saveThenRecord', "Save, then Record"), run: () => 'save' as const },
					{ label: localize('codeScrim.discardThenRecord', "Discard and Record"), run: () => 'discard' as const },
				],
				cancelButton: true,
			});
			if (result === 'save') {
				if (!await commandService.executeCommand<boolean>(CODE_SCRIM_SAVE_RECORDING_COMMAND_ID)) {
					return;
				}
			} else if (result === 'discard') {
				await recorderService.discardLastDraft();
			} else {
				return;
			}
		}
		let started = false;
		try {
			started = await recorderService.startRecording();
		} catch (error) {
			notificationService.error(error);
			return;
		}
		if (started) {
			const state = recorderService.state;
			if (state.status === 'recording') {
				notificationService.info(localize('codeScrim.recordingStartedWithSnapshot', "CodeScrim recording started with {0} workspace entries in its immutable checkpoint. {1} entries were skipped by safety limits.", state.checkpointEntryCount, state.skippedEntryCount));
			}
		} else {
			notificationService.info(localize('codeScrim.recordingAlreadyActive', "A CodeScrim recording is already active."));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: CODE_SCRIM_PAUSE_RECORDING_COMMAND_ID, title: localize2('codeScrim.pauseRecording', "Pause Recording"), category: localize2('codeScrim.category', "CodeScrim"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICodeScrimRecorderService).pauseRecording();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: CODE_SCRIM_RESUME_RECORDING_COMMAND_ID, title: localize2('codeScrim.resumeRecording', "Resume Recording"), category: localize2('codeScrim.category', "CodeScrim"), f1: true });
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(ICodeScrimRecorderService).resumeRecording();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: CODE_SCRIM_DISCARD_RECORDING_COMMAND_ID, title: localize2('codeScrim.discardRecording', "Discard Current Recording"), category: localize2('codeScrim.category', "CodeScrim"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const recorderService = accessor.get(ICodeScrimRecorderService);
		const notificationService = accessor.get(INotificationService);
		const dialogService = accessor.get(IDialogService);
		await recorderService.initialize();
		if (!recorderService.lastDraft) {
			notificationService.info(localize('codeScrim.noRecordingToDiscard', "There is no CodeScrim recording to discard."));
			return;
		}
		const confirmed = await dialogService.confirm({
			type: 'warning',
			message: localize('codeScrim.discardRecordingConfirm', "Discard the current CodeScrim recording?"),
			detail: localize('codeScrim.discardRecordingDetail', "This removes the local restart-recovery copy. Exported .scrim files are not affected."),
			primaryButton: localize('codeScrim.discardRecordingButton', "Discard Recording"),
		});
		if (confirmed.confirmed && await recorderService.discardLastDraft()) {
			notificationService.info(localize('codeScrim.recordingDiscarded', "CodeScrim recording discarded."));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CODE_SCRIM_STOP_RECORDING_COMMAND_ID,
			title: localize2('codeScrim.stopRecording', "Stop Recording"),
			category: localize2('codeScrim.category', "CodeScrim"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const recorderService = accessor.get(ICodeScrimRecorderService);
		const notificationService = accessor.get(INotificationService);
		const draft = await recorderService.stopRecording();
		if (draft) {
			notificationService.info(localize('codeScrim.recordingStopped', "CodeScrim recording stopped with {0} events.", draft.events.length));
		} else {
			notificationService.info(localize('codeScrim.noActiveRecording', "There is no active CodeScrim recording."));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CODE_SCRIM_OPEN_DEMO_LESSON_COMMAND_ID,
			title: localize2('codeScrim.openDemoLesson', "Open Demo Lesson"),
			category: localize2('codeScrim.category', "CodeScrim"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		const lesson: ICodeScrimLessonDescriptor = {
			id: 'native-session-foundations',
			title: localize('codeScrim.demoLessonTitle', "Native Session Foundations"),
			description: localize('codeScrim.demoLessonDescription', "A first native CodeScrim lesson surface for exercising deterministic playback inside the editor area."),
			duration: 3 * 60 * 1000,
		};
		const input = instantiationService.createInstance(CodeScrimLessonEditorInput, lesson);
		await editorService.openEditor(input, { pinned: true });
	}
});

async function openRecordingPreview(editorService: IEditorService, instantiationService: IInstantiationService, draft: ICodeScrimRecordingDraft): Promise<void> {
	const previewLesson: ICodeScrimLessonDescriptor = {
		id: `recording-preview-${draft.id}`,
		title: localize('codeScrim.recordingPreviewTitle', "Recording Preview"),
		description: localize('codeScrim.recordingPreviewDescription', "Preview this recording through the learner lesson experience."),
		duration: Math.ceil(draft.duration / 1000),
	};
	await editorService.openEditor(instantiationService.createInstance(CodeScrimLessonEditorInput, previewLesson), { pinned: true });
}

function parseLessonDescriptor(serializedEditor: string): ICodeScrimLessonDescriptor | undefined {
	try {
		const candidate: unknown = JSON.parse(serializedEditor);
		if (!candidate || typeof candidate !== 'object') {
			return undefined;
		}

		const lesson = candidate as { id?: unknown; title?: unknown; description?: unknown; duration?: unknown };
		if (typeof lesson.id !== 'string' || lesson.id.length === 0 ||
			typeof lesson.title !== 'string' || lesson.title.length === 0 ||
			typeof lesson.duration !== 'number' || !Number.isFinite(lesson.duration) || lesson.duration < 0 ||
			(lesson.description !== undefined && typeof lesson.description !== 'string')) {
			return undefined;
		}

		return {
			id: lesson.id,
			title: lesson.title,
			description: lesson.description,
			duration: lesson.duration,
		};
	} catch {
		return undefined;
	}
}
