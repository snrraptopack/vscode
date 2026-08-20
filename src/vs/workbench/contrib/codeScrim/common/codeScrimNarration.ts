/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A self-contained piece of instructor narration aligned to the CodeScrim microsecond clock. */
export interface ICodeScrimNarrationSegment {
	readonly start: number;
	readonly duration: number;
	readonly mimeType: string;
	readonly data: string;
}

export interface ICodeScrimNarrationTrack {
	readonly segments: readonly ICodeScrimNarrationSegment[];
}
