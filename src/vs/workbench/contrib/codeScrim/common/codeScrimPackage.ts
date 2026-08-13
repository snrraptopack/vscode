/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { CodeScrimRecordingEvent, ICodeScrimDocumentCheckpoint, ICodeScrimRecordingCheckpoint, ICodeScrimRecordingDraft, ICodeScrimWorkspaceEntryCheckpoint, ICodeScrimWorkspaceResource } from './codeScrimRecording.js';

export const CODE_SCRIM_SAVE_RECORDING_COMMAND_ID = 'codescrim.saveRecording';
export const CODE_SCRIM_OPEN_RECORDING_COMMAND_ID = 'codescrim.openRecording';
export const CODE_SCRIM_PACKAGE_EXTENSION = 'scrim';

const PACKAGE_MAGIC = new Uint8Array([0x43, 0x4f, 0x44, 0x45, 0x53, 0x43, 0x52, 0x4d]); // CODESCRM
const PACKAGE_MAJOR_VERSION = 1;
const PACKAGE_MINOR_VERSION = 0;
const PACKAGE_HEADER_LENGTH_BYTES = 4;
const PACKAGE_MAX_HEADER_BYTES = 16 * 1024;
const PACKAGE_MAX_ENCRYPTED_BYTES = 256 * 1024 * 1024;
const PACKAGE_MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const PACKAGE_MAX_EVENT_COUNT = 2_000_000;
const PACKAGE_MAX_ENTRY_COUNT = 100_000;
const PACKAGE_EVENT_CHUNK_SIZE = 500;
const PACKAGE_KEY_ALGORITHM = 'AES-GCM';
const PACKAGE_IV_LENGTH = 12;

interface ICodeScrimPackageHeader {
	readonly format: 'codescrim';
	readonly major: number;
	readonly minor: number;
	readonly packageId: string;
	readonly keyId: string;
	readonly cipher: 'AES-256-GCM';
	readonly compression: 'gzip';
	readonly iv: string;
	readonly encryptedLength: number;
}

interface ICodeScrimPackagedDocument extends Omit<ICodeScrimDocumentCheckpoint, 'text'> {
	readonly textBlob: string;
}

interface ICodeScrimPackagedEntry extends Omit<ICodeScrimWorkspaceEntryCheckpoint, 'contents'> {
	readonly contentsBlob?: string;
}

interface ICodeScrimEventChunk {
	readonly blob: string;
	readonly firstTimestamp: number;
	readonly lastTimestamp: number;
	readonly firstSequence: number;
	readonly eventCount: number;
}

interface ICodeScrimPackagePayload {
	readonly manifest: {
		readonly format: 'codescrim-session';
		readonly schemaVersion: 1;
		readonly sessionId: string;
		readonly duration: number;
		readonly timebase: 'microseconds';
		readonly eventCount: number;
		readonly checkpoint: {
			readonly documents: readonly ICodeScrimPackagedDocument[];
			readonly entries: readonly ICodeScrimPackagedEntry[];
			readonly skippedEntryCount: number;
		};
		readonly eventChunks: readonly ICodeScrimEventChunk[];
	};
	readonly blobs: Readonly<Record<string, string>>;
}

export interface ICodeScrimPackageKey {
	readonly id: string;
	readonly value: CryptoKey;
}

export interface ICodeScrimPackageSummary {
	readonly packageId: string;
	readonly keyId: string;
	readonly major: number;
	readonly minor: number;
}

/**
 * Encodes the portable session model into a framed, compressed, authenticated binary package.
 * Only the routing header is public; instructor content and metadata are inside AES-GCM ciphertext.
 */
export class CodeScrimPackageCodec {

