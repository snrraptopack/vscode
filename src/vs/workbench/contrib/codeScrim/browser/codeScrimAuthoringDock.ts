/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/codeScrimAuthoringDock.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { CODE_SCRIM_OPEN_RECORDING_COMMAND_ID, CODE_SCRIM_SAVE_RECORDING_COMMAND_ID } from '../common/codeScrimPackage.js';
import { CODE_SCRIM_DISCARD_RECORDING_COMMAND_ID, CODE_SCRIM_PAUSE_RECORDING_COMMAND_ID, CODE_SCRIM_RESUME_RECORDING_COMMAND_ID, CODE_SCRIM_START_RECORDING_COMMAND_ID, CODE_SCRIM_STOP_RECORDING_COMMAND_ID, ICodeScrimRecorderService } from '../common/codeScrimRecording.js';
import { CODE_SCRIM_REPLAY_LAST_RECORDING_COMMAND_ID } from '../common/codeScrimReplay.js';
import { ICodeScrimSessionService } from '../common/codeScrimSession.js';

/** A CodeScrim-owned authoring dock that does not participate in VS Code's extension view system. */
export class CodeScrimAuthoringDockContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.codeScrimAuthoringDock';

	private readonly shell: HTMLElement;
	private readonly panel: HTMLElement;
	private readonly launcher: HTMLButtonElement;
	private readonly content: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());
	private expanded = false;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@ICodeScrimRecorderService private readonly recorderService: ICodeScrimRecorderService,
		@ICodeScrimSessionService private readonly sessionService: ICodeScrimSessionService,
	) {
		super();

		// Anchor inside the editor part so the launcher follows the coding canvas instead of
		// covering global Activity Bar controls when side bars are shown or resized.
		const editorContainer = layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
		if (!editorContainer) {
			throw new Error('CodeScrim requires the workbench editor container.');
		}
		this.shell = DOM.append(editorContainer, DOM.$('.codescrim-authoring-shell'));
		this.panel = DOM.append(this.shell, DOM.$('.codescrim-authoring-dock', {
			role: 'dialog',
			'aria-label': localize('codeScrim.authoringDockLabel', "CodeScrim recording controls"),
		}));
		this.content = DOM.append(this.panel, DOM.$('.codescrim-authoring-content'));
		this.launcher = DOM.append(this.shell, DOM.$('button.codescrim-authoring-launcher', {
			type: 'button',
			'aria-expanded': 'false',
			'aria-label': localize('codeScrim.openAuthoringDock', "Open CodeScrim recording controls"),
			title: localize('codeScrim.openAuthoringDock', "Open CodeScrim recording controls"),
		}));
		DOM.append(this.launcher, DOM.$(`span.${ThemeIcon.asClassName(Codicon.playCircle).replace(/ /g, '.')}`));

		this._register(DOM.addDisposableListener(this.launcher, DOM.EventType.CLICK, () => this.toggle()));
		this._register(this.recorderService.onDidChangeState(() => this.render()));
		this._register(this.recorderService.onDidChangeDraft(() => this.render()));
		this._register(this.sessionService.onDidChangeState(() => this.updateVisibility()));

		this.updateVisibility();
		this.render();
		void this.recorderService.initialize().finally(() => this.render());
	}

	private toggle(): void {
		this.expanded = !this.expanded;
		this.panel.hidden = !this.expanded;
		this.launcher.setAttribute('aria-expanded', String(this.expanded));
		this.launcher.setAttribute('aria-label', this.expanded
			? localize('codeScrim.closeAuthoringDock', "Close CodeScrim recording controls")
			: localize('codeScrim.openAuthoringDock', "Open CodeScrim recording controls"));
	}

	private updateVisibility(): void {
		// The learner workbench owns the entire editor canvas while a lesson is open.
		this.shell.hidden = this.sessionService.state !== undefined;
	}

	private render(): void {
		this.renderDisposables.clear();
		DOM.clearNode(this.content);

		const state = this.recorderService.state;
		const draft = this.recorderService.lastDraft;
		const live = state.status !== 'idle';
		this.shell.classList.toggle('recording', state.status === 'recording' || state.status === 'preparing');
		this.shell.classList.toggle('paused', state.status === 'paused');
		this.shell.classList.toggle('has-draft', !!draft && !live);

		const header = DOM.append(this.content, DOM.$('.codescrim-authoring-header'));
		const identity = DOM.append(header, DOM.$('.codescrim-authoring-identity'));
		DOM.append(identity, DOM.$(`span.${ThemeIcon.asClassName(Codicon.playCircle).replace(/ /g, '.')}`));
		const title = DOM.append(identity, DOM.$('.codescrim-authoring-title'));
		DOM.append(title, DOM.$('strong', undefined, localize('codeScrim.productName', "CodeScrim")));
		DOM.append(title, DOM.$('span', undefined, localize('codeScrim.creatorStudio', "Creator Studio")));

		const status = DOM.append(this.content, DOM.$('.codescrim-authoring-status'));
		DOM.append(status, DOM.$('span.codescrim-authoring-status-dot'));
		const statusText = DOM.append(status, DOM.$('.codescrim-authoring-status-copy'));
		DOM.append(statusText, DOM.$('strong', undefined, this.getStateLabel()));
		DOM.append(statusText, DOM.$('span', undefined, this.getStateDetail()));

		const primary = this.addButton(this.content,
			state.status === 'recording'
				? `$(debug-pause) ${localize('codeScrim.pauseRecordingButton', "Pause recording")}`
				: state.status === 'paused'
					? `$(debug-continue) ${localize('codeScrim.resumeRecordingButton', "Resume recording")}`
					: state.status === 'preparing'
						? `$(loading~spin) ${localize('codeScrim.preparingRecordingButton', "Preparing recording")}`
						: `$(record) ${localize('codeScrim.startRecordingButton', "Start recording")}`,
			state.status === 'recording'
				? CODE_SCRIM_PAUSE_RECORDING_COMMAND_ID
				: state.status === 'paused'
					? CODE_SCRIM_RESUME_RECORDING_COMMAND_ID
					: CODE_SCRIM_START_RECORDING_COMMAND_ID);
		primary.enabled = state.status !== 'preparing';
		if (state.status === 'recording' || state.status === 'paused') {
			this.addButton(this.content, `$(debug-stop) ${localize('codeScrim.stopRecordingButton', "Stop and keep draft")}`, CODE_SCRIM_STOP_RECORDING_COMMAND_ID, true);
		}

		DOM.append(this.content, DOM.$('.codescrim-authoring-divider'));
		const actions = DOM.append(this.content, DOM.$('.codescrim-authoring-action-grid'));
		const replay = this.addButton(actions, `$(play) ${localize('codeScrim.replayRecordingButton', "Replay")}`, CODE_SCRIM_REPLAY_LAST_RECORDING_COMMAND_ID, true);
		const save = this.addButton(actions, `$(save-as) ${localize('codeScrim.saveRecordingButton', "Save as...")}`, CODE_SCRIM_SAVE_RECORDING_COMMAND_ID, true);
		replay.enabled = save.enabled = !!draft && !live;

		const openButton = this.addButton(this.content, `$(folder-opened) ${localize('codeScrim.openRecordingButton', "Open recording...")}`, CODE_SCRIM_OPEN_RECORDING_COMMAND_ID, true);
		openButton.enabled = !live;
		const discard = this.addButton(this.content, `$(trash) ${localize('codeScrim.discardRecordingButton', "Discard current recording")}`, CODE_SCRIM_DISCARD_RECORDING_COMMAND_ID, true, 'danger');
		discard.enabled = !!draft && !live;
	}

	private addButton(parent: HTMLElement, label: string, command: string, secondary = false, className?: string): Button {
		const button = this.renderDisposables.add(new Button(parent, { ...defaultButtonStyles, secondary, supportIcons: true }));
		button.label = label;
		button.element.classList.add('codescrim-authoring-button');
		if (className) {
			button.element.classList.add(`codescrim-${className}-button`);
		}
		this.renderDisposables.add(button.onDidClick(() => this.commandService.executeCommand(command)));
		return button;
	}

	private getStateLabel(): string {
		switch (this.recorderService.state.status) {
			case 'preparing': return localize('codeScrim.preparingRecordingLabel', "Preparing workspace snapshot");
			case 'recording': return localize('codeScrim.recordingLabel', "Recording in progress");
			case 'paused': return localize('codeScrim.pausedRecordingLabel', "Recording paused");
			case 'idle': return this.recorderService.lastDraft
				? localize('codeScrim.draftReadyLabel', "Recording ready")
				: localize('codeScrim.readyLabel', "Ready to record");
		}
	}

	private getStateDetail(): string {
		const state = this.recorderService.state;
		if (state.status === 'recording' || state.status === 'paused') {
			return localize('codeScrim.liveRecordingDetail', "{0} events - {1} workspace files", state.eventCount, state.checkpointEntryCount);
		}
		if (state.status === 'preparing') {
			return localize('codeScrim.preparingRecordingDetail', "Preparing the workspace checkpoint.");
		}
		const draft = this.recorderService.lastDraft;
		return draft
			? localize('codeScrim.draftDetail', "{0} events ready to replay or save", draft.events.length)
			: localize('codeScrim.noDraftDetail', "Capture the real editor, files, and selections.");
	}

	override dispose(): void {
		this.shell.remove();
		super.dispose();
	}
}
