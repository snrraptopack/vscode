/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';
import { ICodeScrimReplayService } from '../common/codeScrimReplay.js';
import { ICodeScrimTerminalCheckpoint, ICodeScrimTerminalState } from '../common/codeScrimTerminal.js';
import { CodeScrimReplayPty } from './codeScrimReplayPty.js';

interface ICodeScrimNativeTerminal {
	readonly instance: ITerminalInstance;
	pty: CodeScrimReplayPty | undefined;
	readonly disposeListener: IDisposable;
}

const EMPTY_LEARNER_TERMINAL_ID = -1;

/** Hosts recorded terminal tracks in VS Code's normal integrated Terminal panel. */
export class CodeScrimTerminalSurface extends Disposable {
	private readonly terminals = new Map<number, ICodeScrimNativeTerminal>();
	private readonly pending = new Map<number, Promise<void>>();
	private readonly latest = new Map<number, ICodeScrimTerminalCheckpoint>();
	private readonly dismissed = new Set<number>();
	private readonly disposing = new Set<number>();
	private hasRevealedTerminal = false;

	constructor(
		@ICodeScrimReplayService private readonly replayService: ICodeScrimReplayService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();
		this._register(this.replayService.onDidChangeTerminalState(state => this.render(state)));
		this.render(this.replayService.terminalState);
	}

	private render(state: ICodeScrimTerminalState): void {
		const presentIds = new Set(state.terminals.map(terminal => terminal.terminalId));
		for (const terminalId of this.terminals.keys()) {
			if (terminalId !== EMPTY_LEARNER_TERMINAL_ID && !presentIds.has(terminalId)) {
				this.disposeTerminal(terminalId);
			}
		}

		for (const terminal of state.terminals) {
			this.latest.set(terminal.terminalId, terminal);
			const nativeTerminal = this.terminals.get(terminal.terminalId);
			if (nativeTerminal) {
				nativeTerminal.pty?.update(terminal);
			} else if (!this.pending.has(terminal.terminalId) && !this.dismissed.has(terminal.terminalId)) {
				const creation = this.createTerminal(terminal).finally(() => this.pending.delete(terminal.terminalId));
				this.pending.set(terminal.terminalId, creation);
			}
		}

		const activeTerminal = state.activeTerminalId === undefined ? undefined : this.terminals.get(state.activeTerminalId);
		if (activeTerminal) {
			this.terminalService.setActiveInstance(activeTerminal.instance);
		}
	}

	/** Toggle the normal workbench panel, creating a safe empty learner terminal when needed. */
	async togglePanel(): Promise<void> {
		if (this.contextKeyService.getContextKeyValue<boolean>(TerminalContextKeys.viewShowing.key)) {
			this.layoutService.setPartHidden(true, Parts.PANEL_PART);
			return;
		}

		let terminal = this.getPreferredTerminal();
		if (!terminal) {
			await this.ensureEmptyLearnerTerminal();
			terminal = this.getPreferredTerminal();
		}
		if (terminal) {
			this.terminalService.setActiveInstance(terminal.instance);
			await this.terminalService.revealActiveTerminal(false);
		}
	}

	/** Reveal one recorded terminal without forwarding input to its replay PTY. */
	async revealTerminal(terminalId: number): Promise<void> {
		this.dismissed.delete(terminalId);
		let terminal = this.terminals.get(terminalId);
		if (!terminal) {
			const recorded = this.latest.get(terminalId) ?? this.replayService.terminalState.terminals.find(candidate => candidate.terminalId === terminalId);
			if (recorded && !this.pending.has(terminalId)) {
				const creation = this.createTerminal(recorded).finally(() => this.pending.delete(terminalId));
				this.pending.set(terminalId, creation);
			}
			await this.pending.get(terminalId);
			terminal = this.terminals.get(terminalId);
		}
		if (terminal) {
			this.terminalService.setActiveInstance(terminal.instance);
			await this.terminalService.revealActiveTerminal(true);
		}
	}

