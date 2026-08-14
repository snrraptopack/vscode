/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CodeScrimPackageCodec, ICodeScrimPackageKey } from '../../common/codeScrimPackage.js';
import { ICodeScrimRecordingDraft } from '../../common/codeScrimRecording.js';

suite('CodeScrimPackageCodec', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round trips an encrypted content-addressed package', async () => {
		const codec = new CodeScrimPackageCodec();
		const key = await createKey('author-key');
		const draft = createDraft();

		const encoded = await codec.encode(draft, key);
		const decoded = await codec.decode(encoded, key);

		assert.deepStrictEqual({
			header: codec.inspect(encoded),
			decoded,
			plaintextVisible: encoded.toString().includes('private source text'),
		}, {
			header: { packageId: 'package-test', keyId: 'author-key', major: 3, minor: 0 },
			decoded: draft,
			plaintextVisible: false,
		});
	});

	test('rejects tampering before parsing instructor content', async () => {
		const codec = new CodeScrimPackageCodec();
		const key = await createKey('author-key');
		const encoded = await codec.encode(createDraft(), key);
		const tampered = encoded.clone();
		tampered.buffer[tampered.byteLength - 1] ^= 0xff;

		await assert.rejects(() => codec.decode(tampered, key), /corrupt, modified, or cannot be decrypted/);
	});

	test('rejects a package from another installation key', async () => {
		const codec = new CodeScrimPackageCodec();
		const encoded = await codec.encode(createDraft(), await createKey('first-key'));
		const secondKey = await createKey('second-key');

		await assert.rejects(() => codec.decode(encoded, secondKey), /different authoring key/);
	});

	test('rejects malformed framing and unsupported major versions', async () => {
		const codec = new CodeScrimPackageCodec();
		const key = await createKey('author-key');
		const encoded = await codec.encode(createDraft(), key);
		const unsupported = encoded.clone();
		const headerLength = new DataView(unsupported.buffer.buffer, unsupported.buffer.byteOffset + 8, 4).getUint32(0, false);
		const headerStart = 12;
		const header = JSON.parse(unsupported.slice(headerStart, headerStart + headerLength).toString());
		header.major = 9;
		const replacement = VSBuffer.fromString(JSON.stringify(header));
		assert.strictEqual(replacement.byteLength, headerLength);
		unsupported.set(replacement, headerStart);

		assert.throws(() => codec.inspect(VSBuffer.fromString('not a scrim')), /not a valid CodeScrim package/);
		assert.throws(() => codec.inspect(unsupported), /version 9\.0 is not supported/);
	});

	test('rejects obsolete development packages without a compatibility shim', async () => {
		const codec = new CodeScrimPackageCodec();
		const encoded = await codec.encode(createDraft(), await createKey('author-key'));
		const obsolete = encoded.clone();
		const headerLength = new DataView(obsolete.buffer.buffer, obsolete.buffer.byteOffset + 8, 4).getUint32(0, false);
		const headerStart = 12;
		const header = JSON.parse(obsolete.slice(headerStart, headerStart + headerLength).toString());
		header.major = 1;
		const replacement = VSBuffer.fromString(JSON.stringify(header));
		assert.strictEqual(replacement.byteLength, headerLength);
		obsolete.set(replacement, headerStart);

		assert.throws(() => codec.inspect(obsolete), /obsolete development format/);
	});
});

async function createKey(id: string): Promise<ICodeScrimPackageKey> {
	return {
		id,
		value: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
	};
}

function createDraft(): ICodeScrimRecordingDraft {
	return {
		id: 'package-test',
		duration: 2_000,
		checkpoints: [{
			timestamp: 0,
			eventIndex: 0,
			documents: [{
				resource: { root: 0, path: 'src/lesson.ts' },
				languageId: 'typescript',
				versionId: 1,
				eol: '\n',
				text: 'private source text',
			}],
			entries: [{
				resource: { root: 0, path: 'src/lesson.ts' },
				type: 'file',
				size: 19,
				contents: 'cHJpdmF0ZSBzb3VyY2UgdGV4dA==',
				text: true,
			}],
			skippedEntryCount: 0,
			terminals: [{ terminalId: 1, title: 'PowerShell', cols: 80, rows: 24, output: '\u001b[32mready\u001b[0m', exited: false }],
			activeTerminalId: 1,
		}],
		events: [{
			id: 'package-test:0',
			version: 1,
			timestamp: 1_000,
			sequence: 0,
			domain: 'editor',
			kind: 'editor.documentChanged',
			payload: {
				resource: { root: 0, path: 'src/lesson.ts' },
				languageId: 'typescript',
				versionId: 2,
				eol: '\n',
				text: 'private source text!',
				changes: [{ rangeOffset: 19, rangeLength: 0, text: '!' }],
				undoing: false,
				redoing: false,
			},
		}, {
			id: 'package-test:1',
			version: 1,
			timestamp: 1_500,
			sequence: 1,
			domain: 'terminal',
			kind: 'terminal.data',
			payload: { terminalId: 1, data: '\u001b[32mready\u001b[0m' },
		}],
	};
}
