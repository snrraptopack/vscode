/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICommandDetectionCapability, ITerminalCommand, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { ITerminalInstance } from '../../terminal/browser/terminal.js';
import { CodeScrimRecordingEventData } from '../common/codeScrimRecording.js';

/** Captures trusted shell-integration boundaries without invoking or re-running a command. */
export class CodeScrimTerminalCommandRecorder {
	private readonly observedCapabilities = new Set<ICommandDetectionCapability>();
	private readonly commandIds = new WeakMap<ITerminalCommand, string>();
	private readonly startedCommandIds = new Set<string>();
	private commandSequence = 0;

	constructor(private readonly append: (event: CodeScrimRecordingEventData) => void) { }

	observe(instance: ITerminalInstance, listeners: DisposableStore): void {
		const commandDetection = instance.capabilities.get(TerminalCapability.CommandDetection);
		if (commandDetection) {
			this.observeCapability(instance, commandDetection, listeners);
		}
		listeners.add(instance.capabilities.onDidAddCommandDetectionCapability(capability => {
			this.observeCapability(instance, capability, listeners);
		}));
	}

	private observeCapability(instance: ITerminalInstance, capability: ICommandDetectionCapability, listeners: DisposableStore): void {
		if (this.observedCapabilities.has(capability)) {
			return;
		}
		this.observedCapabilities.add(capability);
		listeners.add(capability.onCommandExecuted(command => this.recordStarted(instance, command)));
		listeners.add(capability.onCommandFinished(command => this.recordFinished(instance, command)));
	}

	private recordStarted(instance: ITerminalInstance, command: ITerminalCommand): void {
		if (!command.command.trim()) {
			return;
		}
		const commandId = this.getCommandId(instance.instanceId, command);
		if (this.startedCommandIds.has(commandId)) {
			return;
		}
		this.startedCommandIds.add(commandId);
		this.append({
			domain: 'terminal',
			kind: 'terminal.commandStarted',
			payload: {
				terminalId: instance.instanceId,
				terminalTitle: instance.title,
				commandId,
				command: command.command,
				cwd: command.cwd ?? instance.cwd,
				commandLineConfidence: command.commandLineConfidence,
				isTrusted: command.isTrusted,
			},
		});
	}

	private recordFinished(instance: ITerminalInstance, command: ITerminalCommand): void {
		if (!command.command.trim()) {
			return;
		}
		this.recordStarted(instance, command);
		const commandId = this.getCommandId(instance.instanceId, command);
		this.append({
			domain: 'terminal',
			kind: 'terminal.commandFinished',
			payload: {
				terminalId: instance.instanceId,
				commandId,
				cwd: command.cwd ?? instance.cwd,
				exitCode: command.exitCode,
			},
		});
	}

	private getCommandId(terminalId: number, command: ITerminalCommand): string {
		let commandId = this.commandIds.get(command);
		if (!commandId) {
			commandId = command.id ? `${terminalId}:${command.id}` : `${terminalId}:command-${this.commandSequence++}`;
			this.commandIds.set(command, commandId);
		}
		return commandId;
	}
}