	async encode(draft: ICodeScrimRecordingDraft, key: ICodeScrimPackageKey): Promise<VSBuffer> {
		validateDraft(draft);
		const payload = await this.createPayload(draft);
		const compressed = await compress(VSBuffer.fromString(JSON.stringify(payload)).buffer);
		const iv = crypto.getRandomValues(new Uint8Array(PACKAGE_IV_LENGTH));
		const authenticatedHeader = this.createAuthenticatedHeader(draft.id, key.id);
		const encrypted = new Uint8Array(await crypto.subtle.encrypt(
			{ name: PACKAGE_KEY_ALGORITHM, iv: asArrayBufferView(iv), additionalData: asArrayBufferView(VSBuffer.fromString(authenticatedHeader).buffer) },
			key.value,
			asArrayBufferView(compressed),
		));
		const header: ICodeScrimPackageHeader = {
			format: 'codescrim',
			major: PACKAGE_MAJOR_VERSION,
			minor: PACKAGE_MINOR_VERSION,
			packageId: draft.id,
			keyId: key.id,
			cipher: 'AES-256-GCM',
			compression: 'gzip',
			iv: encodeBase64(VSBuffer.wrap(iv)),
			encryptedLength: encrypted.byteLength,
		};
		const headerBytes = VSBuffer.fromString(JSON.stringify(header));
		if (headerBytes.byteLength > PACKAGE_MAX_HEADER_BYTES) {
			throw new Error('The CodeScrim package header exceeds its safety limit.');
		}

		const length = VSBuffer.alloc(PACKAGE_HEADER_LENGTH_BYTES);
		new DataView(length.buffer.buffer, length.buffer.byteOffset, length.byteLength).setUint32(0, headerBytes.byteLength, false);
		return VSBuffer.concat([VSBuffer.wrap(PACKAGE_MAGIC), length, headerBytes, VSBuffer.wrap(encrypted)]);
	}

	inspect(packageBytes: VSBuffer): ICodeScrimPackageSummary {
		const header = this.readHeader(packageBytes).header;
		return { packageId: header.packageId, keyId: header.keyId, major: header.major, minor: header.minor };
	}

	async decode(packageBytes: VSBuffer, key: ICodeScrimPackageKey): Promise<ICodeScrimRecordingDraft> {
		const framed = this.readHeader(packageBytes);
		if (framed.header.keyId !== key.id) {
			throw new Error('This CodeScrim package was encrypted with a different authoring key.');
		}

		let compressed: Uint8Array;
		try {
			compressed = new Uint8Array(await crypto.subtle.decrypt(
				{
					name: PACKAGE_KEY_ALGORITHM,
					iv: asArrayBufferView(decodeBase64(framed.header.iv).buffer),
					additionalData: asArrayBufferView(VSBuffer.fromString(this.createAuthenticatedHeader(framed.header.packageId, framed.header.keyId)).buffer),
				},
				key.value,
				asArrayBufferView(framed.encrypted),
			));
		} catch {
			throw new Error('The CodeScrim package is corrupt, modified, or cannot be decrypted by this installation.');
		}

		let candidate: unknown;
		try {
			candidate = JSON.parse(VSBuffer.wrap(await decompress(compressed, PACKAGE_MAX_EXPANDED_BYTES)).toString());
		} catch {
			throw new Error('The CodeScrim package payload is invalid.');
		}
		const payload = parsePayload(candidate);
		const draft = await this.restoreDraft(payload);
		validateDraft(draft);
		return draft;
	}

	private async createPayload(draft: ICodeScrimRecordingDraft): Promise<ICodeScrimPackagePayload> {
		const blobs: Record<string, string> = Object.create(null);
		const storeBlob = async (bytes: Uint8Array): Promise<string> => {
			const digest = await sha256(bytes);
			blobs[digest] ??= encodeBase64(VSBuffer.wrap(bytes));
			return digest;
		};

		const documents: ICodeScrimPackagedDocument[] = [];
		for (const document of draft.checkpoint.documents) {
			documents.push({
				resource: document.resource,
				languageId: document.languageId,
				versionId: document.versionId,
				eol: document.eol,
				textBlob: await storeBlob(VSBuffer.fromString(document.text).buffer),
			});
		}

		const entries: ICodeScrimPackagedEntry[] = [];
		for (const entry of draft.checkpoint.entries) {
			const { contents, ...metadata } = entry;
			entries.push({
				...metadata,
				contentsBlob: contents === undefined ? undefined : await storeBlob(decodeBase64(contents).buffer),
			});
		}

		const eventChunks: ICodeScrimEventChunk[] = [];
		for (let start = 0; start < draft.events.length; start += PACKAGE_EVENT_CHUNK_SIZE) {
			const events = draft.events.slice(start, start + PACKAGE_EVENT_CHUNK_SIZE);
			const bytes = VSBuffer.fromString(JSON.stringify(events)).buffer;
			eventChunks.push({
				blob: await storeBlob(bytes),
				firstTimestamp: events[0].timestamp,
				lastTimestamp: events[events.length - 1].timestamp,
				firstSequence: events[0].sequence,
				eventCount: events.length,
			});
		}

		return {
			manifest: {
				format: 'codescrim-session',
				schemaVersion: 1,
				sessionId: draft.id,
				duration: draft.duration,
				timebase: 'microseconds',
				eventCount: draft.events.length,
				checkpoint: { documents, entries, skippedEntryCount: draft.checkpoint.skippedEntryCount },
				eventChunks,
			},
			blobs,
		};
	}

