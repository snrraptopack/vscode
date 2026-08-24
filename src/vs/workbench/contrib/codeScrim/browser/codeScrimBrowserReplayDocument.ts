/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createTrustedTypesPolicy } from '../../../../base/browser/trustedTypes.js';

const browserReplayPolicy = createTrustedTypesPolicy('codescrimBrowserReplay', {
	// Snapshots pass through the passive-browser sanitizer in the isolated BrowserView
	// preload. This policy only gives that already-sanitized document the TrustedHTML
	// type required by the workbench CSP; it is not a general-purpose HTML escape hatch.
	createHTML: value => value,
});

/** Converts captured passive browser HTML for use with a TrustedHTML DOM sink. */
export function toCodeScrimBrowserReplayDocument(html: string): string {
	return (browserReplayPolicy?.createHTML(html) ?? html) as string;
}
