/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CodeScrimTerminalEvent } from '../common/codeScrimRecording.js';
import { CodeScrimTerminalState, ICodeScrimTerminalState } from '../common/codeScrimTerminal.js';

/** Reconstructs terminal state without creating a process or forwarding recorded input. */
export class CodeScrimTerminalReplay extends Disposable {
	private readonly stateStore = new CodeScrimTerminalState();
	private readonly _onDidChangeState = this._register(new Emitter<ICodeScrimTerminalState>());
	readonly onDidChangeState: Event<ICodeScrimTerminalState> = this._onDidChangeState.event;

	get state(): ICodeScrimTerminalState {
		return this.stateStore.snapshot;
	}

	reset(state?: ICodeScrimTerminalState): void {
		this.stateStore.reset(state);
		this._onDidChangeState.fire(this.state);
	}

	apply(event: CodeScrimTerminalEvent): void {
		this.stateStore.apply(event);
		this._onDidChangeState.fire(this.state);
	}
}
