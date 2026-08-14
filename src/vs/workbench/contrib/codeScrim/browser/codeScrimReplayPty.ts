/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProcessPropertyMap, IProcessReadyEvent, ITerminalChildProcess, ProcessPropertyType } from '../../../../platform/terminal/common/terminal.js';
import { BasePty } from '../../terminal/common/basePty.js';
import { ICodeScrimTerminalCheckpoint } from '../common/codeScrimTerminal.js';

/**
 * Read-only process behind CodeScrim's native replay terminals.
 *
 * This uses the same PTY contract as a live shell, so the normal integrated terminal owns
 * rendering, selection, accessibility and resizing. Only the process boundary differs:
 * recorded output is accepted, while keyboard and binary input are ignored.
 */
export class CodeScrimReplayPty extends BasePty implements ITerminalChildProcess {
	private started = false;
	private renderedOutput = '';
	private latest: ICodeScrimTerminalCheckpoint;

	constructor(
		id: number,
		recorded: ICodeScrimTerminalCheckpoint,
		cols: number,
		rows: number,
	) {
		super(id, false);
		this.latest = recorded;
		this._lastDimensions.cols = cols;
		this._lastDimensions.rows = rows;
		this.setRecordedProperties(recorded);
	}

	async start(): Promise<undefined> {
		this.started = true;
		const ready: IProcessReadyEvent = {
			pid: -1,
			cwd: this.latest.cwd ?? '',
			windowsPty: undefined,
		};
		this.handleReady(ready);
		this.writeOutput(this.latest.output);
		return undefined;
	}

	update(recorded: ICodeScrimTerminalCheckpoint): void {
		const previousTitle = this.latest.title;
		const previousCwd = this.latest.cwd;
		this.latest = recorded;
		this.setRecordedProperties(recorded);

		if (previousTitle !== recorded.title) {
			this.handleDidChangeProperty({ type: ProcessPropertyType.Title, value: this.displayTitle(recorded) });
		}
		if (previousCwd !== recorded.cwd) {
			this.handleDidChangeProperty({ type: ProcessPropertyType.Cwd, value: recorded.cwd ?? '' });
		}
		if (this.started) {
			this.writeOutput(recorded.output);
		}
	}

	input(_data: string): void {
		// Passive replay must never forward keystrokes to a shell or echo them locally.
	}

	resize(cols: number, rows: number): void {
		this._lastDimensions.cols = cols;
		this._lastDimensions.rows = rows;
	}

	shutdown(_immediate: boolean): void {
		this.handleExit(0);
	}

	clearBuffer(): void {
		this.renderedOutput = '';
		if (this.started) {
			this.handleData('\x1bc');
		}
	}

	acknowledgeDataEvent(_charCount: number): void {
		// Recorded output is local and does not need PTY flow control acknowledgements.
	}

	async setUnicodeVersion(_version: '6' | '11'): Promise<void> {
		// The native terminal emulator applies its configured Unicode version.
	}

	async processBinary(_data: string): Promise<void> {
		// Binary input is disabled for passive replay.
	}

	sendSignal(_signal: string): void {
		// There is no process to signal during passive replay.
	}

	async refreshProperty<T extends ProcessPropertyType>(type: T): Promise<IProcessPropertyMap[T]> {
		return this._properties[type];
	}

	async updateProperty<T extends ProcessPropertyType>(type: T, value: IProcessPropertyMap[T]): Promise<void> {
		this.handleDidChangeProperty({ type, value });
	}

	private setRecordedProperties(recorded: ICodeScrimTerminalCheckpoint): void {
		this._properties.title = this.displayTitle(recorded);
		this._properties.cwd = recorded.cwd ?? '';
		this._properties.initialCwd = recorded.cwd ?? '';
	}

	private displayTitle(recorded: ICodeScrimTerminalCheckpoint): string {
		return `${recorded.title || 'Terminal'} (Replay, read-only)`;
	}

	private writeOutput(output: string): void {
		if (output.startsWith(this.renderedOutput)) {
			const delta = output.slice(this.renderedOutput.length);
			if (delta) {
				this.handleData(delta);
			}
		} else {
			// Seeking can replace the full state. RIS clears the viewport and scrollback before
			// checkpoint output is reconstructed in this same native terminal instance.
			this.handleData(`\x1bc${output}`);
		}
		this.renderedOutput = output;
	}
}
