/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/codeScrimLessonEditor.css';
import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { DiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { ScrollType } from '../../../../editor/common/editorCommon.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { getIconClasses } from '../../../../editor/common/services/getIconClasses.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { CodeScrimRecordingBuffer, ICodeScrimSelection, ICodeScrimWorkspaceEntryCheckpoint, ICodeScrimWorkspaceResource } from '../common/codeScrimRecording.js';
import { CodeScrimReplayState, ICodeScrimLearnerExperiment, ICodeScrimReplayService, ICodeScrimReplaySurface } from '../common/codeScrimReplay.js';
import { CODE_SCRIM_OPEN_COURSE_HOME_COMMAND_ID, ICodeScrimLayoutService, ICodeScrimSessionService, ICodeScrimSessionState } from '../common/codeScrimSession.js';
import { CodeScrimLessonEditorInput } from './codeScrimLessonEditorInput.js';

interface ITranscriptEntry {
	readonly start: number;
	readonly element: HTMLElement;
}

export class CodeScrimLessonEditor extends EditorPane implements ICodeScrimReplaySurface {

	static readonly ID = CodeScrimLessonEditorInput.EDITOR_ID;

	private root: HTMLElement | undefined;
	private workspace: HTMLElement | undefined;
	private navigation: HTMLElement | undefined;
	private coursePane: HTMLElement | undefined;
	private filesPane: HTMLElement | undefined;
	private filesTree: HTMLElement | undefined;
	private courseModeButton: HTMLButtonElement | undefined;
	private filesModeButton: HTMLButtonElement | undefined;
	private courseProgress: HTMLElement | undefined;
	private contextPanel: HTMLElement | undefined;
	private replayTabs: HTMLElement | undefined;
	private editorHost: HTMLElement | undefined;
	private codeEditor: CodeEditorWidget | undefined;
	private diffEditorHost: HTMLElement | undefined;
	private diffEditor: DiffEditorWidget | undefined;
	private navigationRevealButton: HTMLButtonElement | undefined;
	private contextRevealButton: HTMLButtonElement | undefined;
	private status: HTMLElement | undefined;
	private time: HTMLElement | undefined;
	private progress: HTMLInputElement | undefined;
	private timelineMarkers: HTMLElement | undefined;
	private experimentPopover: HTMLElement | undefined;
	private playPauseButton: Button | undefined;
	private transcriptTab: HTMLButtonElement | undefined;
	private notesTab: HTMLButtonElement | undefined;
	private transcriptPanel: HTMLElement | undefined;
	private notesPanel: HTMLElement | undefined;
	private readonly transcriptEntries: ITranscriptEntry[] = [];
	private readonly workspaceTreeListeners = this._register(new DisposableStore());
	private readonly replayTabListeners = this._register(new DisposableStore());
	private readonly timelineMarkerListeners = this._register(new DisposableStore());
	private readonly experimentPopoverListeners = this._register(new DisposableStore());
	private readonly openedResources: ICodeScrimWorkspaceResource[] = [];
	private readonly layoutLease = this._register(new MutableDisposable<IDisposable>());
	private readonly replaySurfaceLease = this._register(new MutableDisposable<IDisposable>());
	private navigationMode: 'course' | 'files' = 'course';
	private navigationModeManuallySelected = false;
	private timelineScrubbing = false;
	private resumeAfterTimelineScrub = false;
	private timelinePause: Promise<void> | undefined;
	private selectedExperimentId: string | undefined;
	private reviewingExperimentId: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ICodeScrimLayoutService private readonly layoutService: ICodeScrimLayoutService,
		@IModelService private readonly modelService: IModelService,
		@ICodeScrimReplayService private readonly replayService: ICodeScrimReplayService,
		@ICodeScrimSessionService private readonly sessionService: ICodeScrimSessionService,
	) {
		super(CodeScrimLessonEditor.ID, group, telemetryService, themeService, storageService);
		this._register(this.sessionService.onDidChangeState(state => this.renderState(state)));
		this._register(this.replayService.onDidChangeState(state => this.renderReplayState(state)));
		this._register(this.replayService.onDidChangeWorkspace(() => this.renderWorkspaceTree()));
		this._register(this.replayService.onDidChangeLearnerState(() => {
			this.renderReplayTabs();
			this.renderWorkspaceTree();
		}));
		this._register(this.replayService.onDidChangeLearnerExperiments(() => {
			if (this.selectedExperimentId && this.replayService.activeLearnerExperimentId !== this.selectedExperimentId) {
				this.dismissExperimentPopover();
			}
			this.renderLearnerExperimentMarkers();
			this.renderExperimentPopover();
		}));
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
		if (!visible) {
			if (this.replayService.state.status !== 'idle') {
				this.replayService.stop();
			}
			// The session controls creator-dock visibility. Clear it whenever this learner
			// surface leaves the workbench, including tab switches and programmatic closes.
			this.sessionService.closeLesson();
		}
		super.setVisible(visible);
		this.layoutLease.value = visible ? this.layoutService.enterCodeScrimMode() : undefined;
		this.replaySurfaceLease.value = visible ? this.replayService.attachSurface(this) : undefined;
	}

	override async setInput(input: CodeScrimLessonEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}

		if (this.sessionService.state?.lesson.id !== input.lesson.id) {
			this.sessionService.openLesson(input.lesson);
		}
		this.navigationModeManuallySelected = false;
		this.selectNavigationMode('course', false);

		this.renderState(this.sessionService.state);
	}

	override clearInput(): void {
		if (this.replayService.state.status !== 'idle') {
			this.replayService.stop();
		}
		super.clearInput();
		this.renderState(undefined);
	}

	override layout(dimension: DOM.Dimension): void {
		if (this.root) {
			this.root.style.width = `${dimension.width}px`;
			this.root.style.height = `${dimension.height}px`;
		}
		this.layoutCodeEditor();
	}

	openResource(resource: ICodeScrimWorkspaceResource, model: ITextModel): void {
		const key = CodeScrimRecordingBuffer.resourceKey(resource);
		if (!this.openedResources.some(candidate => CodeScrimRecordingBuffer.resourceKey(candidate) === key)) {
			this.openedResources.push(resource);
		}
		this.codeEditor?.setModel(model);
		this.root?.classList.add('has-replay-model');
		if (!this.navigationModeManuallySelected) {
			this.selectNavigationMode('files', false);
		}
		this.renderReplayTabs(resource);
		this.renderWorkspaceTree(resource);
	}

	applySelections(resource: ICodeScrimWorkspaceResource, selections: readonly ICodeScrimSelection[]): void {
		if (!selections.length || this.codeEditor?.getModel() !== this.replayService.getLearnerModel(resource)) {
			return;
		}
		const editorSelections = selections.map(selection => new Selection(
			selection.selectionStartLineNumber,
			selection.selectionStartColumn,
			selection.positionLineNumber,
			selection.positionColumn,
		));
		this.codeEditor.setSelections(editorSelections);
		this.codeEditor.revealPositionInCenterIfOutsideViewport(editorSelections[0].getPosition(), ScrollType.Immediate);
	}

	closeResource(resource: ICodeScrimWorkspaceResource): void {
		this.closeReplayTab(resource, false);
	}

	clear(): void {
		this.dismissExperimentPopover();
		this.codeEditor?.setModel(null);
		this.openedResources.length = 0;
		this.root?.classList.remove('has-replay-model');
		this.renderReplayTabs();
		this.renderWorkspaceTree();
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

		const switcher = DOM.append(navigation, DOM.$('.codescrim-session-navigation-switcher', {
			role: 'tablist',
			'aria-label': localize('codeScrim.navigationModeAriaLabel', "Lesson navigation mode"),
		}));
		this.courseModeButton = this.createNavigationModeButton(switcher, 'course', Codicon.library, localize('codeScrim.courseMode', "Course"));
		this.filesModeButton = this.createNavigationModeButton(switcher, 'files', Codicon.files, localize('codeScrim.filesMode', "Files"));

		this.coursePane = DOM.append(navigation, DOM.$('.codescrim-session-course-pane'));

		const primaryNavigation = DOM.append(this.coursePane, DOM.$('nav.codescrim-session-primary-navigation'));
		this.addNavigationItem(primaryNavigation, Codicon.home, localize('codeScrim.navigationOverview', "Overview"), () => this.commandService.executeCommand(CODE_SCRIM_OPEN_COURSE_HOME_COMMAND_ID));
		this.addNavigationItem(primaryNavigation, Codicon.library, localize('codeScrim.navigationBootcamp', "My Bootcamp"), undefined, true);

		const course = DOM.append(this.coursePane, DOM.$('.codescrim-session-course'));
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

		this.filesPane = DOM.append(navigation, DOM.$('.codescrim-session-files-pane', {
			role: 'tabpanel',
			'aria-label': localize('codeScrim.replayFilesAriaLabel', "Replay files"),
		}));
		this.filesPane.hidden = true;
		const filesHeader = DOM.append(this.filesPane, DOM.$('.codescrim-session-files-header'));
		DOM.append(filesHeader, DOM.$('span', undefined, localize('codeScrim.replayFilesTitle', "Replay workspace")));
		this.filesTree = DOM.append(this.filesPane, DOM.$('.codescrim-session-files-tree.file-icon-themable-tree.show-file-icons', { role: 'tree' }));
		this.renderWorkspaceTree();

		const navigationFooter = DOM.append(navigation, DOM.$('.codescrim-session-navigation-footer'));
		this.courseProgress = DOM.append(navigationFooter, DOM.$('.codescrim-session-course-progress-footer'));
		const progressMeta = DOM.append(this.courseProgress, DOM.$('.codescrim-session-progress-meta'));
		DOM.append(progressMeta, DOM.$('span', undefined, localize('codeScrim.progressLabel', "Course progress")));
		DOM.append(progressMeta, DOM.$('span', undefined, localize('codeScrim.progressValue', "1 of 6")));
		const courseProgress = DOM.append(this.courseProgress, DOM.$('.codescrim-session-progress-track'));
		DOM.append(courseProgress, DOM.$('.codescrim-session-progress-value'));
		const exitButton = DOM.append(navigationFooter, DOM.$('button.codescrim-session-exit', { type: 'button' })) as HTMLButtonElement;
		exitButton.appendChild(renderIcon(Codicon.close));
		DOM.append(exitButton, DOM.$('span', undefined, localize('codeScrim.exitLesson', "Exit CodeScrim")));
		this._register(DOM.addDisposableListener(exitButton, DOM.EventType.CLICK, () => {
			this.replayService.stop();
			this.sessionService.closeLesson();
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
		this.replayTabs = DOM.append(content, DOM.$('.codescrim-session-replay-tabs.show-file-icons', {
			role: 'tablist',
			'aria-label': localize('codeScrim.openReplayFilesAriaLabel', "Open replay files"),
		}));
		this.replayTabs.hidden = true;
		const editorHost = this.editorHost = DOM.append(content, DOM.$('.codescrim-session-code-editor'));
		this.codeEditor = this._register(this.instantiationService.createInstance(CodeEditorWidget, editorHost, {
			readOnly: false,
			domReadOnly: false,
			automaticLayout: false,
			minimap: { enabled: true },
			scrollBeyondLastLine: false,
			ariaLabel: localize('codeScrim.replayEditorAriaLabel', "Learner workspace editor"),
		}, { isSimpleWidget: false }));
		// Pointer and keyboard intent switch to learner control before another replay
		// tick can overwrite the cursor, selection, or text the learner is manipulating.
		this._register(this.codeEditor.onMouseDown(() => this.replayService.beginLearnerEdit()));
		this._register(this.codeEditor.onKeyDown(() => this.replayService.beginLearnerEdit()));
		const diffEditorHost = this.diffEditorHost = DOM.append(content, DOM.$('.codescrim-session-diff-editor'));
		diffEditorHost.hidden = true;
		this.diffEditor = this._register(this.instantiationService.createInstance(DiffEditorWidget, diffEditorHost, {
			readOnly: true,
			originalEditable: false,
			automaticLayout: false,
			scrollBeyondLastLine: false,
			renderSideBySideInlineBreakpoint: 520,
			useInlineViewWhenSpaceIsLimited: true,
			diffAlgorithm: 'advanced',
			originalAriaLabel: localize('codeScrim.instructorVersion', "Instructor version"),
			modifiedAriaLabel: localize('codeScrim.learnerVersion', "Learner version"),
		}, {}));
		const playButton = DOM.append(content, DOM.$('button.codescrim-session-stage-play', {
			type: 'button',
			'aria-label': localize('codeScrim.playLessonFromStage', "Play lesson"),
			title: localize('codeScrim.playLessonFromStage', "Play lesson"),
		})) as HTMLButtonElement;
		playButton.appendChild(renderIcon(Codicon.debugStart));
		this._register(DOM.addDisposableListener(playButton, DOM.EventType.CLICK, () => {
			if (this.replayService.state.status === 'paused') {
				this.replayService.resume();
			} else if (this.replayService.state.status === 'ended' || this.replayService.state.status === 'error') {
				void this.replayService.restart();
			} else {
				this.sessionService.play();
			}
		}));

		this.createTransport(main);
	}

	private createTransport(main: HTMLElement): void {
		const transport = DOM.append(main, DOM.$('section.codescrim-session-transport', {
			'aria-label': localize('codeScrim.lessonTransportAriaLabel', "Lesson playback controls"),
		}));
		const controls = DOM.append(transport, DOM.$('.codescrim-session-transport-controls'));
		this.playPauseButton = this._register(new Button(controls, { ...defaultButtonStyles }));
		this._register(this.playPauseButton.onDidClick(() => {
			const replayState = this.replayService.state;
			if (replayState.status !== 'idle') {
				if (replayState.status === 'playing') {
					void this.replayService.pause();
				} else if (replayState.status === 'paused') {
					this.replayService.resume();
				} else if (replayState.status === 'ended' || replayState.status === 'error') {
					void this.replayService.restart();
				}
				return;
			}
			if (this.sessionService.state?.status === 'playing') {
				this.sessionService.pause();
			} else {
				this.sessionService.play();
			}
		}));

		const restartButton = this._register(new Button(controls, { ...defaultButtonStyles, secondary: true }));
		restartButton.label = localize('codeScrim.lessonRestart', "Restart");
		this._register(restartButton.onDidClick(() => {
			if (this.replayService.state.status !== 'idle') {
				void this.replayService.restart();
			} else {
				this.sessionService.restart();
			}
		}));

		const timeline = DOM.append(transport, DOM.$('.codescrim-session-timeline'));
		this.experimentPopover = DOM.append(timeline, DOM.$('.codescrim-session-experiment-popover'));
		this.experimentPopover.hidden = true;
		const timelineMeta = DOM.append(timeline, DOM.$('.codescrim-session-timeline-meta'));
		this.status = DOM.append(timelineMeta, DOM.$('.codescrim-session-status', { 'aria-live': 'polite' }));
		this.time = DOM.append(timelineMeta, DOM.$('output.codescrim-session-time'));
		const timelineTrack = DOM.append(timeline, DOM.$('.codescrim-session-timeline-track'));
		this.progress = DOM.append(timelineTrack, DOM.$('input.codescrim-session-progress', {
			type: 'range',
			min: '0',
			max: '1',
			step: '100',
			value: '0',
			'aria-label': localize('codeScrim.lessonTimelineAriaLabel', "Lesson timeline"),
		})) as HTMLInputElement;
		this.timelineMarkers = DOM.append(timelineTrack, DOM.$('.codescrim-session-timeline-markers', {
			'aria-label': localize('codeScrim.learnerExperimentMarkers', "Learner experiment markers"),
		}));
		this._register(DOM.addDisposableListener(this.progress, DOM.EventType.POINTER_DOWN, () => this.beginTimelineScrub()));
		this._register(DOM.addDisposableListener(this.progress, DOM.EventType.INPUT, () => {
			const position = Number(this.progress?.value ?? 0);
			const replayState = this.replayService.state;
			if (replayState.status !== 'idle') {
				this.beginTimelineScrub();
				if (this.time) {
					this.time.textContent = localize('codeScrim.lessonTime', "{0} / {1}", this.formatTime(position / 1000), this.formatTime(replayState.duration / 1000));
				}
			} else {
				this.sessionService.seek(position);
			}
		}));
		this._register(DOM.addDisposableListener(this.progress, DOM.EventType.CHANGE, () => {
			if (this.replayService.state.status !== 'idle') {
				void this.commitTimelineScrub(Number(this.progress?.value ?? 0));
			}
		}));

		DOM.append(transport, DOM.$('.codescrim-session-speed', undefined, localize('codeScrim.playbackSpeed', "1×")));
	}

	private renderLearnerExperimentMarkers(): void {
		if (!this.timelineMarkers) {
			return;
		}
		DOM.clearNode(this.timelineMarkers);
		this.timelineMarkerListeners.clear();
		const state = this.replayService.state;
		const duration = state.status === 'idle' ? 0 : state.duration;
		if (!duration) {
			return;
		}
		for (const experiment of this.replayService.learnerExperiments) {
			const time = this.formatTime(experiment.position / 1000);
			const label = localize('codeScrim.learnerExperimentMarkerLabel', "Learner experiment at {0}; {1} changed files", time, experiment.changes.length);
			const marker = DOM.append(this.timelineMarkers, DOM.$('button.codescrim-session-timeline-marker', {
				type: 'button',
				title: label,
				'aria-label': label,
			})) as HTMLButtonElement;
			marker.style.left = `${Math.min(100, Math.max(0, experiment.position / duration * 100))}%`;
			marker.classList.toggle('active', this.replayService.activeLearnerExperimentId === experiment.id);
			this.timelineMarkerListeners.add(DOM.addDisposableListener(marker, DOM.EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				void this.selectLearnerExperiment(experiment.id);
			}));
		}
	}

	private async selectLearnerExperiment(id: string): Promise<void> {
		this.closeExperimentReview();
		await this.replayService.openLearnerExperiment(id);
		if (this.replayService.activeLearnerExperimentId !== id) {
			return;
		}
		this.selectedExperimentId = id;
		this.renderLearnerExperimentMarkers();
		this.renderExperimentPopover();
	}

	private renderExperimentPopover(): void {
		if (!this.experimentPopover) {
			return;
		}

		DOM.clearNode(this.experimentPopover);
		this.experimentPopoverListeners.clear();
		const experiment = this.selectedExperimentId
			? this.replayService.learnerExperiments.find(candidate => candidate.id === this.selectedExperimentId)
			: undefined;
		this.experimentPopover.hidden = !experiment;
		if (!experiment) {
			return;
		}

		const summary = experiment.changes.length === 1
			? localize('codeScrim.experimentSummaryOneFile', "Experiment · {0} · 1 file", this.formatTime(experiment.position / 1000))
			: localize('codeScrim.experimentSummaryManyFiles', "Experiment · {0} · {1} files", this.formatTime(experiment.position / 1000), experiment.changes.length);
		const label = DOM.append(this.experimentPopover, DOM.$('.codescrim-session-experiment-summary'));
		label.appendChild(renderIcon(Codicon.gitBranch));
		DOM.append(label, DOM.$('span', undefined, summary));

		const reviewButton = DOM.append(this.experimentPopover, DOM.$('button.codescrim-session-experiment-review', {
			type: 'button',
		}, this.reviewingExperimentId === experiment.id
			? localize('codeScrim.closeExperimentReview', "Close Review")
			: localize('codeScrim.reviewExperimentChanges', "Review Changes"))) as HTMLButtonElement;
		this.experimentPopoverListeners.add(DOM.addDisposableListener(reviewButton, DOM.EventType.CLICK, () => {
			if (this.reviewingExperimentId === experiment.id) {
				this.closeExperimentReview();
			} else {
				this.openExperimentReview(experiment);
			}
			this.renderExperimentPopover();
		}));

		const moreButton = DOM.append(this.experimentPopover, DOM.$('button.codescrim-session-experiment-more', {
			type: 'button',
			title: localize('codeScrim.moreExperimentActions', "More experiment actions"),
			'aria-label': localize('codeScrim.moreExperimentActions', "More experiment actions"),
		})) as HTMLButtonElement;
		moreButton.appendChild(renderIcon(Codicon.more));
		this.experimentPopoverListeners.add(DOM.addDisposableListener(moreButton, DOM.EventType.CLICK, event => {
			event.stopPropagation();
			this.showExperimentMenu(moreButton, experiment);
		}));

		const closeButton = DOM.append(this.experimentPopover, DOM.$('button.codescrim-session-experiment-close', {
			type: 'button',
			title: localize('codeScrim.closeExperimentActions', "Close experiment actions"),
			'aria-label': localize('codeScrim.closeExperimentActions', "Close experiment actions"),
		})) as HTMLButtonElement;
		closeButton.appendChild(renderIcon(Codicon.close));
		this.experimentPopoverListeners.add(DOM.addDisposableListener(closeButton, DOM.EventType.CLICK, () => this.dismissExperimentPopover()));
	}

	private showExperimentMenu(anchor: HTMLElement, experiment: ICodeScrimLearnerExperiment): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: (): IAction[] => [{
				id: 'codescrim.restoreInstructorExperiment',
				label: localize('codeScrim.restoreInstructorExperiment', "Restore Instructor Version"),
				tooltip: '',
				class: undefined,
				enabled: true,
				run: () => {
					this.closeExperimentReview();
					this.replayService.restoreLearnerExperiment(experiment.id);
				},
			}, {
				id: 'codescrim.keepLearnerExperiment',
				label: localize('codeScrim.keepLearnerExperiment', "Keep Learner Version"),
				tooltip: '',
				class: undefined,
				enabled: true,
				run: () => this.dismissExperimentPopover(),
			}, {
				id: 'codescrim.deleteLearnerExperiment',
				label: localize('codeScrim.deleteLearnerExperiment', "Delete Experiment"),
				tooltip: '',
				class: undefined,
				enabled: true,
				run: () => {
					this.dismissExperimentPopover();
					this.replayService.deleteLearnerExperiment(experiment.id);
				},
			}],
		});
	}

	private openExperimentReview(experiment: ICodeScrimLearnerExperiment, resource = experiment.changes[0]?.resource): void {
		if (!resource || !this.diffEditor || !this.editorHost || !this.diffEditorHost) {
			return;
		}
		const instructor = this.replayService.getInstructorModel(resource);
		const learner = this.replayService.getLearnerModel(resource);
		if (!instructor || !learner) {
			return;
		}
		this.reviewingExperimentId = experiment.id;
		this.editorHost.hidden = true;
		this.diffEditorHost.hidden = false;
		this.diffEditor.setModel({ original: instructor, modified: learner });
		this.renderReplayTabs(resource);
		this.renderWorkspaceTree(resource);
		mainWindow.requestAnimationFrame(() => this.layoutCodeEditor());
	}

	private closeExperimentReview(): void {
		this.reviewingExperimentId = undefined;
		this.diffEditor?.setModel(null);
		if (this.diffEditorHost) {
			this.diffEditorHost.hidden = true;
		}
		if (this.editorHost) {
			this.editorHost.hidden = false;
		}
		this.renderReplayTabs();
		this.renderWorkspaceTree();
		mainWindow.requestAnimationFrame(() => this.layoutCodeEditor());
	}

	private dismissExperimentPopover(closeReview = true): void {
		this.selectedExperimentId = undefined;
		if (closeReview) {
			this.closeExperimentReview();
		}
		this.renderLearnerExperimentMarkers();
		this.renderExperimentPopover();
	}


	private beginTimelineScrub(): void {
		if (this.timelineScrubbing || this.replayService.state.status === 'idle') {
			return;
		}

		this.timelineScrubbing = true;
		this.resumeAfterTimelineScrub = this.replayService.state.status === 'playing';
		this.timelinePause = this.resumeAfterTimelineScrub ? this.replayService.pause() : Promise.resolve();
	}

	private async commitTimelineScrub(position: number): Promise<void> {
		this.beginTimelineScrub();
		const resume = this.resumeAfterTimelineScrub;
		try {
			await this.timelinePause;
			await this.replayService.seek(position);
			if (resume && this.replayService.state.status === 'paused') {
				this.replayService.resume();
			}
		} finally {
			this.timelineScrubbing = false;
			this.resumeAfterTimelineScrub = false;
			this.timelinePause = undefined;
			this.renderReplayState(this.replayService.state);
		}
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

	private createNavigationModeButton(parent: HTMLElement, mode: 'course' | 'files', icon: ThemeIcon, label: string): HTMLButtonElement {
		const button = DOM.append(parent, DOM.$('button.codescrim-session-navigation-mode', {
			type: 'button',
			role: 'tab',
			'aria-selected': String(mode === this.navigationMode),
		})) as HTMLButtonElement;
		button.appendChild(renderIcon(icon));
		DOM.append(button, DOM.$('span', undefined, label));
		this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => this.selectNavigationMode(mode, true)));
		return button;
	}

	private selectNavigationMode(mode: 'course' | 'files', manual: boolean): void {
		this.navigationMode = mode;
		this.navigationModeManuallySelected ||= manual;
		const courseSelected = mode === 'course';
		this.navigation?.classList.toggle('files-mode', !courseSelected);
		if (this.coursePane) {
			this.coursePane.hidden = !courseSelected;
		}
		if (this.filesPane) {
			this.filesPane.hidden = courseSelected;
		}
		if (this.courseProgress) {
			this.courseProgress.hidden = !courseSelected;
		}
		this.courseModeButton?.setAttribute('aria-selected', String(courseSelected));
		this.filesModeButton?.setAttribute('aria-selected', String(!courseSelected));
	}

	private renderWorkspaceTree(activeResource = this.replayService.activeResource): void {
		if (!this.filesTree) {
			return;
		}

		DOM.clearNode(this.filesTree);
		this.workspaceTreeListeners.clear();
		const entries = this.replayService.workspaceEntries;
		if (!entries.length) {
			DOM.append(this.filesTree, DOM.$('p.codescrim-session-files-empty', undefined, localize('codeScrim.noReplayFiles', "Files appear here when a replay is loaded.")));
			return;
		}

		for (const entry of entries) {
			this.renderWorkspaceEntry(this.filesTree, entry, activeResource);
		}
	}

	private renderReplayTabs(activeResource = this.replayService.activeResource): void {
		if (!this.replayTabs) {
			return;
		}

		DOM.clearNode(this.replayTabs);
		this.replayTabListeners.clear();
		this.replayTabs.hidden = this.openedResources.length === 0;
		mainWindow.requestAnimationFrame(() => this.layoutCodeEditor());
		for (const resource of this.openedResources) {
			const key = CodeScrimRecordingBuffer.resourceKey(resource);
			const active = !!activeResource && CodeScrimRecordingBuffer.resourceKey(activeResource) === key;
			const tab = DOM.append(this.replayTabs, DOM.$('.codescrim-session-replay-tab', {
				role: 'tab',
				'aria-selected': String(active),
				title: resource.path,
			}));
			tab.classList.toggle('learner-modified', this.replayService.hasLearnerChanges(resource));
			const openButton = DOM.append(tab, DOM.$('button.codescrim-session-replay-tab-open', { type: 'button' })) as HTMLButtonElement;
			this.appendResourceIcon(openButton, resource, 'file');
			DOM.append(openButton, DOM.$('span', undefined, resource.path.split('/').pop() ?? resource.path));
			this.replayTabListeners.add(DOM.addDisposableListener(openButton, DOM.EventType.CLICK, () => this.openWorkspaceResource(resource)));
			const closeButton = DOM.append(tab, DOM.$('button.codescrim-session-replay-tab-close', {
				type: 'button',
				title: localize('codeScrim.closeReplayFile', "Close replay file"),
				'aria-label': localize('codeScrim.closeReplayFileAriaLabel', "Close {0}", resource.path),
			})) as HTMLButtonElement;
			closeButton.appendChild(renderIcon(Codicon.close));
			this.replayTabListeners.add(DOM.addDisposableListener(closeButton, DOM.EventType.CLICK, () => this.closeReplayTab(resource, true)));
		}
	}

	private closeReplayTab(resource: ICodeScrimWorkspaceResource, selectAnother: boolean): void {
		const key = CodeScrimRecordingBuffer.resourceKey(resource);
		const index = this.openedResources.findIndex(candidate => CodeScrimRecordingBuffer.resourceKey(candidate) === key);
		if (index < 0) {
			return;
		}
		this.openedResources.splice(index, 1);
		const active = this.replayService.activeResource;
		if (active && CodeScrimRecordingBuffer.resourceKey(active) === key) {
			this.codeEditor?.setModel(null);
			this.root?.classList.remove('has-replay-model');
			if (selectAnother && this.openedResources.length) {
				const next = this.openedResources[Math.min(index, this.openedResources.length - 1)];
				void this.replayService.openResource(next);
			}
		}
		this.renderReplayTabs();
	}

	private renderWorkspaceEntry(parent: HTMLElement, entry: ICodeScrimWorkspaceEntryCheckpoint, activeResource: ICodeScrimWorkspaceResource | undefined): void {
		const depth = entry.resource.path.split('/').length;
		const label = entry.resource.path.split('/').pop() || localize('codeScrim.workspaceRoot', "Workspace");
		const item = DOM.append(parent, DOM.$('button.codescrim-session-file', {
			type: 'button',
			role: 'treeitem',
			'aria-level': String(depth),
			'aria-label': entry.resource.path,
			title: entry.resource.path,
		})) as HTMLButtonElement;
		item.style.paddingLeft = `${10 + (depth - 1) * 14}px`;
		item.classList.toggle('active', !!activeResource && CodeScrimRecordingBuffer.resourceKey(activeResource) === CodeScrimRecordingBuffer.resourceKey(entry.resource));
		item.classList.toggle('learner-modified', entry.type === 'file' && this.replayService.hasLearnerChanges(entry.resource));
		this.appendResourceIcon(item, entry.resource, entry.type);
		DOM.append(item, DOM.$('span', undefined, label));
		if (entry.type === 'directory' || !entry.text) {
			item.disabled = true;
		} else {
			this.workspaceTreeListeners.add(DOM.addDisposableListener(item, DOM.EventType.CLICK, () => this.openWorkspaceResource(entry.resource)));
		}
	}

	private openWorkspaceResource(resource: ICodeScrimWorkspaceResource): void {
		const experiment = this.reviewingExperimentId
			? this.replayService.learnerExperiments.find(candidate => candidate.id === this.reviewingExperimentId)
			: undefined;
		if (experiment?.changes.some(change => CodeScrimRecordingBuffer.resourceKey(change.resource) === CodeScrimRecordingBuffer.resourceKey(resource))) {
			this.openExperimentReview(experiment, resource);
			return;
		}
		void this.replayService.openResource(resource);
	}

	private appendResourceIcon(parent: HTMLElement, resource: ICodeScrimWorkspaceResource, type: 'file' | 'directory'): void {
		const icon = DOM.append(parent, DOM.$('span.codescrim-session-resource-icon', { 'aria-hidden': 'true' }));
		const uri = URI.from({ scheme: 'codescrim-replay', path: `/${resource.path}` });
		icon.classList.add(...getIconClasses(this.modelService, this.languageService, uri, type === 'directory' ? FileKind.FOLDER : FileKind.FILE));
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
		mainWindow.requestAnimationFrame(() => this.layoutCodeEditor());
	}

	private layoutCodeEditor(): void {
		if (this.editorHost && this.codeEditor) {
			this.codeEditor.layout(new DOM.Dimension(this.editorHost.clientWidth, this.editorHost.clientHeight));
		}
		if (this.diffEditorHost && this.diffEditor && !this.diffEditorHost.hidden) {
			this.diffEditor.layout(new DOM.Dimension(this.diffEditorHost.clientWidth, this.diffEditorHost.clientHeight));
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
		if (this.replayService.state.status !== 'idle') {
			return;
		}
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
			this.progress.disabled = false;
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

	private renderReplayState(state: CodeScrimReplayState): void {
		if (state.status === 'idle') {
			this.renderState(this.sessionService.state);
			return;
		}

		const ready = state.status === 'paused' && state.position === 0 && state.appliedEventCount === 0;
		const status = state.status === 'preparing'
			? localize('codeScrim.lessonReplayPreparing', "Preparing replay")
			: state.status === 'playing'
				? localize('codeScrim.lessonReplayPlaying', "Playing instructor session")
				: state.status === 'paused'
					? ready
						? localize('codeScrim.lessonReplayReady', "Ready to play")
						: localize('codeScrim.lessonReplayPaused', "Replay paused")
					: state.status === 'ended'
						? localize('codeScrim.lessonReplayComplete', "Replay complete")
						: localize('codeScrim.lessonReplayFailed', "Replay failed");
		if (this.status) {
			this.status.textContent = status;
		}
		if (this.time && !this.timelineScrubbing) {
			this.time.textContent = localize('codeScrim.lessonTime', "{0} / {1}", this.formatTime(state.position / 1000), this.formatTime(state.duration / 1000));
		}
		if (this.progress) {
			this.progress.max = String(Math.max(1, state.duration));
			if (!this.timelineScrubbing) {
				this.progress.value = String(state.position);
			}
			this.progress.disabled = state.status === 'preparing';
		}
		if (this.playPauseButton) {
			const label = state.status === 'playing'
				? localize('codeScrim.lessonPause', "Pause")
				: state.status === 'ended' || state.status === 'error'
					? localize('codeScrim.lessonReplay', "Replay")
					: state.status === 'paused'
						? ready
							? localize('codeScrim.lessonPlay', "Play")
							: localize('codeScrim.lessonContinue', "Continue")
						: localize('codeScrim.lessonPlay', "Play");
			this.playPauseButton.label = label;
			this.playPauseButton.setAriaLabel(label);
		}
		this.root?.setAttribute('data-playback-status', state.status);
		const position = state.position / 1000;
		for (let index = 0; index < this.transcriptEntries.length; index++) {
			const entry = this.transcriptEntries[index];
			const next = this.transcriptEntries[index + 1];
			entry.element.classList.toggle('active', position >= entry.start && (!next || position < next.start));
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
