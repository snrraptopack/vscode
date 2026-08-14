/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ICodeScrimTerminalCheckpoint {
	readonly terminalId: number;
	readonly title: string;
	readonly cols: number;
	readonly rows: number;
	readonly cwd?: string;
	readonly output: string;
	readonly exited: boolean;
	readonly exitCode?: number;
}

export type CodeScrimTerminalEventData =
	| { readonly kind: 'terminal.created'; readonly payload: Omit<ICodeScrimTerminalCheckpoint, 'output' | 'exited' | 'exitCode'> }
	| { readonly kind: 'terminal.activeChanged'; readonly payload: { readonly terminalId?: number } }
	| { readonly kind: 'terminal.data'; readonly payload: { readonly terminalId: number; readonly data: string } }
	| { readonly kind: 'terminal.input'; readonly payload: { readonly terminalId: number; readonly data: string } }
	| { readonly kind: 'terminal.dimensionsChanged'; readonly payload: { readonly terminalId: number; readonly cols: number; readonly rows: number } }
	| { readonly kind: 'terminal.titleChanged'; readonly payload: { readonly terminalId: number; readonly title: string } }
	| { readonly kind: 'terminal.exited'; readonly payload: { readonly terminalId: number; readonly exitCode?: number } }
	| { readonly kind: 'terminal.disposed'; readonly payload: { readonly terminalId: number } };

export interface ICodeScrimTerminalState {
	readonly terminals: readonly ICodeScrimTerminalCheckpoint[];
	readonly activeTerminalId?: number;
}

/** Host-neutral terminal state used by both recording checkpoints and passive replay. */
export class CodeScrimTerminalState {
	private readonly terminals = new Map<number, ICodeScrimTerminalCheckpoint>();
	private activeTerminalId: number | undefined;

	get snapshot(): ICodeScrimTerminalState {
		return Object.freeze({
			terminals: Object.freeze([...this.terminals.values()].map(terminal => Object.freeze({ ...terminal }))),
			...(this.activeTerminalId === undefined ? {} : { activeTerminalId: this.activeTerminalId }),
		});
	}

	reset(state?: ICodeScrimTerminalState): void {
		this.terminals.clear();
		for (const terminal of state?.terminals ?? []) {
			this.terminals.set(terminal.terminalId, Object.freeze({ ...terminal }));
		}
		this.activeTerminalId = state?.activeTerminalId;
	}

	apply(event: CodeScrimTerminalEventData): void {
		switch (event.kind) {
			case 'terminal.created':
				this.terminals.set(event.payload.terminalId, Object.freeze({ ...event.payload, output: '', exited: false }));
				break;
			case 'terminal.activeChanged':
				this.activeTerminalId = event.payload.terminalId;
				break;
			case 'terminal.data':
				this.update(event.payload.terminalId, terminal => ({ ...terminal, output: terminal.output + event.payload.data }));
				break;
			case 'terminal.input':
				// PTY output normally echoes input. Keep input as semantic timeline data without
				// rendering it twice into the passive terminal snapshot.
				break;
			case 'terminal.dimensionsChanged':
				this.update(event.payload.terminalId, terminal => ({ ...terminal, cols: event.payload.cols, rows: event.payload.rows }));
				break;
			case 'terminal.titleChanged':
				this.update(event.payload.terminalId, terminal => ({ ...terminal, title: event.payload.title }));
				break;
			case 'terminal.exited':
				this.update(event.payload.terminalId, terminal => ({ ...terminal, exited: true, exitCode: event.payload.exitCode }));
				break;
			case 'terminal.disposed':
				this.terminals.delete(event.payload.terminalId);
				if (this.activeTerminalId === event.payload.terminalId) {
					this.activeTerminalId = undefined;
				}
				break;
		}
	}

	private update(terminalId: number, update: (terminal: ICodeScrimTerminalCheckpoint) => ICodeScrimTerminalCheckpoint): void {
		const terminal = this.terminals.get(terminalId);
		if (terminal) {
			this.terminals.set(terminalId, Object.freeze(update(terminal)));
		}
	}
}
