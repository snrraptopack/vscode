/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { CodeScrimRecordingEventData } from '../common/codeScrimRecording.js';

/** Observes real workbench terminals while leaving terminal execution entirely to VS Code. */
export class CodeScrimTerminalRecorder {
	private readonly knownTerminalIds = new Set<number>();

	constructor(
		private readonly terminalService: ITerminalService,
		private readonly append: (event: CodeScrimRecordingEventData) => void,
	) { }

	reset(): void {
		this.knownTerminalIds.clear();
	}

	attach(listeners: DisposableStore): void {
		const currentIds = new Set(this.terminalService.instances.map(instance => instance.instanceId));
		for (const terminalId of [...this.knownTerminalIds]) {
			if (!currentIds.has(terminalId)) {
				this.append({ domain: 'terminal', kind: 'terminal.disposed', payload: { terminalId } });
				this.knownTerminalIds.delete(terminalId);
			}
		}
		for (const instance of this.terminalService.instances) {
			this.observe(instance, listeners);
		}
		listeners.add(this.terminalService.onDidCreateInstance(instance => this.observe(instance, listeners)));
		listeners.add(this.terminalService.onDidChangeActiveInstance(instance => this.append({
			domain: 'terminal',
			kind: 'terminal.activeChanged',
			payload: { terminalId: instance?.instanceId },
		})));
		listeners.add(this.terminalService.onDidChangeInstanceDimensions(instance => this.append({
			domain: 'terminal',
			kind: 'terminal.dimensionsChanged',
			payload: { terminalId: instance.instanceId, cols: instance.cols, rows: instance.rows },
		})));
		listeners.add(this.terminalService.onDidDisposeInstance(instance => {
			this.knownTerminalIds.delete(instance.instanceId);
			this.append({ domain: 'terminal', kind: 'terminal.disposed', payload: { terminalId: instance.instanceId } });
		}));
		this.append({
			domain: 'terminal',
			kind: 'terminal.activeChanged',
			payload: { terminalId: this.terminalService.activeInstance?.instanceId },
		});
	}

	private observe(instance: ITerminalInstance, listeners: DisposableStore): void {
		if (!this.knownTerminalIds.has(instance.instanceId)) {
			this.knownTerminalIds.add(instance.instanceId);
			this.append({
				domain: 'terminal',
				kind: 'terminal.created',
				payload: {
					terminalId: instance.instanceId,
					title: instance.title,
					cols: instance.cols,
					rows: instance.rows,
					cwd: instance.cwd,
				},
			});
		}
		listeners.add(instance.onData(data => this.append({
			domain: 'terminal',
			kind: 'terminal.data',
			payload: { terminalId: instance.instanceId, data },
		})));
		listeners.add(instance.onDidInputData(data => this.append({
			domain: 'terminal',
			kind: 'terminal.input',
			payload: { terminalId: instance.instanceId, data },
		})));
		listeners.add(instance.onTitleChanged(() => this.append({
			domain: 'terminal',
			kind: 'terminal.titleChanged',
			payload: { terminalId: instance.instanceId, title: instance.title },
		})));
		listeners.add(instance.onExit(exit => this.append({
			domain: 'terminal',
			kind: 'terminal.exited',
			payload: { terminalId: instance.instanceId, exitCode: typeof exit === 'number' ? exit : undefined },
		})));
	}
}
