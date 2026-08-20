/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDragAndDropData } from '../../../../base/browser/dnd.js';
import { ElementsDragAndDropData, ListViewTargetSector, NativeDragAndDropData } from '../../../../base/browser/ui/list/listView.js';
import { ITreeDragAndDrop } from '../../../../base/browser/ui/tree/tree.js';
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
import { ResourceListDnDHandler } from '../../../browser/dnd.js';
import { ICodeScrimLearnerWorkspaceService } from '../common/codeScrimLearnerWorkspace.js';
import { ICodeScrimReplayService } from '../common/codeScrimReplay.js';

/** Native resource drag/drop constrained to CodeScrim's disposable learner projection. */
export class CodeScrimLearnerFilesDragAndDrop extends Disposable implements ITreeDragAndDrop<IFileStat> {

	private readonly resourceDragAndDrop: ResourceListDnDHandler<IFileStat>;

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
		this.resourceDragAndDrop = this._register(this.instantiationService.createInstance(ResourceListDnDHandler<IFileStat>, item => item.resource));
	}

	getDragURI(element: IFileStat): string {
		return this.resourceDragAndDrop.getDragURI(element)!;
	}

	getDragLabel(elements: IFileStat[], originalEvent: DragEvent): string | undefined {
		return this.resourceDragAndDrop.getDragLabel(elements);
	}

	onDragStart(data: IDragAndDropData, originalEvent: DragEvent): void {
		this.resourceDragAndDrop.onDragStart(data, originalEvent);
	}

	onDragOver(_data: IDragAndDropData, _targetElement: IFileStat | undefined, _targetIndex: number | undefined, _targetSector: ListViewTargetSector | undefined, _originalEvent: DragEvent): boolean {
		return !!this.getRoot();
	}

	async drop(data: IDragAndDropData, targetElement: IFileStat | undefined, _targetIndex: number | undefined, _targetSector: ListViewTargetSector | undefined, originalEvent: DragEvent): Promise<void> {
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
