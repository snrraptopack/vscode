/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/codeScrimLessonEditor.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { CODE_SCRIM_OPEN_COURSE_HOME_COMMAND_ID, ICodeScrimLayoutService, ICodeScrimSessionService, ICodeScrimSessionState } from '../common/codeScrimSession.js';
import { CodeScrimLessonEditorInput } from './codeScrimLessonEditorInput.js';

interface ITranscriptEntry {
	readonly start: number;
	readonly element: HTMLElement;
}

export class CodeScrimLessonEditor extends EditorPane {

	static readonly ID = CodeScrimLessonEditorInput.EDITOR_ID;

	private root: HTMLElement | undefined;
	private workspace: HTMLElement | undefined;
	private navigation: HTMLElement | undefined;
	private contextPanel: HTMLElement | undefined;
	private navigationRevealButton: HTMLButtonElement | undefined;
	private contextRevealButton: HTMLButtonElement | undefined;
	private status: HTMLElement | undefined;
	private time: HTMLElement | undefined;
	private progress: HTMLInputElement | undefined;
	private playPauseButton: Button | undefined;
	private transcriptTab: HTMLButtonElement | undefined;
	private notesTab: HTMLButtonElement | undefined;
	private transcriptPanel: HTMLElement | undefined;
	private notesPanel: HTMLElement | undefined;
	private readonly transcriptEntries: ITranscriptEntry[] = [];
	private readonly layoutLease = this._register(new MutableDisposable<IDisposable>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@ICodeScrimLayoutService private readonly layoutService: ICodeScrimLayoutService,
		@ICodeScrimSessionService private readonly sessionService: ICodeScrimSessionService,
	) {
		super(CodeScrimLessonEditor.ID, group, telemetryService, themeService, storageService);
		this._register(this.sessionService.onDidChangeState(state => this.renderState(state)));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = DOM.append(parent, DOM.$('.codescrim-lesson-editor', {
			role: 'application',
			'aria-label': localize('codeScrim.lessonEditorAriaLabel', "CodeScrim lesson workspace"),
		}));

		this.workspace = DOM.append(this.root, DOM.$('.codescrim-session-workspace'));
		this.createNavigation(this.workspace);
		this.createStage(this.workspace);
		this.createContextPanel(this.workspace);
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.layoutLease.value = visible ? this.layoutService.enterCodeScrimMode() : undefined;
	}

	override async setInput(input: CodeScrimLessonEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}

		if (this.sessionService.state?.lesson.id !== input.lesson.id) {
			this.sessionService.openLesson(input.lesson);
		}

