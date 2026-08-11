/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/codeScrimCourseEditor.css';
import { $, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { CODE_SCRIM_OPEN_DEMO_LESSON_COMMAND_ID } from '../common/codeScrimSession.js';
import { CodeScrimCourseEditorInput } from './codeScrimCourseEditorInput.js';

export class CodeScrimCourseEditor extends EditorPane {

	static readonly ID = CodeScrimCourseEditorInput.EDITOR_ID;

	private root: HTMLElement | undefined;
	private readonly renderDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(CodeScrimCourseEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.codescrim-course-editor', {
			role: 'document',
			'aria-label': localize('codeScrim.courseHomeAriaLabel', "CodeScrim course home"),
		}));
		this.render();
	}

	override async setInput(input: CodeScrimCourseEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.render();
	}

	override layout(dimension: Dimension): void {
		if (!this.root) {
			return;
		}

		this.root.style.width = `${dimension.width}px`;
		this.root.style.height = `${dimension.height}px`;
	}

	private render(): void {
		if (!this.root) {
			return;
		}

		this.renderDisposables.clear();
		clearNode(this.root);

		const shell = append(this.root, $('.codescrim-course-shell'));
		const hero = append(shell, $('header.codescrim-course-hero'));
		append(hero, $('p.codescrim-course-eyebrow', undefined, localize('codeScrim.courseHomeEyebrow', "Interactive Development Courses")));
		append(hero, $('h1', undefined, localize('codeScrim.courseHomeTitle', "Learn inside a real development session")));
		append(hero, $('p.codescrim-course-intro', undefined, localize(
			'codeScrim.courseHomeDescription',
			"Follow an instructor's actual workflow, pause at any moment, experiment with the project, and continue when you are ready."
		)));

		const principles = append(shell, $('section.codescrim-course-principles', {
			'aria-label': localize('codeScrim.courseHomePrinciples', "How CodeScrim lessons work"),
		}));
		this.addPrinciple(
			principles,
			localize('codeScrim.courseHomeFollowTitle', "Follow the Session"),
			localize('codeScrim.courseHomeFollowDescription', "Code, terminal activity, browser state, debugging, and narration advance together."),
		);
		this.addPrinciple(
			principles,
			localize('codeScrim.courseHomeExperimentTitle', "Pause and Experiment"),
			localize('codeScrim.courseHomeExperimentDescription', "Take control of the real project and use the normal editor, terminal, browser, and debugger."),
		);
		this.addPrinciple(
			principles,
			localize('codeScrim.courseHomeContinueTitle', "Restore or Branch"),
			localize('codeScrim.courseHomeContinueDescription', "Return to the instructor's state or preserve your experiment as a separate learning branch."),
		);

		const library = append(shell, $('section.codescrim-course-library'));
		append(library, $('h2', undefined, localize('codeScrim.courseHomeLibraryTitle', "Your Courses")));
		const empty = append(library, $('.codescrim-course-empty'));
		append(empty, $('h3', undefined, localize('codeScrim.courseHomeEmptyTitle', "No courses yet")));
		append(empty, $('p', undefined, localize(
			'codeScrim.courseHomeEmptyDescription',
			"Recorded and published CodeScrim courses will appear here. Use the native demo lesson to test the playback shell now."
		)));

		const actions = append(empty, $('.codescrim-course-empty-actions'));
		const demoButton = this.renderDisposables.add(new Button(actions, { ...defaultButtonStyles }));
		demoButton.label = localize('codeScrim.courseHomeOpenDemo', "Open Demo Lesson");
		this.renderDisposables.add(demoButton.onDidClick(() => this.commandService.executeCommand(CODE_SCRIM_OPEN_DEMO_LESSON_COMMAND_ID)));
	}

	private addPrinciple(parent: HTMLElement, title: string, description: string): void {
		const card = append(parent, $('article.codescrim-course-principle'));
		append(card, $('h2', undefined, title));
		append(card, $('p', undefined, description));
	}
}