	private async restoreDraft(payload: ICodeScrimPackagePayload): Promise<ICodeScrimRecordingDraft> {
		const readBlob = async (digest: string): Promise<VSBuffer> => {
			const encoded = payload.blobs[digest];
			if (typeof encoded !== 'string') {
				throw new Error(`The CodeScrim package references missing blob ${digest}.`);
			}
			const bytes = decodeBase64(encoded);
			if (await sha256(bytes.buffer) !== digest) {
				throw new Error(`The CodeScrim package blob ${digest} failed integrity validation.`);
			}
			return bytes;
		};

		const documents: ICodeScrimDocumentCheckpoint[] = [];
		for (const document of payload.manifest.checkpoint.documents) {
			documents.push({
				resource: document.resource,
				languageId: document.languageId,
				versionId: document.versionId,
				eol: document.eol,
				text: (await readBlob(document.textBlob)).toString(),
			});
		}

		const entries: ICodeScrimWorkspaceEntryCheckpoint[] = [];
		for (const entry of payload.manifest.checkpoint.entries) {
			const { contentsBlob, ...metadata } = entry;
			entries.push({
				...metadata,
				contents: contentsBlob === undefined ? undefined : encodeBase64(await readBlob(contentsBlob)),
			});
		}

		const events: CodeScrimRecordingEvent[] = [];
		for (const chunk of payload.manifest.eventChunks) {
			let chunkCandidate: unknown;
			try {
				chunkCandidate = JSON.parse((await readBlob(chunk.blob)).toString());
			} catch {
				throw new Error('A CodeScrim event chunk is invalid.');
			}
			if (!Array.isArray(chunkCandidate) || chunkCandidate.length !== chunk.eventCount) {
				throw new Error('A CodeScrim event chunk does not match its index.');
			}
			events.push(...chunkCandidate as CodeScrimRecordingEvent[]);
		}
		if (events.length !== payload.manifest.eventCount) {
			throw new Error('The CodeScrim event index is incomplete.');
		}

		const checkpoint: ICodeScrimRecordingCheckpoint = {
			documents,
			entries,
			skippedEntryCount: payload.manifest.checkpoint.skippedEntryCount,
		};
		return { id: payload.manifest.sessionId, duration: payload.manifest.duration, checkpoint, events };
	}

	private readHeader(packageBytes: VSBuffer): { readonly header: ICodeScrimPackageHeader; readonly encrypted: Uint8Array } {
		const minimumLength = PACKAGE_MAGIC.byteLength + PACKAGE_HEADER_LENGTH_BYTES;
		if (packageBytes.byteLength < minimumLength || packageBytes.byteLength > PACKAGE_MAX_ENCRYPTED_BYTES) {
			throw new Error('The selected file is not a valid CodeScrim package.');
		}
		for (let index = 0; index < PACKAGE_MAGIC.byteLength; index++) {
			if (packageBytes.buffer[index] !== PACKAGE_MAGIC[index]) {
				throw new Error('The selected file is not a CodeScrim package.');
			}
		}

		const headerLength = new DataView(packageBytes.buffer.buffer, packageBytes.buffer.byteOffset + PACKAGE_MAGIC.byteLength, PACKAGE_HEADER_LENGTH_BYTES).getUint32(0, false);
		const encryptedOffset = minimumLength + headerLength;
		if (headerLength <= 0 || headerLength > PACKAGE_MAX_HEADER_BYTES || encryptedOffset > packageBytes.byteLength) {
			throw new Error('The CodeScrim package header is invalid.');
		}

		let candidate: unknown;
		try {
			candidate = JSON.parse(packageBytes.slice(minimumLength, encryptedOffset).toString());
		} catch {
			throw new Error('The CodeScrim package header is invalid.');
		}
		const header = parseHeader(candidate);
		if (header.major !== PACKAGE_MAJOR_VERSION) {
			throw new Error(`CodeScrim package version ${header.major}.${header.minor} is not supported by this installation.`);
		}
		const encrypted = packageBytes.buffer.slice(encryptedOffset);
		if (header.encryptedLength !== encrypted.byteLength) {
			throw new Error('The CodeScrim package is truncated or has trailing data.');
		}
		return { header, encrypted };
	}

	private createAuthenticatedHeader(packageId: string, keyId: string): string {
		return JSON.stringify({ format: 'codescrim', major: PACKAGE_MAJOR_VERSION, packageId, keyId, cipher: 'AES-256-GCM', compression: 'gzip' });
	}
}