	private async createTerminal(recorded: ICodeScrimTerminalCheckpoint): Promise<void> {
		const terminalEntryRef: { value?: ICodeScrimNativeTerminal } = {};
		let replayPty: CodeScrimReplayPty | undefined;
		const title = recorded.title || localize('codeScrim.terminal', "Terminal");
		const instance = await this.terminalService.createTerminal({
			config: {
				name: localize('codeScrim.replayTerminalName', "{0} (Replay, read-only)", title),
				icon: Codicon.terminal,
				isFeatureTerminal: true,
				isTransient: true,
				ignoreShellIntegration: true,
				waitOnExit: false,
				customPtyImplementation: (id, cols, rows) => {
					const pty = new CodeScrimReplayPty(id, this.latest.get(recorded.terminalId) ?? recorded, cols, rows);
					replayPty = pty;
					if (terminalEntryRef.value) {
						terminalEntryRef.value.pty = pty;
						pty.update(this.latest.get(recorded.terminalId) ?? recorded);
					}
					return pty;
				},
			},
			location: TerminalLocation.Panel,
			skipContributedProfileCheck: true,
		});

		if (!this.latest.has(recorded.terminalId) || this.dismissed.has(recorded.terminalId)) {
			this.disposing.add(recorded.terminalId);
			instance.dispose();
			this.disposing.delete(recorded.terminalId);
			return;
		}

		const disposeListener = instance.onDisposed(() => {
			disposeListener.dispose();
			this.terminals.delete(recorded.terminalId);
			if (!this.disposing.has(recorded.terminalId)) {
				this.dismissed.add(recorded.terminalId);
			}
		});
		const terminalEntry = { instance, pty: replayPty, disposeListener };
		terminalEntryRef.value = terminalEntry;
		this.terminals.set(recorded.terminalId, terminalEntry);
		replayPty?.update(this.latest.get(recorded.terminalId) ?? recorded);

		const activeId = this.replayService.terminalState.activeTerminalId;
		if (activeId === recorded.terminalId || this.terminals.size === 1) {
			this.terminalService.setActiveInstance(instance);
		}
		if (!this.hasRevealedTerminal) {
			this.hasRevealedTerminal = true;
			await this.terminalService.revealActiveTerminal(true);
		}
	}

	private async ensureEmptyLearnerTerminal(): Promise<void> {
		if (this.terminals.has(EMPTY_LEARNER_TERMINAL_ID) || this.pending.has(EMPTY_LEARNER_TERMINAL_ID)) {
			await this.pending.get(EMPTY_LEARNER_TERMINAL_ID);
			return;
		}

		const emptyTerminal: ICodeScrimTerminalCheckpoint = Object.freeze({
			terminalId: EMPTY_LEARNER_TERMINAL_ID,
			title: localize('codeScrim.learnerTerminal', "Learner Terminal"),
			cols: 80,
			rows: 24,
			output: localize('codeScrim.learnerTerminalReadOnly', "CodeScrim learner terminal is read-only until sandbox execution is enabled.\r\n"),
			exited: false,
		});
		this.latest.set(EMPTY_LEARNER_TERMINAL_ID, emptyTerminal);
		const creation = this.createTerminal(emptyTerminal).finally(() => this.pending.delete(EMPTY_LEARNER_TERMINAL_ID));
		this.pending.set(EMPTY_LEARNER_TERMINAL_ID, creation);
		await creation;
	}

	private getPreferredTerminal(): ICodeScrimNativeTerminal | undefined {
		const activeId = this.replayService.terminalState.activeTerminalId;
		return activeId === undefined
			? this.terminals.values().next().value
			: this.terminals.get(activeId) ?? this.terminals.values().next().value;
	}

	private disposeTerminal(terminalId: number): void {
		this.latest.delete(terminalId);
		const terminal = this.terminals.get(terminalId);
		if (!terminal) {
			return;
		}
		this.disposing.add(terminalId);
		terminal.disposeListener.dispose();
		terminal.instance.dispose();
		this.disposing.delete(terminalId);
		this.terminals.delete(terminalId);
	}

	override dispose(): void {
		for (const terminalId of [...this.terminals.keys()]) {
			this.disposeTerminal(terminalId);
		}
		this.latest.clear();
		super.dispose();
	}
}
