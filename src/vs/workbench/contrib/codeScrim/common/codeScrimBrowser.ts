/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const CODE_SCRIM_OPEN_AUTHOR_BROWSER_COMMAND_ID = 'codescrim.openAuthorBrowser';
export const CODE_SCRIM_OPEN_LEARNER_BROWSER_COMMAND_ID = 'codescrim.openLearnerBrowser';
export const CODE_SCRIM_OPEN_REPLAY_BROWSER_COMMAND_ID = 'codescrim.openReplayBrowser';
export const CODE_SCRIM_TOGGLE_LESSON_BROWSER_COMMAND_ID = 'codescrim.toggleLessonBrowser';

/**
 * A semantic instructor browser event on the CodeScrim session clock.
 *
 * Browser replay is state reconstruction, not video: recorded events re-drive a real,
 * read-only Integrated Browser at replay time. No event ever carries executable page
 * content, and decoding a track never loads a URL outside explicit replay navigation.
 */
export type CodeScrimBrowserEventData =
	| { readonly kind: 'browser.navigated'; readonly payload: { readonly pageId: string; readonly url: string } }
	| { readonly kind: 'browser.titleChanged'; readonly payload: { readonly pageId: string; readonly title: string } }
	| { readonly kind: 'browser.zoomChanged'; readonly payload: { readonly pageId: string; readonly zoomFactor: number } }
	| { readonly kind: 'browser.deviceChanged'; readonly payload: { readonly pageId: string; readonly width?: number; readonly height?: number } }
	| { readonly kind: 'browser.scrolled'; readonly payload: { readonly pageId: string; readonly scrollTop: number } }
	| { readonly kind: 'browser.pageClosed'; readonly payload: { readonly pageId: string } };

/** A sparse visual anchor used for timeline scrubber previews only. */
export interface ICodeScrimBrowserThumbnail {
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

/**
 * Passive browser recording. Events reconstruct state in a live replay browser;
 * thumbnails are presentation metadata for the timeline, never the lesson surface.
 */
export interface ICodeScrimBrowserTrack {
	readonly events: readonly (CodeScrimBrowserEventData & { readonly timestamp: number })[];
	readonly thumbnails: readonly ICodeScrimBrowserThumbnail[];
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
 * Reconstructs the recorded presentation state of the visible page at a position:
 * URL, title, zoom, device viewport, and last known scroll offset.
 */
export interface ICodeScrimBrowserPageState {
	readonly pageId: string;
	readonly url?: string;
	readonly title?: string;
	readonly zoomFactor?: number;
	readonly width?: number;
	readonly height?: number;
	readonly scrollTop?: number;
}

export function findCodeScrimBrowserState(track: ICodeScrimBrowserTrack | undefined, position: number): ICodeScrimBrowserPageState | undefined {
	const pageId = findCodeScrimVisiblePage(track, position);
	if (!pageId || !track) {
		return undefined;
	}
	let url: string | undefined;
	let title: string | undefined;
	let zoomFactor: number | undefined;
	let width: number | undefined;
	let height: number | undefined;
	let scrollTop: number | undefined;
	for (const event of track.events) {
		if (event.timestamp > position || event.payload.pageId !== pageId) {
			continue;
		}
		switch (event.kind) {
			case 'browser.navigated':
				url = event.payload.url;
				break;
			case 'browser.titleChanged':
				title = event.payload.title;
				break;
			case 'browser.zoomChanged':
				zoomFactor = event.payload.zoomFactor;
				break;
			case 'browser.deviceChanged':
				width = event.payload.width;
				height = event.payload.height;
				break;
			case 'browser.scrolled':
				scrollTop = event.payload.scrollTop;
				break;
		}
	}
	return { pageId, url, title, zoomFactor, width, height, scrollTop };
}

/** Resolves the scrubber thumbnail shown at a timeline position, if any. */
export function findCodeScrimBrowserThumbnail(track: ICodeScrimBrowserTrack | undefined, position: number): ICodeScrimBrowserThumbnail | undefined {
	if (!track) {
		return undefined;
	}
	const pageId = findCodeScrimVisiblePage(track, position);
	const index = findLastTimestamp(track.thumbnails, position);
	// Prefer the visible page's latest thumbnail; fall back to the most recent of any
	// recorded page so a just-became-visible page still shows the closest known state.
	let fallback: ICodeScrimBrowserThumbnail | undefined;
	for (let candidate = index; candidate >= 0; candidate--) {
		const thumbnail = track.thumbnails[candidate];
		fallback ??= thumbnail;
		if (!pageId || thumbnail.pageId === pageId) {
			return thumbnail;
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