		this.renderState(this.sessionService.state);
	}

	override clearInput(): void {
		super.clearInput();
		this.renderState(undefined);
	}

	override layout(dimension: DOM.Dimension): void {
		if (this.root) {
			this.root.style.width = `${dimension.width}px`;
			this.root.style.height = `${dimension.height}px`;
		}
	}

	private createNavigation(shell: HTMLElement): void {
		const navigation = this.navigation = DOM.append(shell, DOM.$('aside.codescrim-session-navigation', {
			'aria-label': localize('codeScrim.lessonNavigationAriaLabel', "Course navigation"),
		}));
		const brand = DOM.append(navigation, DOM.$('.codescrim-session-brand'));
		const brandHome = DOM.append(brand, DOM.$('button.codescrim-session-brand-home', {
			type: 'button',
			'aria-label': localize('codeScrim.backToLibraryAriaLabel', "Back to course library"),
		})) as HTMLButtonElement;
		brandHome.appendChild(renderIcon(Codicon.playCircle));
		DOM.append(brandHome, DOM.$('span', undefined, localize('codeScrim.productName', "CodeScrim")));
		this._register(DOM.addDisposableListener(brandHome, DOM.EventType.CLICK, () => this.commandService.executeCommand(CODE_SCRIM_OPEN_COURSE_HOME_COMMAND_ID)));
		this.createIconButton(
			brand,
			'codescrim-session-sidebar-collapse',
			localize('codeScrim.hideCourseNavigation', "Hide course navigation"),
			Codicon.layoutSidebarLeftOff,
			() => this.setPaneCollapsed('navigation', true),
		);

		const primaryNavigation = DOM.append(navigation, DOM.$('nav.codescrim-session-primary-navigation'));
		this.addNavigationItem(primaryNavigation, Codicon.home, localize('codeScrim.navigationOverview', "Overview"), () => this.commandService.executeCommand(CODE_SCRIM_OPEN_COURSE_HOME_COMMAND_ID));
		this.addNavigationItem(primaryNavigation, Codicon.library, localize('codeScrim.navigationBootcamp', "My Bootcamp"), undefined, true);

		const course = DOM.append(navigation, DOM.$('.codescrim-session-course'));
		const courseHeader = DOM.append(course, DOM.$('.codescrim-session-course-header'));
		DOM.append(courseHeader, DOM.$('span', undefined, localize('codeScrim.courseName', "Native Product Foundations")));
		DOM.append(courseHeader, DOM.$('span.codescrim-session-course-progress', undefined, localize('codeScrim.courseProgress', "17%")));

		const moduleLabel = DOM.append(course, DOM.$('p.codescrim-session-module-label', undefined, localize('codeScrim.moduleLabel', "Module 1 · Orientation")));
		moduleLabel.id = 'codescrim-module-one';
		const lessonList = DOM.append(course, DOM.$('ol.codescrim-session-lesson-list', { 'aria-labelledby': moduleLabel.id }));
		this.addLessonItem(lessonList, localize('codeScrim.lessonWelcome', "Welcome to the Bootcamp"), 'complete');
		this.addLessonItem(lessonList, localize('codeScrim.lessonNativeFoundations', "Native Session Foundations"), 'active');
		this.addLessonItem(lessonList, localize('codeScrim.lessonPlaybackEvents', "Playback Events"), 'upcoming');
		this.addLessonItem(lessonList, localize('codeScrim.lessonCheckpoints', "Checkpoints and Branches"), 'locked');

		const navigationFooter = DOM.append(navigation, DOM.$('.codescrim-session-navigation-footer'));
		const progressMeta = DOM.append(navigationFooter, DOM.$('.codescrim-session-progress-meta'));
		DOM.append(progressMeta, DOM.$('span', undefined, localize('codeScrim.progressLabel', "Course progress")));
		DOM.append(progressMeta, DOM.$('span', undefined, localize('codeScrim.progressValue', "1 of 6")));
		const courseProgress = DOM.append(navigationFooter, DOM.$('.codescrim-session-progress-track'));
		DOM.append(courseProgress, DOM.$('.codescrim-session-progress-value'));
		const exitButton = DOM.append(navigationFooter, DOM.$('button.codescrim-session-exit', { type: 'button' })) as HTMLButtonElement;
		exitButton.appendChild(renderIcon(Codicon.close));
		DOM.append(exitButton, DOM.$('span', undefined, localize('codeScrim.exitLesson', "Exit CodeScrim")));
		this._register(DOM.addDisposableListener(exitButton, DOM.EventType.CLICK, () => {
			if (this.input) {
				void this.group.closeEditor(this.input);
			}
		}));
	}

	private createStage(shell: HTMLElement): void {
		const main = DOM.append(shell, DOM.$('main.codescrim-session-main'));
		this.navigationRevealButton = this.createIconButton(
			main,
			'codescrim-session-pane-reveal left',
			localize('codeScrim.showCourseNavigation', "Show course navigation"),
			Codicon.layoutSidebarLeft,
			() => this.setPaneCollapsed('navigation', false),
		);
		this.navigationRevealButton.hidden = true;
		this.contextRevealButton = this.createIconButton(
			main,
			'codescrim-session-pane-reveal right',
			localize('codeScrim.showLessonContext', "Show lesson context"),
			Codicon.layoutSidebarRight,
			() => this.setPaneCollapsed('context', false),
		);
		this.contextRevealButton.hidden = true;

		const content = DOM.append(main, DOM.$('section.codescrim-session-stage', {
			'aria-label': localize('codeScrim.lessonStageAriaLabel', "Lesson session stage"),
		}));
		const playButton = DOM.append(content, DOM.$('button.codescrim-session-stage-play', {
			type: 'button',
			'aria-label': localize('codeScrim.playLessonFromStage', "Play lesson"),
			title: localize('codeScrim.playLessonFromStage', "Play lesson"),
		})) as HTMLButtonElement;
		playButton.appendChild(renderIcon(Codicon.debugStart));
		this._register(DOM.addDisposableListener(playButton, DOM.EventType.CLICK, () => this.sessionService.play()));

		this.createTransport(main);
	}

	private createTransport(main: HTMLElement): void {
		const transport = DOM.append(main, DOM.$('section.codescrim-session-transport', {
			'aria-label': localize('codeScrim.lessonTransportAriaLabel', "Lesson playback controls"),
		}));
		const controls = DOM.append(transport, DOM.$('.codescrim-session-transport-controls'));
		this.playPauseButton = this._register(new Button(controls, { ...defaultButtonStyles }));
		this._register(this.playPauseButton.onDidClick(() => {
			if (this.sessionService.state?.status === 'playing') {
				this.sessionService.pause();
			} else {
				this.sessionService.play();
			}
		}));

		const restartButton = this._register(new Button(controls, { ...defaultButtonStyles, secondary: true }));
		restartButton.label = localize('codeScrim.lessonRestart', "Restart");
		this._register(restartButton.onDidClick(() => this.sessionService.restart()));

		const timeline = DOM.append(transport, DOM.$('.codescrim-session-timeline'));
		const timelineMeta = DOM.append(timeline, DOM.$('.codescrim-session-timeline-meta'));
		this.status = DOM.append(timelineMeta, DOM.$('.codescrim-session-status', { 'aria-live': 'polite' }));
		this.time = DOM.append(timelineMeta, DOM.$('output.codescrim-session-time'));
		this.progress = DOM.append(timeline, DOM.$('input.codescrim-session-progress', {
			type: 'range',
			min: '0',
			max: '1',
			step: '100',
			value: '0',
			'aria-label': localize('codeScrim.lessonTimelineAriaLabel', "Lesson timeline"),
		})) as HTMLInputElement;
		this._register(DOM.addDisposableListener(this.progress, DOM.EventType.INPUT, () => {
			this.sessionService.seek(Number(this.progress?.value ?? 0));
		}));

		DOM.append(transport, DOM.$('.codescrim-session-speed', undefined, localize('codeScrim.playbackSpeed', "1×")));
	}

	private createContextPanel(shell: HTMLElement): void {
		const context = this.contextPanel = DOM.append(shell, DOM.$('aside.codescrim-session-context', {
			'aria-label': localize('codeScrim.lessonContextAriaLabel', "Lesson context"),
		}));
		const contextHeader = DOM.append(context, DOM.$('.codescrim-session-context-header'));
		DOM.append(contextHeader, DOM.$('span', undefined, localize('codeScrim.lessonContextTitle', "Lesson context")));
		const contextActions = DOM.append(contextHeader, DOM.$('.codescrim-session-context-actions'));
		DOM.append(contextActions, DOM.$('span.codescrim-session-context-count', undefined, localize('codeScrim.lessonContextCount', "2 / 6")));
		this.createIconButton(
			contextActions,
			'codescrim-session-sidebar-collapse',
			localize('codeScrim.hideLessonContext', "Hide lesson context"),
			Codicon.layoutSidebarRightOff,
			() => this.setPaneCollapsed('context', true),
		);

		const tabs = DOM.append(context, DOM.$('.codescrim-session-context-tabs', { role: 'tablist' }));
		this.transcriptTab = DOM.append(tabs, DOM.$('button', {
			type: 'button',
			role: 'tab',
			'aria-selected': 'true',
		}, localize('codeScrim.transcriptTab', "Transcript"))) as HTMLButtonElement;
		this.notesTab = DOM.append(tabs, DOM.$('button', {
			type: 'button',
			role: 'tab',
			'aria-selected': 'false',
		}, localize('codeScrim.notesTab', "Notes"))) as HTMLButtonElement;
		this._register(DOM.addDisposableListener(this.transcriptTab, DOM.EventType.CLICK, () => this.selectContextPanel('transcript')));
		this._register(DOM.addDisposableListener(this.notesTab, DOM.EventType.CLICK, () => this.selectContextPanel('notes')));

		const body = DOM.append(context, DOM.$('.codescrim-session-context-body'));
		this.transcriptPanel = DOM.append(body, DOM.$('.codescrim-session-transcript', { role: 'tabpanel' }));
		this.addTranscriptEntry(this.transcriptPanel, 0, localize('codeScrim.transcriptTimeOne', "0:00"), localize('codeScrim.transcriptOne', "We begin inside the product shell, where the lesson controls the real development workspace."));
		this.addTranscriptEntry(this.transcriptPanel, 45_000, localize('codeScrim.transcriptTimeTwo', "0:45"), localize('codeScrim.transcriptTwo', "Every editor change and terminal event shares one deterministic session clock."));
		this.addTranscriptEntry(this.transcriptPanel, 105_000, localize('codeScrim.transcriptTimeThree', "1:45"), localize('codeScrim.transcriptThree', "Pause whenever you want to experiment; your changes remain separate from the instructor state."));

		const resources = DOM.append(this.transcriptPanel, DOM.$('.codescrim-session-resources'));
		DOM.append(resources, DOM.$('h2', undefined, localize('codeScrim.resourcesTitle', "Lesson resources")));
		const resource = DOM.append(resources, DOM.$('.codescrim-session-resource'));
		resource.appendChild(renderIcon(Codicon.book));
		const resourceText = DOM.append(resource, DOM.$('span'));
		DOM.append(resourceText, DOM.$('strong', undefined, localize('codeScrim.resourcesArchitecture', "Native session architecture")));
		DOM.append(resourceText, DOM.$('small', undefined, localize('codeScrim.resourcesArchitectureType', "Reference · 4 min")));

		this.notesPanel = DOM.append(body, DOM.$('.codescrim-session-notes', { role: 'tabpanel' }));
		this.notesPanel.hidden = true;
		const notesIcon = DOM.append(this.notesPanel, DOM.$('.codescrim-session-notes-icon'));
		notesIcon.appendChild(renderIcon(Codicon.book));
		DOM.append(this.notesPanel, DOM.$('h2', undefined, localize('codeScrim.notesTitle', "Your lesson notes")));
		DOM.append(this.notesPanel, DOM.$('p', undefined, localize('codeScrim.notesDescription', "Notes captured while you experiment will appear here.")));
	}

	private addNavigationItem(parent: HTMLElement, icon: ThemeIcon, label: string, action?: () => void, active = false): void {
		const item = DOM.append(parent, DOM.$('button.codescrim-session-navigation-item', {
			type: 'button',
			'aria-current': active ? 'page' : undefined,
		})) as HTMLButtonElement;
		item.classList.toggle('active', active);
		item.appendChild(renderIcon(icon));
		DOM.append(item, DOM.$('span', undefined, label));
		if (action) {
			this._register(DOM.addDisposableListener(item, DOM.EventType.CLICK, action));
		}
	}

	private createIconButton(parent: HTMLElement, className: string, label: string, icon: ThemeIcon, action: () => void): HTMLButtonElement {
		const button = DOM.append(parent, DOM.$(`button.${className.replace(/ /g, '.')}`, {
			type: 'button',
			title: label,
			'aria-label': label,
		})) as HTMLButtonElement;
		button.appendChild(renderIcon(icon));
		this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, action));
		return button;
	}

	private setPaneCollapsed(pane: 'navigation' | 'context', collapsed: boolean): void {
		if (!this.workspace) {
			return;
		}

		const navigation = pane === 'navigation';
		const className = navigation ? 'navigation-collapsed' : 'context-collapsed';
		this.workspace.classList.toggle(className, collapsed);
		const panel = navigation ? this.navigation : this.contextPanel;
		const revealButton = navigation ? this.navigationRevealButton : this.contextRevealButton;
		if (panel) {
			panel.hidden = collapsed;
		}
		panel?.setAttribute('aria-hidden', String(collapsed));
		if (revealButton) {
			revealButton.hidden = !collapsed;
		}
	}

	private addLessonItem(parent: HTMLElement, label: string, state: 'complete' | 'active' | 'upcoming' | 'locked'): void {
		const item = DOM.append(parent, DOM.$(`li.codescrim-session-lesson-item.${state}`));
		const marker = DOM.append(item, DOM.$('span.codescrim-session-lesson-marker'));
		marker.appendChild(renderIcon(state === 'complete' ? Codicon.check : state === 'locked' ? Codicon.lock : Codicon.circleFilled));
		DOM.append(item, DOM.$('span', undefined, label));
	}

	private addTranscriptEntry(parent: HTMLElement, start: number, time: string, text: string): void {
		const entry = DOM.append(parent, DOM.$('article.codescrim-session-transcript-entry'));
		DOM.append(entry, DOM.$('time', undefined, time));
		DOM.append(entry, DOM.$('p', undefined, text));
		this.transcriptEntries.push({ start, element: entry });
	}

	private selectContextPanel(panel: 'transcript' | 'notes'): void {
		const transcriptSelected = panel === 'transcript';
		this.transcriptTab?.setAttribute('aria-selected', String(transcriptSelected));
		this.notesTab?.setAttribute('aria-selected', String(!transcriptSelected));
		if (this.transcriptPanel) {
			this.transcriptPanel.hidden = !transcriptSelected;
		}
		if (this.notesPanel) {
			this.notesPanel.hidden = transcriptSelected;
		}
	}

	private renderState(state: ICodeScrimSessionState | undefined): void {
		if (!state || !(this.input instanceof CodeScrimLessonEditorInput) || state.lesson.id !== this.input.lesson.id) {
			return;
		}

		if (this.status) {
			this.status.textContent = this.getStatusLabel(state);
		}
		if (this.time) {
			this.time.textContent = localize('codeScrim.lessonTime', "{0} / {1}", this.formatTime(state.position), this.formatTime(state.duration));
		}
		if (this.progress) {
			this.progress.max = String(Math.max(1, state.duration));
			this.progress.value = String(state.position);
			this.progress.setAttribute('aria-valuetext', localize('codeScrim.lessonTimelinePosition', "{0} of {1}", this.formatTime(state.position), this.formatTime(state.duration)));
		}
		if (this.playPauseButton) {
			const label = state.status === 'playing'
				? localize('codeScrim.lessonPause', "Pause")
				: state.status === 'ended'
					? localize('codeScrim.lessonReplay', "Replay")
					: localize('codeScrim.lessonPlay', "Play");
			this.playPauseButton.label = label;
			this.playPauseButton.setAriaLabel(label);
		}
		this.root?.setAttribute('data-playback-status', state.status);
		for (let index = 0; index < this.transcriptEntries.length; index++) {
			const entry = this.transcriptEntries[index];
			const next = this.transcriptEntries[index + 1];
			entry.element.classList.toggle('active', state.position >= entry.start && (!next || state.position < next.start));
		}
	}

	private getStatusLabel(state: ICodeScrimSessionState): string {
		switch (state.status) {
			case 'playing': return localize('codeScrim.lessonStatusPlaying', "Playing instructor session");
			case 'paused': return localize('codeScrim.lessonStatusPaused', "Paused for experimentation");
			case 'ended': return localize('codeScrim.lessonStatusEnded', "Lesson complete");
			case 'ready': return localize('codeScrim.lessonStatusReady', "Ready to begin");
		}
	}

	private formatTime(milliseconds: number): string {
		const totalSeconds = Math.floor(milliseconds / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${seconds.toString().padStart(2, '0')}`;
	}
}
