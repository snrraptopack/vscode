/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const CODE_SCRIM_OPEN_AUTHOR_BROWSER_COMMAND_ID = 'codescrim.openAuthorBrowser';
export const CODE_SCRIM_OPEN_LEARNER_BROWSER_COMMAND_ID = 'codescrim.openLearnerBrowser';
export const CODE_SCRIM_TOGGLE_LESSON_BROWSER_COMMAND_ID = 'codescrim.toggleLessonBrowser';

/**
 * A serialized DOM state of the instructor browser page on the session clock.
 *
 * The snapshot is a passive document: scripts and event-handler attributes are
 * stripped before it leaves the page, so replay rebuilds the recorded page
 * offline without ever executing recorded content.
 */
export interface ICodeScrimBrowserSnapshot {
	readonly timestamp: number;
	readonly pageId: string;
	readonly url: string;
	readonly title: string;
	/** Vertical scroll offset in CSS pixels when the snapshot was taken. */
	readonly scrollTop: number;
	/** Serialized document, scripts removed. Rendered in a sandboxed iframe at replay. */
	readonly html: string;
}

/** Records whether an instructor browser page occupied the teaching surface. */
export interface ICodeScrimBrowserVisibility {
	readonly timestamp: number;
	readonly pageId: string;
	readonly visible: boolean;
}

/**
 * Passive browser recording. Snapshots reconstruct the recorded DOM in the
 * lesson surface; the learner interacts with the same surface, so instructor
 * playback and learner interaction are both DOM state on one element.
 */
export interface ICodeScrimBrowserTrack {
	readonly snapshots: readonly ICodeScrimBrowserSnapshot[];
	readonly visibility: readonly ICodeScrimBrowserVisibility[];
}

/** Resolves the instructor browser page visible at a timeline position. */
export function findCodeScrimVisiblePage(track: ICodeScrimBrowserTrack | undefined, position: number): string | undefined {
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
	return visiblePageId;
}

/**
 * Resolves the recorded DOM snapshot of the visible page at a position: the
 * latest snapshot at or before the position, preferring the visible page and
 * falling back to the most recent of any recorded page.
 */
export function findCodeScrimBrowserSnapshot(track: ICodeScrimBrowserTrack | undefined, position: number): ICodeScrimBrowserSnapshot | undefined {
	if (!track) {
		return undefined;
	}
	const pageId = findCodeScrimVisiblePage(track, position);
	const index = findLastTimestamp(track.snapshots, position);
	let fallback: ICodeScrimBrowserSnapshot | undefined;
	for (let candidate = index; candidate >= 0; candidate--) {
		const snapshot = track.snapshots[candidate];
		fallback ??= snapshot;
		if (!pageId || snapshot.pageId === pageId) {
			return snapshot;
		}
	}
	return fallback;
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
