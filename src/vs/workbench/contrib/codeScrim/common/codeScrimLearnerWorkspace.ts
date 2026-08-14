/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ICodeScrimRecordingCheckpoint, ICodeScrimRecordingDraft, ICodeScrimWorkspaceEntryCheckpoint, ICodeScrimWorkspaceResource } from './codeScrimRecording.js';

export const ICodeScrimLearnerWorkspaceService = createDecorator<ICodeScrimLearnerWorkspaceService>('codeScrimLearnerWorkspaceService');

/** Owns the disposable file-system projection of a learner replay session. */
export interface ICodeScrimLearnerWorkspaceService {
	readonly _serviceBrand: undefined;
	readonly workspaceRoot: URI | undefined;
	readonly primaryRoot: URI | undefined;

	reset(draft: ICodeScrimRecordingDraft, checkpoint: ICodeScrimRecordingCheckpoint): Promise<void>;
	applyWorkspaceChanges(deleted: readonly ICodeScrimWorkspaceResource[], created: readonly ICodeScrimWorkspaceEntryCheckpoint[]): Promise<void>;
	writeText(resource: ICodeScrimWorkspaceResource, text: string): Promise<void>;
	toLearnerUri(resource: ICodeScrimWorkspaceResource): URI | undefined;
	toWorkspaceResource(resource: URI): ICodeScrimWorkspaceResource | undefined;
	scanEntries(): Promise<readonly ICodeScrimWorkspaceEntryCheckpoint[]>;
	disposeWorkspace(): Promise<void>;
}

export function collectCodeScrimWorkspaceRoots(draft: ICodeScrimRecordingDraft): readonly number[] {
	const roots = new Set<number>();
	const add = (resource: ICodeScrimWorkspaceResource | undefined) => {
		if (resource) {
			roots.add(resource.root);
		}
	};

	for (const checkpoint of draft.checkpoints) {
		add(checkpoint.activeResource);
		checkpoint.documents.forEach(document => add(document.resource));
		checkpoint.entries.forEach(entry => add(entry.resource));
	}
	for (const event of draft.events) {
		switch (event.kind) {
			case 'workspace.entriesChanged':
				event.payload.deleted.forEach(add);
				event.payload.created.forEach(entry => add(entry.resource));
				break;
			case 'editor.activeResourceChanged':
				add(event.payload.resource);
				break;
			case 'editor.documentChanged':
			case 'editor.selectionChanged':
			case 'editor.documentSaved':
				add(event.payload.resource);
				break;
		}
	}

	return [...roots].sort((left, right) => left - right);
}
