/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const CODE_SCRIM_OPEN_AUTHOR_BROWSER_COMMAND_ID = 'codescrim.openAuthorBrowser';
export const CODE_SCRIM_OPEN_LEARNER_BROWSER_COMMAND_ID = 'codescrim.openLearnerBrowser';
export const CODE_SCRIM_TOGGLE_LESSON_BROWSER_COMMAND_ID = 'codescrim.toggleLessonBrowser';

/** A visual browser frame captured on the CodeScrim session clock. */
export interface ICodeScrimBrowserFrame {
	readonly timestamp: number;
	readonly pageId: string;
	readonly url: string;
	readonly title: string;
	readonly mimeType: 'image/jpeg';
	readonly data: string;
}

/** Records whether an instructor browser page occupied the teaching surface. */
export interface ICodeScrimBrowserVisibility {
	readonly timestamp: number;
	readonly pageId: string;
	readonly visible: boolean;
}

/** Passive visual browser recording. It never contains executable page content. */
export interface ICodeScrimBrowserTrack {
	readonly frames: readonly ICodeScrimBrowserFrame[];
	readonly visibility: readonly ICodeScrimBrowserVisibility[];
}

/** Resolves the instructor browser frame visible at a timeline position. */
export function findCodeScrimBrowserFrame(track: ICodeScrimBrowserTrack | undefined, position: number): ICodeScrimBrowserFrame | undefined {
	if (!track) {
		return undefined;
	}

	let visiblePageId: string | undefined;
	const hiddenPages = new Set<string>();
	for (let index = findLastTimestamp(track.visibility, position); index >= 0; index--) {
		const state = track.visibility[index];
		if (hiddenPages.has(state.pageId)) {
			continue;
		}
		if (!state.visible) {
			hiddenPages.add(state.pageId);
		} else {
			visiblePageId = state.pageId;
			break;
		}
	}
	if (!visiblePageId) {
		return undefined;
	}

	for (let index = findLastTimestamp(track.frames, position); index >= 0; index--) {
		const frame = track.frames[index];
		if (frame.pageId === visiblePageId) {
			return frame;
		}
	}
	return undefined;
}

function findLastTimestamp(entries: readonly { readonly timestamp: number }[], position: number): number {
	let low = 0;
	let high = entries.length - 1;
	let result = -1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (entries[middle].timestamp <= position) {
			result = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return result;
}
