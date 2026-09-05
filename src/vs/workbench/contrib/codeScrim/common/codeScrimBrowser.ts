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

/** A lightweight root viewport update, independent of serialized DOM state. */
export interface ICodeScrimBrowserScroll {
	readonly timestamp: number;
	readonly pageId: string;
	readonly scrollLeft: number;
	readonly scrollTop: number;
}

/** A structural change to the instructor's browser tab set. */
export interface ICodeScrimBrowserPageEvent {
	readonly timestamp: number;
	readonly pageId: string;
	readonly kind: 'opened' | 'closed' | 'activated' | 'updated';
	readonly url?: string;
	readonly title?: string;
}

/** Which top-level teaching surface held the instructor's attention. */
export interface ICodeScrimBrowserSurfaceEvent {
	readonly timestamp: number;
	readonly surface: 'workbench' | 'browser';
	readonly pageId?: string;
}

export interface ICodeScrimBrowserPageState {
	readonly pageId: string;
	readonly url: string;
	readonly title: string;
	readonly active: boolean;
	/** Latest captured state for this tab at the current lesson position. */
	readonly snapshot?: ICodeScrimBrowserSnapshot;
	readonly scrollTop?: number;
}

/**
 * Passive browser recording. Snapshots reconstruct the recorded DOM in the
 * lesson surface; the learner interacts with the same surface, so instructor
 * playback and learner interaction are both DOM state on one element.
 */
export interface ICodeScrimBrowserTrack {
	readonly snapshots: readonly ICodeScrimBrowserSnapshot[];
	readonly visibility: readonly ICodeScrimBrowserVisibility[];
	readonly scrolls: readonly ICodeScrimBrowserScroll[];
	readonly pages: readonly ICodeScrimBrowserPageEvent[];
	readonly surfaces: readonly ICodeScrimBrowserSurfaceEvent[];
}

/** Resolves the browser tabs that existed at a timeline position. */
export function findCodeScrimBrowserPages(track: ICodeScrimBrowserTrack | undefined, position: number): readonly ICodeScrimBrowserPageState[] {
	if (!track) {
		return [];
	}
	const open = new Map<string, { url: string; title: string; timestamp: number }>();
	let activePageId: string | undefined;
	for (const event of track.pages) {
		if (event.timestamp > position) {
			break;
		}
		switch (event.kind) {
			case 'opened':
				open.set(event.pageId, { url: event.url ?? 'about:blank', title: event.title ?? '', timestamp: event.timestamp });
				break;
			case 'closed':
				open.delete(event.pageId);
				if (activePageId === event.pageId) {
					activePageId = undefined;
				}
				break;
			case 'activated':
				if (open.has(event.pageId)) {
					activePageId = event.pageId;
				}
				break;
			case 'updated': {
				const page = open.get(event.pageId);
				if (page) {
					open.set(event.pageId, { url: event.url ?? page.url, title: event.title ?? page.title, timestamp: event.timestamp });
				}
				break;
			}
		}
	}
	return [...open.entries()].map(([pageId, page]) => {
		const snapshot = findLatestPageSnapshot(track.snapshots, position, pageId);
		const snapshotIsNewer = snapshot && snapshot.timestamp >= page.timestamp;
		return {
			pageId,
			url: snapshotIsNewer ? snapshot.url : page.url || snapshot?.url || 'about:blank',
			title: snapshotIsNewer ? snapshot.title : page.title || snapshot?.title || '',
			active: pageId === activePageId,
			...(snapshot ? {
				snapshot,
				scrollTop: findCodeScrimBrowserScroll(track, position, pageId)?.scrollTop ?? snapshot.scrollTop,
			} : {}),
		};
	});
}

/** Resolves whether playback should foreground the editor or browser window. */
export function findCodeScrimActiveSurface(track: ICodeScrimBrowserTrack | undefined, position: number): ICodeScrimBrowserSurfaceEvent | undefined {
	if (!track) {
		return undefined;
	}
	const index = findLastTimestamp(track.surfaces, position);
	return index < 0 ? undefined : track.surfaces[index];
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

/** Resolves the latest viewport position of the page visible at a timeline position. */
export function findCodeScrimBrowserScroll(track: ICodeScrimBrowserTrack | undefined, position: number, pageId?: string): ICodeScrimBrowserScroll | undefined {
	if (!track) {
		return undefined;
	}
	pageId ??= findCodeScrimVisiblePage(track, position);
	for (let index = findLastTimestamp(track.scrolls, position); index >= 0; index--) {
		const scroll = track.scrolls[index];
		if (!pageId || scroll.pageId === pageId) {
			return scroll;
		}
	}
	return undefined;
}

/**
 * Resolves a useful timeline position for a recorded tab, URL, or title. The
 * first snapshot of a newly opened browser tab is commonly `about:blank`, so
 * navigation deliberately prefers its latest non-blank state at or before the
 * current lesson position.
 */
export function findCodeScrimBrowserPagePosition(track: ICodeScrimBrowserTrack | undefined, query: string, position: number): number | undefined {
	const needle = query.trim().toLocaleLowerCase();
	if (!track || !needle) {
		return undefined;
	}
	const exact = track.snapshots.filter(snapshot => snapshot.pageId.toLocaleLowerCase() === needle || snapshot.url.toLocaleLowerCase() === needle || snapshot.title.toLocaleLowerCase() === needle);
	const candidates = exact.length ? exact : track.snapshots.filter(snapshot => snapshot.url.toLocaleLowerCase().includes(needle) || snapshot.title.toLocaleLowerCase().includes(needle));
	if (!candidates.length) {
		return undefined;
	}

	const before = candidates.filter(snapshot => snapshot.timestamp <= position);
	const usefulBefore = before.filter(snapshot => snapshot.url !== 'about:blank');
	const useful = candidates.filter(snapshot => snapshot.url !== 'about:blank');
	return usefulBefore.at(-1)?.timestamp ?? useful.at(0)?.timestamp ?? before.at(-1)?.timestamp ?? candidates.at(0)?.timestamp;
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

function findLatestPageSnapshot(snapshots: readonly ICodeScrimBrowserSnapshot[], position: number, pageId: string): ICodeScrimBrowserSnapshot | undefined {
	for (let index = findLastTimestamp(snapshots, position); index >= 0; index--) {
		if (snapshots[index].pageId === pageId) {
			return snapshots[index];
		}
	}
	return undefined;
}
