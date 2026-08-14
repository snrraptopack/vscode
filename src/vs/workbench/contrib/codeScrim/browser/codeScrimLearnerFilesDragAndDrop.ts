/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDragAndDropData } from '../../../../base/browser/dnd.js';
import { IListDragOverEffect, ListDragOverEffectPosition, ListDragOverEffectType } from '../../../../base/browser/ui/list/list.js';
import { ElementsDragAndDropData, ListViewTargetSector, NativeDragAndDropData } from '../../../../base/browser/ui/list/listView.js';
import { ITreeDragAndDrop, ITreeDragOverReaction, TreeDragOverBubble } from '../../../../base/browser/ui/tree/tree.js';
import { coalesce } from '../../../../base/common/arrays.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, extUri, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { extractEditorsAndFilesDropData } from '../../../../platform/dnd/browser/dnd.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICodeScrimLearnerWorkspaceService } from '../common/codeScrimLearnerWorkspace.js';
import { ICodeScrimReplayService } from '../common/codeScrimReplay.js';

/** Native resource drag/drop constrained to CodeScrim's disposable learner projection. */
export class CodeScrimLearnerFilesDragAndDrop extends Disposable implements ITreeDragAndDrop<IFileStat> {

	constructor(
		private readonly getRoot: () => URI | undefined,
		private readonly onDidDropResources: () => Promise<void>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICodeScrimLearnerWorkspaceService private readonly learnerWorkspaceService: ICodeScrimLearnerWorkspaceService,
		@ICodeScrimReplayService private readonly replayService: ICodeScrimReplayService,
	) {
		super();
	}

	getDragURI(element: IFileStat): string {
		return element.resource.toString();
	}

	getDragLabel(elements: IFileStat[], _originalEvent: DragEvent): string | undefined {
		return elements.length === 1 ? elements[0].name : String(elements.length);
	}

	onDragStart(data: IDragAndDropData, originalEvent: DragEvent): void {
		const elements = (data as ElementsDragAndDropData<IFileStat>).elements;
		if (elements.length && originalEvent.dataTransfer) {
			const uris = elements.map(element => element.resource.toString()).join('\r\n');
			originalEvent.dataTransfer.setData('text/plain', uris);
			originalEvent.dataTransfer.setData('text/uri-list', uris);
			originalEvent.dataTransfer.effectAllowed = 'copyMove';
		}
	}

	onDragOver(data: IDragAndDropData, targetElement: IFileStat | undefined, _targetIndex: number | undefined, _targetSector: ListViewTargetSector | undefined, originalEvent: DragEvent): boolean | ITreeDragOverReaction {
		const root = this.getRoot();
		if (!root) {
			return false;
		}

		const isCopy = originalEvent.ctrlKey || originalEvent.altKey;
		const effect: IListDragOverEffect = {
			type: isCopy ? ListDragOverEffectType.Copy : ListDragOverEffectType.Move,
			position: ListDragOverEffectPosition.Over,
		};

		if (!targetElement) {
			return { accept: true, bubble: TreeDragOverBubble.Down, effect };
		}

		if (targetElement.isDirectory) {
			if (data instanceof ElementsDragAndDropData) {
				const elements = data.elements as IFileStat[];
				if (elements.some(element => extUri.isEqual(element.resource, targetElement.resource) || extUri.isEqualOrParent(targetElement.resource, element.resource))) {
					return false;
				}
			}
			return { accept: true, bubble: TreeDragOverBubble.Down, effect, autoExpand: true };
		}

		return { accept: true, bubble: TreeDragOverBubble.Up, effect };
	}

	async drop(data: IDragAndDropData, targetElement: IFileStat | undefined, _targetIndex: number | undefined, _targetSector: ListViewTargetSector | undefined, originalEvent: DragEvent): Promise<void> {
		originalEvent.preventDefault();
		originalEvent.stopPropagation();
		const root = this.getRoot();
		if (!root) {
			return;
		}
		const target = targetElement ? (targetElement.isDirectory ? targetElement.resource : dirname(targetElement.resource)) : root;
		try {
			if (data instanceof NativeDragAndDropData) {
				const resources = coalesce((await this.instantiationService.invokeFunction(accessor => extractEditorsAndFilesDropData(accessor, originalEvent))).map(editor => editor.resource));
				for (const resource of resources) {
					await this.copy(resource, target);
				}
			} else if (data instanceof ElementsDragAndDropData) {
				const copy = originalEvent.ctrlKey || originalEvent.altKey;
				for (const source of data.elements as IFileStat[]) {
					const portable = this.learnerWorkspaceService.toWorkspaceResource(source.resource);
					if (!copy && portable && !this.replayService.isLearnerCreated(portable)) {
						this.notificationService.warn(localize('codeScrim.instructorFileMoveBlocked', "Instructor files cannot be moved. Hold Ctrl while dragging to create a learner copy."));
						return;
					}
					await this.transfer(source.resource, target, copy);
				}
			}
			await this.replayService.synchronizeLearnerWorkspace();
			await this.onDidDropResources();
		} catch (error) {
			this.notificationService.error(localize('codeScrim.learnerDropFailed', "Unable to add the dropped resource: {0}", getErrorMessage(error)));
		}
	}

	private async copy(source: URI, targetFolder: URI): Promise<void> {
		await this.fileService.copy(source, joinPath(targetFolder, basename(source)), false);
	}

	private async transfer(source: URI, targetFolder: URI, copy: boolean): Promise<void> {
		const target = joinPath(targetFolder, basename(source));
		if (extUri.isEqual(source, target)) {
			return;
		}
		if (extUri.isEqualOrParent(target, source)) {
			throw new Error(localize('codeScrim.invalidLearnerDropTarget', "A folder cannot be moved or copied inside itself."));
		}
		if (copy) {
			await this.fileService.copy(source, target, false);
		} else {
			await this.fileService.move(source, target, false);
		}
	}
}
