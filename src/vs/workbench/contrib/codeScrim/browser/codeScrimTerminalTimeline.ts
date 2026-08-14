/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';
import { clusterCodeScrimTerminalCommands, CodeScrimReplayState, ICodeScrimReplayService } from '../common/codeScrimReplay.js';
import { ICodeScrimTerminalCommandActivity } from '../common/codeScrimTerminal.js';
import { CodeScrimTerminalSurface } from './codeScrimTerminalSurface.js';

/** Renders terminal activity progressively so commands do not compete with learner markers. */
export class CodeScrimTerminalTimeline extends Disposable {
	private readonly markerListeners = this._register(new DisposableStore());
	private readonly popoverListeners = this._register(new DisposableStore());
	private selectedCommands: readonly ICodeScrimTerminalCommandActivity[] = [];
	private renderedDraftId: string | undefined;
	private renderedDuration = 0;

	constructor(
		private readonly markerContainer: HTMLElement,
		private readonly popover: HTMLElement,
		private readonly terminalSurface: CodeScrimTerminalSurface,
		private readonly onWillSelect: () => void,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ICodeScrimReplayService private readonly replayService: ICodeScrimReplayService,
	) {
		super();
		this._register(this.replayService.onDidChangeState(state => this.render(state)));
		this._register(this.contextKeyService.onDidChangeContext(event => {
			if (event.affectsSome(new Set([TerminalContextKeys.viewShowing.key]))) {
				if (!this.isVisible()) {
					this.selectedCommands = [];
				}
				this.render(this.replayService.state, true);
			}
		}));
		this.render(this.replayService.state);
	}

	dismiss(): void {
		this.selectedCommands = [];
		this.render(this.replayService.state, true);
	}

	private render(state: CodeScrimReplayState, force = false): void {
		const draftId = state.status === 'idle' ? undefined : state.draftId;
		const duration = state.status === 'idle' ? 0 : state.duration;
		if (!force && draftId === this.renderedDraftId && duration === this.renderedDuration) {
			return;
		}
		this.renderedDraftId = draftId;
		this.renderedDuration = duration;
		DOM.clearNode(this.markerContainer);
		this.markerListeners.clear();
		if (!duration || !this.isVisible()) {
			this.renderPopover();
			return;
		}

		for (const cluster of clusterCodeScrimTerminalCommands(this.replayService.terminalCommands, duration)) {
			const time = this.formatTime(cluster.position);
			const label = cluster.commands.length === 1
				? localize('codeScrim.terminalCommandMarker', "Terminal command at {0}: {1}", time, cluster.commands[0].command)
				: localize('codeScrim.terminalCommandClusterMarker', "{0} terminal commands near {1}", cluster.commands.length, time);
			const marker = DOM.append(this.markerContainer, DOM.$('button.codescrim-session-terminal-marker', {
				type: 'button',
				title: label,
				'aria-label': label,
			})) as HTMLButtonElement;
			marker.style.left = `${Math.min(100, Math.max(0, cluster.position / duration * 100))}%`;
			marker.classList.toggle('cluster', cluster.commands.length > 1);
			marker.classList.toggle('active', this.selectedCommands.some(command => cluster.commands.some(candidate => candidate.commandId === command.commandId)));
			this.markerListeners.add(DOM.addDisposableListener(marker, DOM.EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				void this.select(cluster.commands);
			}));
		}
		this.renderPopover();
	}

	private async select(commands: readonly ICodeScrimTerminalCommandActivity[]): Promise<void> {
		const command = commands[0];
		if (!command) {
			return;
		}
		this.onWillSelect();
		if (this.replayService.state.status === 'playing') {
			await this.replayService.pause();
		}
		await this.replayService.seek(command.startedAt);
		await this.terminalSurface.revealTerminal(command.terminalId);
		this.selectedCommands = commands;
		this.render(this.replayService.state, true);
	}

	private renderPopover(): void {
		DOM.clearNode(this.popover);
		this.popoverListeners.clear();
		this.popover.hidden = !this.selectedCommands.length || !this.isVisible();
		if (this.popover.hidden) {
			return;
		}

		const first = this.selectedCommands[0];
		const summary = this.selectedCommands.length === 1
			? localize('codeScrim.terminalActivitySummaryOne', "Terminal activity · {0}", this.formatTime(first.startedAt))
			: localize('codeScrim.terminalActivitySummaryMany', "Terminal activity · {0} · {1} commands", this.formatTime(first.startedAt), this.selectedCommands.length);
		const header = DOM.append(this.popover, DOM.$('.codescrim-session-terminal-popover-header'));
		const heading = DOM.append(header, DOM.$('.codescrim-session-terminal-popover-title'));
		heading.appendChild(renderIcon(Codicon.terminal));
		DOM.append(heading, DOM.$('span', undefined, summary));
		const close = DOM.append(header, DOM.$('button.codescrim-session-terminal-popover-close', {
			type: 'button',
			title: localize('codeScrim.closeTerminalActivity', "Close terminal activity"),
			'aria-label': localize('codeScrim.closeTerminalActivity', "Close terminal activity"),
		})) as HTMLButtonElement;
		close.appendChild(renderIcon(Codicon.close));
		this.popoverListeners.add(DOM.addDisposableListener(close, DOM.EventType.CLICK, () => this.dismiss()));

		const list = DOM.append(this.popover, DOM.$('.codescrim-session-terminal-command-list'));
		for (const command of this.selectedCommands.slice(0, 5)) {
			const row = DOM.append(list, DOM.$('button.codescrim-session-terminal-command', {
				type: 'button',
				title: command.cwd ?? command.command,
			})) as HTMLButtonElement;
			DOM.append(row, DOM.$('code', undefined, command.command));
			DOM.append(row, DOM.$('span', undefined, this.commandMetadata(command)));
			this.popoverListeners.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => void this.select([command])));
		}
		if (this.selectedCommands.length > 5) {
			DOM.append(list, DOM.$('.codescrim-session-terminal-command-more', undefined,
				localize('codeScrim.moreTerminalCommands', "{0} more commands", this.selectedCommands.length - 5)));
		}
	}

	private commandMetadata(command: ICodeScrimTerminalCommandActivity): string {
		if (command.exitCode === undefined) {
			return command.terminalTitle;
		}
		return localize('codeScrim.terminalCommandExit', "{0} · Exit {1}", command.terminalTitle, command.exitCode);
	}

	private isVisible(): boolean {
		return this.contextKeyService.getContextKeyValue<boolean>(TerminalContextKeys.viewShowing.key) ?? false;
	}

	private formatTime(position: number): string {
		const totalSeconds = Math.floor(position / 1_000_000);
		return `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, '0')}`;
	}
}