export const ICodeScrimPackageService = createDecorator<ICodeScrimPackageService>('codeScrimPackageService');

export interface ICodeScrimPackageService {
	readonly _serviceBrand: undefined;

	saveDraft(draft: ICodeScrimRecordingDraft): Promise<void>;
	loadDraft(): Promise<ICodeScrimRecordingDraft | undefined>;
	deleteDraft(): Promise<void>;
	savePackage(resource: URI, draft: ICodeScrimRecordingDraft): Promise<void>;
	openPackage(resource: URI): Promise<ICodeScrimRecordingDraft>;
}

function parseHeader(candidate: unknown): ICodeScrimPackageHeader {
	if (!isRecord(candidate) || candidate.format !== 'codescrim' || !isSafeInteger(candidate.major) || !isSafeInteger(candidate.minor) ||
		typeof candidate.packageId !== 'string' || !candidate.packageId || typeof candidate.keyId !== 'string' || !candidate.keyId ||
		candidate.cipher !== 'AES-256-GCM' || candidate.compression !== 'gzip' || typeof candidate.iv !== 'string' ||
		!isSafeInteger(candidate.encryptedLength) || candidate.encryptedLength <= 0) {
		throw new Error('The CodeScrim package header is invalid.');
	}
	return candidate as unknown as ICodeScrimPackageHeader;
}

function parsePayload(candidate: unknown): ICodeScrimPackagePayload {
	if (!isRecord(candidate) || !isRecord(candidate.manifest) || candidate.manifest.format !== 'codescrim-session' ||
		candidate.manifest.schemaVersion !== 1 || typeof candidate.manifest.sessionId !== 'string' || !candidate.manifest.sessionId ||
		!isSafeInteger(candidate.manifest.duration) || candidate.manifest.duration < 0 || candidate.manifest.timebase !== 'microseconds' ||
		!isSafeInteger(candidate.manifest.eventCount) || candidate.manifest.eventCount < 0 || candidate.manifest.eventCount > PACKAGE_MAX_EVENT_COUNT ||
		!isRecord(candidate.manifest.checkpoint) || !Array.isArray(candidate.manifest.checkpoint.documents) ||
		!Array.isArray(candidate.manifest.checkpoint.entries) || !Array.isArray(candidate.manifest.eventChunks) || !isRecord(candidate.blobs)) {
		throw new Error('The CodeScrim package manifest is invalid.');
	}
	if (candidate.manifest.checkpoint.documents.length > PACKAGE_MAX_ENTRY_COUNT || candidate.manifest.checkpoint.entries.length > PACKAGE_MAX_ENTRY_COUNT) {
		throw new Error('The CodeScrim package checkpoint exceeds its safety limit.');
	}
	return candidate as unknown as ICodeScrimPackagePayload;
}

function validateDraft(draft: ICodeScrimRecordingDraft): void {
	if (!draft || typeof draft.id !== 'string' || !draft.id || !isSafeInteger(draft.duration) || draft.duration < 0 ||
		!draft.checkpoint || !Array.isArray(draft.checkpoint.documents) || !Array.isArray(draft.checkpoint.entries) || !Array.isArray(draft.events) ||
		draft.events.length > PACKAGE_MAX_EVENT_COUNT || draft.checkpoint.entries.length > PACKAGE_MAX_ENTRY_COUNT || draft.checkpoint.documents.length > PACKAGE_MAX_ENTRY_COUNT) {
		throw new Error('The CodeScrim recording is invalid.');
	}

	let previousSequence = -1;
	for (const document of draft.checkpoint.documents) {
		validateResource(document.resource);
		if (typeof document.languageId !== 'string' || typeof document.text !== 'string' || typeof document.eol !== 'string' || !isSafeInteger(document.versionId)) {
			throw new Error('The CodeScrim document checkpoint is invalid.');
		}
	}
	for (const entry of draft.checkpoint.entries) {
		validateResource(entry.resource);
		if ((entry.type !== 'file' && entry.type !== 'directory') || typeof entry.text !== 'boolean' || (entry.contents !== undefined && typeof entry.contents !== 'string')) {
			throw new Error('The CodeScrim workspace checkpoint is invalid.');
		}
	}
	for (const event of draft.events) {
		if (!event || typeof event.id !== 'string' || event.version !== 1 || !isSafeInteger(event.timestamp) || event.timestamp < 0 ||
			!isSafeInteger(event.sequence) || event.sequence < 0 || event.sequence <= previousSequence ||
			(event.domain !== 'editor' && event.domain !== 'workspace') || typeof event.kind !== 'string' || !isRecord(event.payload)) {
			throw new Error('The CodeScrim event stream is invalid or out of order.');
		}
		validateEventPayload(event);
		previousSequence = event.sequence;
	}
}

