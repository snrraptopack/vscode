/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const CODE_SCRIM_WORKSPACE_ROOT_ENV = 'VSCODE_CODESCRIM_WORKSPACE_ROOT';
export const CODE_SCRIM_WORKSPACE_LABEL_ENV = 'VSCODE_CODESCRIM_WORKSPACE_LABEL';

/** Return a portable, prompt-safe label for the learner's logical workspace. */
export function getCodeScrimWorkspaceLabel(lessonTitle: string | undefined, fallback: string): string {
	return lessonTitle?.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || fallback;
}

export function getCodeScrimDisplayRoot(workspaceLabel: string): string {
	return `CodeScrim:\\${workspaceLabel}`;
}

/** Hide an instructor machine path in passive terminal presentation without changing recorded data. */
export function projectCodeScrimTerminalOutput(output: string, recordedRoot: string | undefined, displayRoot: string): string {
	if (!recordedRoot) {
		return output;
	}

	const variants = new Set([
		recordedRoot,
		recordedRoot.replaceAll('\\', '/'),
		recordedRoot.replaceAll('/', '\\'),
	]);
	let projected = output;
	for (const variant of [...variants].sort((left, right) => right.length - left.length)) {
		if (variant) {
			projected = projected.replaceAll(variant, displayRoot);
		}
	}
	return projected;
}
