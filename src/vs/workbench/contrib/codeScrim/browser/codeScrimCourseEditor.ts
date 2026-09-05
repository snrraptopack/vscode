/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/codeScrimCourseEditor.css';
import { $, append, clearNode, Dimension, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { extractEditorsDropData } from '../../../../platform/dnd/browser/dnd.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorsOrder, IEditorOpenContext } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CodeScrimLessonEditorInput } from './codeScrimLessonEditorInput.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ICodeScrimLayoutService } from '../common/codeScrimSession.js';
import { CODE_SCRIM_OPEN_RECORDING_COMMAND_ID } from '../common/codeScrimPackage.js';
import { CodeScrimCourseEditorInput } from './codeScrimCourseEditorInput.js';

export class CodeScrimCourseEditor extends EditorPane {

	static readonly ID = CodeScrimCourseEditorInput.EDITOR_ID;
	private root: HTMLElement | undefined;
	private firstAction: HTMLElement | undefined;
	private page: 'home' | 'learn' = 'home';
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly layoutLease = this._register(new MutableDisposable<IDisposable>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@ICodeScrimLayoutService private readonly layoutService: ICodeScrimLayoutService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(CodeScrimCourseEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.codescrim-course-editor', { 'aria-label': localize('codeScrim.homeLabel', "CodeScrim home") }));
		this.render();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.layoutLease.value = visible ? this.layoutService.enterCodeScrimMode() : undefined;
	}

	override async setInput(input: CodeScrimCourseEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.page = 'home';
		this.render();
	}

	override focus(): void {
		super.focus();
		this.firstAction?.focus();
	}

	override layout(dimension: Dimension): void {
		if (this.root) {
			this.root.style.width = `${dimension.width}px`;
			this.root.style.height = `${dimension.height}px`;
		}
	}

	private render(): void {
		if (!this.root) {
			return;
		}
		this.renderDisposables.clear();
		clearNode(this.root);
		this.firstAction = undefined;
		const shell = append(this.root, $('main.codescrim-course-shell'));
		append(shell, $('p.codescrim-course-brand', undefined, 'CodeScrim'));
		append(shell, $('h1', undefined, this.page === 'home'
			? localize('codeScrim.homeTitle', "Step into a development session.")
			: localize('codeScrim.learnTitle', "Your next lesson starts here.")));
		append(shell, $('p.codescrim-course-intro', undefined, this.page === 'home'
			? localize('codeScrim.homeIntro', "Learn by doing. Teach by creating.")
			: localize('codeScrim.learnIntro', "Open a scrim, follow along, and make it your own.")));

		if (this.page === 'home') {
			const cards = append(shell, $('.codescrim-home-cards'));
			this.addCard(cards, 'learn', localize('codeScrim.learn', "Learn"), localize('codeScrim.learnCard', "Follow a lesson. Pause and experiment with real code."), () => {
				this.page = 'learn';
				this.render();
				this.focus();
			});
			this.addCard(cards, 'record', localize('codeScrim.record', "Record"), localize('codeScrim.recordCard', "Open your workspace and turn your workflow into a lesson."), () => void this.enterRecordingWorkspace());
		} else {
			const dropZone = append(shell, $('section.codescrim-learn-drop'));
			const open = append(dropZone, $('button.codescrim-home-open', { type: 'button' }, localize('codeScrim.openScrim', "Open Scrim")));
			this.firstAction = open;
			append(dropZone, $('p', undefined, localize('codeScrim.dropScrim', "or drop a .scrim file here")));
			this.renderDisposables.add(addDisposableListener(open, EventType.CLICK, () => void this.commandService.executeCommand(CODE_SCRIM_OPEN_RECORDING_COMMAND_ID, undefined, true)));
			this.renderDisposables.add(addDisposableListener(dropZone, EventType.DRAG_OVER, event => {
				event.preventDefault();
				event.stopPropagation();
				if (event.dataTransfer) {
					event.dataTransfer.dropEffect = 'copy';
				}
				dropZone.classList.add('drag-over');
			}));
			this.renderDisposables.add(addDisposableListener(dropZone, EventType.DRAG_LEAVE, () => dropZone.classList.remove('drag-over')));
			this.renderDisposables.add(addDisposableListener(dropZone, EventType.DROP, event => {
				event.preventDefault();
				event.stopPropagation();
				dropZone.classList.remove('drag-over');
				const resource = extractEditorsDropData(event).find(editor => editor.resource?.path.toLowerCase().endsWith('.scrim'))?.resource;
				if (resource) {
					void this.commandService.executeCommand(CODE_SCRIM_OPEN_RECORDING_COMMAND_ID, resource, true);
				}
			}));
			const back = append(shell, $('button.codescrim-home-back', { type: 'button' }, localize('codeScrim.backHome', "Back to Home")));
			this.renderDisposables.add(addDisposableListener(back, EventType.CLICK, () => {
				this.page = 'home';
				this.render();
				this.focus();
			}));
		}
	}

	private addCard(parent: HTMLElement, kind: string, title: string, description: string, action: () => void): void {
		const card = append(parent, $('button.codescrim-home-card', { type: 'button', 'data-kind': kind }));
		this.firstAction ??= card;
		append(card, $('span.codescrim-home-card-title', undefined, title));
		append(card, $('span.codescrim-home-card-description', undefined, description));
		append(card, $('span.codescrim-home-card-arrow', { 'aria-hidden': 'true' }, '→'));
		this.renderDisposables.add(addDisposableListener(card, EventType.CLICK, action));
	}

	private async enterRecordingWorkspace(): Promise<void> {
		// A visit to Home from a lesson must not reactivate that lesson when Record is chosen.
		await this.editorService.closeEditors(this.editorService.getEditors(EditorsOrder.SEQUENTIAL)
			.filter(({ editor }) => editor instanceof CodeScrimLessonEditorInput));
		if (this.input) {
			await this.group.closeEditor(this.input);
		}
	}
}
