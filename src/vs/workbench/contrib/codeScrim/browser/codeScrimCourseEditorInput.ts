/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export class CodeScrimCourseEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.codeScrimCourse';
	static readonly EDITOR_ID = 'workbench.editor.codeScrimCourse';
	static readonly RESOURCE = URI.from({ scheme: 'codescrim', authority: 'course-home' });

	override get typeId(): string {
		return CodeScrimCourseEditorInput.ID;
	}

	override get editorId(): string {
		return CodeScrimCourseEditorInput.EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override get resource(): URI {
		return CodeScrimCourseEditorInput.RESOURCE;
	}

	override getName(): string {
		return localize('codeScrim.courseHome', "CodeScrim");
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: CodeScrimCourseEditorInput.RESOURCE,
			options: {
				override: CodeScrimCourseEditorInput.EDITOR_ID,
				pinned: true,
			}
		};
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof CodeScrimCourseEditorInput;
	}
}
