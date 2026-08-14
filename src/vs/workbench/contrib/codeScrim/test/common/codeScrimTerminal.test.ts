/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CodeScrimRecordingEvent } from '../../common/codeScrimRecording.js';
import { clusterCodeScrimTerminalCommands, collectCodeScrimTerminalCommands } from '../../common/codeScrimReplay.js';
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

	test('tracks active switching between multiple terminals', () => {
		const state = new CodeScrimTerminalState();
		state.apply({ kind: 'terminal.created', payload: { terminalId: 1, title: 'Server', cols: 80, rows: 24 } });
		state.apply({ kind: 'terminal.created', payload: { terminalId: 2, title: 'Tests', cols: 80, rows: 24 } });
		state.apply({ kind: 'terminal.activeChanged', payload: { terminalId: 1 } });
		state.apply({ kind: 'terminal.activeChanged', payload: { terminalId: 2 } });

		assert.deepStrictEqual(state.snapshot, {
			terminals: [
				{ terminalId: 1, title: 'Server', cols: 80, rows: 24, output: '', exited: false },
				{ terminalId: 2, title: 'Tests', cols: 80, rows: 24, output: '', exited: false },
			],
			activeTerminalId: 2,
		});
	});

	test('collects structured command boundaries without changing terminal presentation', () => {
		const state = new CodeScrimTerminalState();
		state.apply({ kind: 'terminal.created', payload: { terminalId: 7, title: 'Tests', cols: 80, rows: 24 } });
		state.apply({
			kind: 'terminal.commandStarted',
			payload: { terminalId: 7, terminalTitle: 'Tests', commandId: '7:test', command: 'npm test', cwd: '/lesson', commandLineConfidence: 'high', isTrusted: true },
		});
		state.apply({ kind: 'terminal.commandFinished', payload: { terminalId: 7, commandId: '7:test', cwd: '/lesson', exitCode: 1 } });

		const events: CodeScrimRecordingEvent[] = [{
			id: 'start', version: 1, timestamp: 2_000_000, sequence: 0, domain: 'terminal', kind: 'terminal.commandStarted',
			payload: { terminalId: 7, terminalTitle: 'Tests', commandId: '7:test', command: 'npm test', cwd: '/lesson', commandLineConfidence: 'high', isTrusted: true },
		}, {
			id: 'finish', version: 1, timestamp: 5_500_000, sequence: 1, domain: 'terminal', kind: 'terminal.commandFinished',
			payload: { terminalId: 7, commandId: '7:test', cwd: '/lesson', exitCode: 1 },
		}];

		assert.deepStrictEqual({ state: state.snapshot, commands: collectCodeScrimTerminalCommands(events) }, {
			state: { terminals: [{ terminalId: 7, title: 'Tests', cols: 80, rows: 24, output: '', exited: false }] },
			commands: [{
				commandId: '7:test', terminalId: 7, terminalTitle: 'Tests', command: 'npm test', cwd: '/lesson',
				commandLineConfidence: 'high', isTrusted: true, startedAt: 2_000_000, finishedAt: 5_500_000, exitCode: 1,
			}],
		});
	});

	test('clusters nearby commands into quiet timeline activity', () => {
		const starts: CodeScrimRecordingEvent[] = [
			createCommandStart('first', 1_000_000, 0),
			createCommandStart('second', 1_500_000, 1),
			createCommandStart('third', 10_000_000, 2),
		];
		const clusters = clusterCodeScrimTerminalCommands(collectCodeScrimTerminalCommands(starts), 120_000_000);

		assert.deepStrictEqual(clusters.map(cluster => ({
			position: cluster.position,
			commands: cluster.commands.map(command => command.command),
		})), [{
			position: 1_000_000,
			commands: ['first', 'second'],
		}, {
			position: 10_000_000,
			commands: ['third'],
		}]);
	});
});

function createCommandStart(command: string, timestamp: number, sequence: number): CodeScrimRecordingEvent {
	return {
		id: command,
		version: 1,
		timestamp,
		sequence,
		domain: 'terminal',
		kind: 'terminal.commandStarted',
		payload: {
			terminalId: 1,
			terminalTitle: 'Shell',
			commandId: `1:${command}`,
			command,
			commandLineConfidence: 'high',
			isTrusted: true,
		},
	};
}
