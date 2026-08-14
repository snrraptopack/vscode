/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CodeScrimTerminalState } from '../../common/codeScrimTerminal.js';

suite('CodeScrimTerminalState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reconstructs output without echoing semantic input', () => {
		const state = new CodeScrimTerminalState();
		state.apply({ kind: 'terminal.created', payload: { terminalId: 1, title: 'shell', cols: 80, rows: 24 } });
		state.apply({ kind: 'terminal.input', payload: { terminalId: 1, data: 'echo hello\r' } });
		state.apply({ kind: 'terminal.data', payload: { terminalId: 1, data: 'echo hello\r\nhello\r\n' } });
		state.apply({ kind: 'terminal.activeChanged', payload: { terminalId: 1 } });

		assert.strictEqual(state.snapshot.terminals[0].output, 'echo hello\r\nhello\r\n');
		assert.strictEqual(state.snapshot.activeTerminalId, 1);
	});

	test('restores and advances a checkpoint independently', () => {
		const state = new CodeScrimTerminalState();
		state.reset({ terminals: [{ terminalId: 2, title: 'shell', cols: 100, rows: 30, output: 'before', exited: false }], activeTerminalId: 2 });
		state.apply({ kind: 'terminal.data', payload: { terminalId: 2, data: ' after' } });

		assert.strictEqual(state.snapshot.terminals[0].output, 'before after');
	});
});
