/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64 } from '../../../../base/common/buffer.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { EndOfLineSequence, ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { findCodeScrimActiveSurface, findCodeScrimBrowserPages, findCodeScrimBrowserScroll, findCodeScrimBrowserSnapshot } from '../common/codeScrimBrowser.js';
import { CodeScrimRecordingBuffer, CodeScrimRecordingEvent, CodeScrimTerminalEvent, ICodeScrimDocumentCheckpoint, ICodeScrimRecordingDraft, ICodeScrimScrollPosition, ICodeScrimSelection, ICodeScrimWorkspaceResource } from '../common/codeScrimRecording.js';
import { findCodeScrimCheckpoint, ICodeScrimReplaySurface } from '../common/codeScrimReplay.js';
import { CodeScrimTerminalReplay } from './codeScrimTerminalReplay.js';

interface IEditorPreviewState {
	readonly resource: ICodeScrimWorkspaceResource;
	readonly document: ICodeScrimDocumentCheckpoint;
	readonly selections?: readonly ICodeScrimSelection[];
	readonly scrollPosition?: ICodeScrimScrollPosition;
}

/** Builds scrub previews entirely in memory; no learner files are materialized. */
export class CodeScrimReplayPreview extends Disposable {
	private readonly models = this._register(new DisposableMap<string, ITextModel>());

	constructor(
		private readonly modelService: IModelService,
		private readonly languageService: ILanguageService,
	) {
		super();
	}

	show(draft: ICodeScrimRecordingDraft, position: number, surface: ICodeScrimReplaySurface | undefined, terminal: CodeScrimTerminalReplay): void {
		const target = Math.min(draft.duration, Math.max(0, Math.round(position)));
		const checkpoint = findCodeScrimCheckpoint(draft.checkpoints, target);
		const events = eventsThrough(draft.events, checkpoint.eventIndex, target);
		const editor = buildEditorPreview(checkpoint.documents, checkpoint.activeResource, checkpoint.selections, checkpoint.scrollPosition, events);
		if (editor && surface) {
			surface.previewResource(editor.resource, this.getModel(draft.id, editor), editor.selections, editor.scrollPosition);
		}
		terminal.preview(
			{ terminals: checkpoint.terminals, activeTerminalId: checkpoint.activeTerminalId },
			events.filter((event): event is CodeScrimTerminalEvent => event.domain === 'terminal'),
		);
		const browserSnapshot = findCodeScrimBrowserSnapshot(draft.browser, target);
		surface?.showBrowserSnapshot(
			browserSnapshot,
			findCodeScrimBrowserScroll(draft.browser, target, browserSnapshot?.pageId)?.scrollTop,
			findCodeScrimBrowserPages(draft.browser, target),
			findCodeScrimActiveSurface(draft.browser, target),
		);
	}

	clear(): void {
		this.models.clearAndDisposeAll();
	}

	private getModel(draftId: string, preview: IEditorPreviewState): ITextModel {
		const key = CodeScrimRecordingBuffer.resourceKey(preview.resource);
		let model = this.models.get(key);
		if (!model || model.isDisposed()) {
			const uri = URI.from({ scheme: 'codescrim-preview', authority: draftId, path: `/${preview.resource.root}/${preview.resource.path}` });
			const language = preview.document.languageId
				? this.languageService.createById(preview.document.languageId)
				: this.languageService.createByFilepathOrFirstLine(uri, preview.document.text.split(/\r?\n/, 1)[0]);
			model = this.modelService.createModel(preview.document.text, language, uri, true);
			this.models.set(key, model);
		} else if (model.getValue() !== preview.document.text) {
			model.setValue(preview.document.text);
		}
		if (model.getEOL() !== preview.document.eol) {
			model.setEOL(preview.document.eol === '\r\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF);
		}
		return model;
	}
}

function eventsThrough(events: readonly CodeScrimRecordingEvent[], start: number, target: number): readonly CodeScrimRecordingEvent[] {
	let end = start;
	while (end < events.length && events[end].timestamp <= target) {
		end++;
	}
	return events.slice(start, end);
}

function buildEditorPreview(
	checkpointDocuments: readonly ICodeScrimDocumentCheckpoint[],
	checkpointResource: ICodeScrimWorkspaceResource | undefined,
	checkpointSelections: readonly ICodeScrimSelection[] | undefined,
	checkpointScroll: ICodeScrimScrollPosition | undefined,
	events: readonly CodeScrimRecordingEvent[],
): IEditorPreviewState | undefined {
	const documents = new Map(checkpointDocuments.map(document => [CodeScrimRecordingBuffer.resourceKey(document.resource), document]));
	const selections = new Map<string, readonly ICodeScrimSelection[]>();
	const scrollPositions = new Map<string, ICodeScrimScrollPosition>();
	let activeResource = checkpointResource;
	if (activeResource && checkpointSelections) {
		selections.set(CodeScrimRecordingBuffer.resourceKey(activeResource), checkpointSelections);
	}
	if (activeResource && checkpointScroll) {
		scrollPositions.set(CodeScrimRecordingBuffer.resourceKey(activeResource), checkpointScroll);
	}

	for (const event of events) {
		switch (event.kind) {
			case 'workspace.entriesChanged':
				for (const resource of event.payload.deleted) {
					const key = CodeScrimRecordingBuffer.resourceKey(resource);
					documents.delete(key);
					if (activeResource && CodeScrimRecordingBuffer.resourceKey(activeResource) === key) {
						activeResource = undefined;
					}
				}
				for (const entry of event.payload.created) {
					if (entry.type === 'file' && entry.text && entry.contents !== undefined) {
						documents.set(CodeScrimRecordingBuffer.resourceKey(entry.resource), {
							resource: entry.resource,
							languageId: '',
							versionId: 1,
							eol: '\n',
							text: decodeBase64(entry.contents).toString(),
						});
					}
				}
				break;
			case 'editor.activeResourceChanged':
				activeResource = event.payload.resource;
				break;
			case 'editor.documentChanged': {
				const key = CodeScrimRecordingBuffer.resourceKey(event.payload.resource);
				const previous = documents.get(key);
				const text = event.payload.text ?? applyTextChanges(previous?.text ?? '', event.payload.changes);
				documents.set(key, {
					resource: event.payload.resource,
					languageId: event.payload.languageId,
					versionId: event.payload.versionId,
					eol: event.payload.eol,
					text,
				});
				break;
			}
			case 'editor.selectionChanged':
				selections.set(CodeScrimRecordingBuffer.resourceKey(event.payload.resource), event.payload.selections);
				break;
			case 'editor.scrollChanged':
				scrollPositions.set(CodeScrimRecordingBuffer.resourceKey(event.payload.resource), event.payload);
				break;
		}
	}
	if (!activeResource) {
		return undefined;
	}
	const key = CodeScrimRecordingBuffer.resourceKey(activeResource);
	const document = documents.get(key);
	return document ? { resource: activeResource, document, selections: selections.get(key), scrollPosition: scrollPositions.get(key) } : undefined;
}

function applyTextChanges(text: string, changes: readonly { readonly rangeOffset: number; readonly rangeLength: number; readonly text: string }[]): string {
	for (const change of [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset)) {
		text = text.slice(0, change.rangeOffset) + change.text + text.slice(change.rangeOffset + change.rangeLength);
	}
	return text;
}
