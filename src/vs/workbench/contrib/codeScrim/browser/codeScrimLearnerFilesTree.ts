/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { IIdentityProvider, IKeyboardNavigationLabelProvider, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { IAsyncDataSource, ITreeNode, ITreeRenderer, ITreeSorter } from '../../../../base/browser/ui/tree/tree.js';
import { IMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { IAction } from '../../../../base/common/actions.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { compareFileNames } from '../../../../base/common/comparers.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { FileKind, IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { DEFAULT_LABELS_CONTAINER, IResourceLabel, ResourceLabels } from '../../../browser/labels.js';
import { createFileIconThemableTreeContainerScope } from '../../files/browser/views/explorerView.js';
import { ICodeScrimLearnerWorkspaceService } from '../common/codeScrimLearnerWorkspace.js';
import { ICodeScrimWorkspaceResource } from '../common/codeScrimRecording.js';
import { ICodeScrimReplayService } from '../common/codeScrimReplay.js';
import { CodeScrimLearnerFilesDragAndDrop } from './codeScrimLearnerFilesDragAndDrop.js';

const FILE_TEMPLATE_ID = 'codescrim-learner-file';

class LearnerFileDelegate implements IListVirtualDelegate<IFileStat> {
	getHeight(): number { return 22; }
	getTemplateId(): string { return FILE_TEMPLATE_ID; }
}

class LearnerFileDataSource implements IAsyncDataSource<URI, IFileStat> {
	constructor(@IFileService private readonly fileService: IFileService) { }
	hasChildren(element: URI | IFileStat): boolean { return URI.isUri(element) || element.isDirectory; }
	async getChildren(element: URI | IFileStat): Promise<IFileStat[]> {
		return (await this.fileService.resolve(URI.isUri(element) ? element : element.resource)).children ?? [];
	}
}

class LearnerFileRenderer implements ITreeRenderer<IFileStat, void, IResourceLabel> {
	readonly templateId = FILE_TEMPLATE_ID;
	constructor(
		private readonly labels: ResourceLabels,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }
	renderTemplate(container: HTMLElement): IResourceLabel { return this.labels.create(container); }
	renderElement(node: ITreeNode<IFileStat, void>, _index: number, label: IResourceLabel): void {
		label.setFile(node.element.resource, {
			fileKind: node.element.isDirectory ? FileKind.FOLDER : FileKind.FILE,
			hidePath: true,
			fileDecorations: this.configurationService.getValue('explorer.decorations'),
		});
	}
	disposeTemplate(label: IResourceLabel): void { label.dispose(); }
}

class LearnerFileIdentityProvider implements IIdentityProvider<IFileStat> {
	getId(element: IFileStat): string { return element.resource.toString(); }
}

class LearnerFileSorter implements ITreeSorter<IFileStat> {
	compare(left: IFileStat, right: IFileStat): number {
		return left.isDirectory === right.isDirectory ? compareFileNames(left.name, right.name) : left.isDirectory ? -1 : 1;
	}
}

class LearnerFileNavigationLabelProvider implements IKeyboardNavigationLabelProvider<IFileStat> {
	getKeyboardNavigationLabel(element: IFileStat): string { return element.name; }
}

class LearnerFileAccessibilityProvider implements IListAccessibilityProvider<IFileStat> {
	getWidgetAriaLabel(): string { return localize('codeScrim.learnerFilesAriaLabel', "Learner Files"); }
	getAriaLabel(element: IFileStat): string { return element.name; }
}

/** A native workbench file tree whose input is the isolated learner projection. */
export class CodeScrimLearnerFilesTree extends Disposable {

	private readonly tree: WorkbenchAsyncDataTree<URI, IFileStat>;
	private input: URI | undefined;

	constructor(
		container: HTMLElement,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@INotificationService private readonly notificationService: INotificationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IThemeService themeService: IThemeService,
		@ICodeScrimLearnerWorkspaceService private readonly learnerWorkspaceService: ICodeScrimLearnerWorkspaceService,
		@ICodeScrimReplayService private readonly replayService: ICodeScrimReplayService,
	) {
		super();
		const labels = this._register(this.instantiationService.createInstance(ResourceLabels, DEFAULT_LABELS_CONTAINER));
		this._register(createFileIconThemableTreeContainerScope(container, themeService));
		const dragAndDrop = this._register(this.instantiationService.createInstance(
			CodeScrimLearnerFilesDragAndDrop,
			() => this.learnerWorkspaceService.workspaceRoot,
			() => this.refresh(),
		));
		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<URI, IFileStat>,
			'CodeScrimLearnerFiles',
			container,
			new LearnerFileDelegate(),
			[this.instantiationService.createInstance(LearnerFileRenderer, labels)],
			this.instantiationService.createInstance(LearnerFileDataSource),
			{
				accessibilityProvider: new LearnerFileAccessibilityProvider(),
				identityProvider: new LearnerFileIdentityProvider(),
				keyboardNavigationLabelProvider: new LearnerFileNavigationLabelProvider(),
				sorter: new LearnerFileSorter(),
				dnd: dragAndDrop,
				multipleSelectionSupport: true,
			},
		));
		this._register(this.tree.onDidOpen(event => {
			if (event.element?.isFile) {
				const resource = this.learnerWorkspaceService.toWorkspaceResource(event.element.resource);
				if (resource) {
					void this.replayService.openResource(resource);
				}
			}
		}));
		this._register(this.tree.onContextMenu(event => this.showContextMenu(event.element, event.anchor)));
		this._register(this.tree.onKeyDown(event => {
			if (event.code === 'Delete' || (isMacintosh && event.code === 'Backspace' && event.metaKey)) {
				const focus = this.tree.getFocus()[0];
				if (focus) {
					void this.delete(focus);
				}
			}
		}));
		this._register(DOM.addDisposableListener(container, DOM.EventType.DRAG_OVER, event => {
			event.stopPropagation();
		}));
	}

	async refresh(): Promise<void> {
		const root = this.learnerWorkspaceService.workspaceRoot;
		if (!root) {
			return;
		}
		try {
			if (!this.input || this.input.toString() !== root.toString()) {
				this.input = root;
				await this.tree.setInput(root);
			} else {
				await this.tree.updateChildren();
			}
		} catch (error) {
			this.notificationService.error(localize('codeScrim.refreshLearnerFilesFailed', "Unable to refresh learner files: {0}", getErrorMessage(error)));
		}
	}

	async create(type: 'file' | 'directory', parent?: IFileStat): Promise<void> {
		const name = await this.quickInputService.input({
			prompt: type === 'file' ? localize('codeScrim.newLearnerFilePrompt', "Enter a file name or relative path") : localize('codeScrim.newLearnerFolderPrompt', "Enter a folder name or relative path"),
			placeHolder: type === 'file' ? localize('codeScrim.newLearnerFilePlaceholder', "file name or path") : localize('codeScrim.newLearnerFolderPlaceholder', "folder name or path"),
		});
		if (!name?.trim()) {
			return;
		}
		const parentResource = this.toParentResource(parent);
		const path = parentResource?.path ? `${parentResource.path}/${name.trim()}` : name.trim();
		try {
			if (type === 'file') {
				await this.replayService.createLearnerFile(path, parentResource?.root);
			} else {
				await this.replayService.createLearnerFolder(path, parentResource?.root);
			}
			await this.refresh();
		} catch (error) {
			this.notificationService.error(localize('codeScrim.createLearnerEntryFailed', "Unable to create the learner file or folder: {0}", getErrorMessage(error)));
		}
	}

	async delete(element: IFileStat): Promise<void> {
		const resource = this.learnerWorkspaceService.toWorkspaceResource(element.resource);
		if (!resource) {
			return;
		}
		if (!this.replayService.isLearnerCreated(resource)) {
			this.notificationService.warn(localize('codeScrim.instructorFileDeleteBlocked', "Instructor files cannot be deleted."));
			return;
		}
		try {
			await this.replayService.deleteLearnerResource(resource);
			await this.refresh();
		} catch (error) {
			this.notificationService.error(localize('codeScrim.deleteLearnerEntryFailed', "Unable to delete the learner file or folder: {0}", getErrorMessage(error)));
		}
	}

	layout(height: number, width: number): void {
		this.tree.layout(height, width);
	}

	private showContextMenu(element: IFileStat | null, anchor: HTMLElement | IMouseEvent): void {
		const resource = element ? this.learnerWorkspaceService.toWorkspaceResource(element.resource) : undefined;
		const isLearnerCreated = resource && this.replayService.isLearnerCreated(resource);
		const actions: IAction[] = [{
			id: 'codescrim.newLearnerFile',
			label: localize('codeScrim.newLearnerFile', "New File"),
			tooltip: '',
			class: undefined,
			enabled: true,
			run: () => this.create('file', element ?? undefined),
		}, {
			id: 'codescrim.newLearnerFolder',
			label: localize('codeScrim.newLearnerFolder', "New Folder"),
			tooltip: '',
			class: undefined,
			enabled: true,
			run: () => this.create('directory', element ?? undefined),
		}];

		if (element) {
			actions.push({
				id: 'codescrim.deleteLearnerEntry',
				label: localize('codeScrim.deleteLearnerEntry', "Delete"),
				tooltip: '',
				class: undefined,
				enabled: isLearnerCreated ?? false,
				run: () => this.delete(element),
			});
		}

		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}

	private toParentResource(parent: IFileStat | undefined): ICodeScrimWorkspaceResource | undefined {
		const resource = parent ? (parent.isDirectory ? parent.resource : dirname(parent.resource)) : this.learnerWorkspaceService.workspaceRoot;
		return resource ? this.learnerWorkspaceService.toWorkspaceResource(resource) : undefined;
	}
}
