/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ICodeScrimLessonDescriptor } from '../common/codeScrimSession.js';

export class CodeScrimLessonEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.codeScrimLesson';
	static readonly EDITOR_ID = 'workbench.editor.codeScrimLesson';

	readonly resource: URI;

	constructor(readonly lesson: ICodeScrimLessonDescriptor) {
		super();
		this.resource = URI.from({ scheme: 'codescrim', authority: 'lesson', path: `/${encodeURIComponent(lesson.id)}` });
	}

	override get typeId(): string {
		return CodeScrimLessonEditorInput.ID;
	}

	override get editorId(): string {
		return CodeScrimLessonEditorInput.EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		return this.lesson.title;
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this.resource,
			options: {
				override: CodeScrimLessonEditorInput.EDITOR_ID,
				pinned: true,
			}
		};
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof CodeScrimLessonEditorInput && otherInput.lesson.id === this.lesson.id;
	}
}