function validateEventPayload(event: CodeScrimRecordingEvent): void {
	switch (event.kind) {
		case 'editor.activeResourceChanged':
			if (event.payload.resource !== undefined) {
				validateResource(event.payload.resource);
			}
			return;
		case 'editor.documentChanged':
			validateResource(event.payload.resource);
			if (!isSafeInteger(event.payload.versionId) || typeof event.payload.eol !== 'string' ||
				(event.payload.text !== undefined && typeof event.payload.text !== 'string') || !Array.isArray(event.payload.changes) ||
				event.payload.changes.some(change => !isSafeInteger(change.rangeOffset) || change.rangeOffset < 0 ||
					!isSafeInteger(change.rangeLength) || change.rangeLength < 0 || typeof change.text !== 'string') ||
				typeof event.payload.undoing !== 'boolean' || typeof event.payload.redoing !== 'boolean') {
				throw new Error('The CodeScrim document-change event is invalid.');
			}
			return;
		case 'editor.selectionChanged':
			validateResource(event.payload.resource);
			if (!isSafeInteger(event.payload.modelVersionId) || !Array.isArray(event.payload.selections) ||
				event.payload.selections.some(selection => !isPositiveInteger(selection.selectionStartLineNumber) ||
					!isPositiveInteger(selection.selectionStartColumn) || !isPositiveInteger(selection.positionLineNumber) ||
					!isPositiveInteger(selection.positionColumn))) {
				throw new Error('The CodeScrim selection event is invalid.');
			}
			return;
		case 'editor.documentSaved':
			validateResource(event.payload.resource);
			if (event.payload.reason !== undefined && !isSafeInteger(event.payload.reason)) {
				throw new Error('The CodeScrim save event is invalid.');
			}
			return;
		case 'workspace.entriesChanged':
			if (!Array.isArray(event.payload.deleted) || !Array.isArray(event.payload.created)) {
				throw new Error('The CodeScrim workspace event is invalid.');
			}
			for (const resource of event.payload.deleted) {
				validateResource(resource);
			}
			for (const entry of event.payload.created) {
				validateResource(entry.resource);
				if ((entry.type !== 'file' && entry.type !== 'directory') || typeof entry.text !== 'boolean' ||
					(entry.contents !== undefined && typeof entry.contents !== 'string')) {
					throw new Error('The CodeScrim workspace event entry is invalid.');
				}
			}
			return;
	}
}

function validateResource(resource: ICodeScrimWorkspaceResource): void {
	if (!resource || !isSafeInteger(resource.root) || resource.root < 0 || typeof resource.path !== 'string' || !resource.path ||
		resource.path.startsWith('/') || resource.path.includes('\\') || resource.path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
		throw new Error('The CodeScrim package contains an unsafe workspace path.');
	}
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
	return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function isSafeInteger(candidate: unknown): candidate is number {
	return typeof candidate === 'number' && Number.isSafeInteger(candidate);
}

function isPositiveInteger(candidate: unknown): candidate is number {
	return isSafeInteger(candidate) && candidate > 0;
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', asArrayBufferView(bytes)));
	return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
}

async function compress(bytes: Uint8Array): Promise<Uint8Array> {
	return transform(bytes, new CompressionStream('gzip'));
}

async function decompress(bytes: Uint8Array, maximumBytes: number): Promise<Uint8Array> {
	return transform(bytes, new DecompressionStream('gzip'), maximumBytes);
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, maximumBytes = Number.POSITIVE_INFINITY): Promise<Uint8Array> {
	const source = new Response(asArrayBufferView(bytes)).body;
	if (!source) {
		throw new Error('CodeScrim could not create a package byte stream.');
	}
	// Reading and writing must run as one pipeline; awaiting writes first can deadlock on backpressure.
	const reader = source.pipeThrough(stream).getReader();
	const chunks: VSBuffer[] = [];
	let totalLength = 0;
	while (true) {
		const result = await reader.read();
		if (result.done) {
			break;
		}
		totalLength += result.value.byteLength;
		if (totalLength > maximumBytes) {
			await reader.cancel();
			throw new Error('The CodeScrim package expands beyond its safety limit.');
		}
		chunks.push(VSBuffer.wrap(result.value));
	}
	return VSBuffer.concat(chunks, totalLength).buffer;
}

function asArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer) {
		return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}
	return new Uint8Array(bytes);
}
