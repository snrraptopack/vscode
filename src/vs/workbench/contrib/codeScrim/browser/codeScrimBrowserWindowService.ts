/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/codeScrimBrowserWindow.css';
import { getWindow } from '../../../../base/browser/dom.js';
import { Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { ICodeScrimBrowserPageState, ICodeScrimBrowserSnapshot, ICodeScrimBrowserSurfaceEvent } from '../common/codeScrimBrowser.js';
import { CodeScrimAuthorBrowserWindow } from './codeScrimAuthorBrowserWindow.js';
import { CodeScrimLearnerBrowserWindow } from './codeScrimLearnerBrowserWindow.js';

export const ICodeScrimBrowserWindowService = createDecorator<ICodeScrimBrowserWindowService>('codeScrimBrowserWindowService');

export interface ICodeScrimBrowserWindowService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAuthorPage: Event<{ readonly kind: 'opened' | 'closed' | 'activated'; readonly pageId: string }>;
	readonly authorPageModels: readonly IBrowserViewModel[];
	readonly activeAuthorPageId: string | undefined;
	openAuthorWindow(): Promise<void>;
	showLearnerSnapshot(snapshot: ICodeScrimBrowserSnapshot | undefined, scrollTop?: number, pages?: readonly ICodeScrimBrowserPageState[], activeSurface?: ICodeScrimBrowserSurfaceEvent): void;
	toggleLearnerWindow(): Promise<void>;
	attachLearnerHost(host: HTMLElement): IDisposable;
	registerLearnerNavigationHandler(handler: (query: string) => Promise<boolean>): IDisposable;
}

export class CodeScrimBrowserWindowService extends Disposable implements ICodeScrimBrowserWindowService {
	declare readonly _serviceBrand: undefined;
	private readonly authorWindow: CodeScrimAuthorBrowserWindow;
	private readonly learnerWindow: CodeScrimLearnerBrowserWindow;
	readonly onDidChangeAuthorPage: Event<{ readonly kind: 'opened' | 'closed' | 'activated'; readonly pageId: string }>;

	get authorPageModels(): readonly IBrowserViewModel[] {
		return this.authorWindow.pageModels;
	}

	get activeAuthorPageId(): string | undefined {
		return this.authorWindow.activeModelId;
	}

	constructor(
		@IBrowserViewWorkbenchService browserViewService: IBrowserViewWorkbenchService,
		@IAuxiliaryWindowService auxiliaryWindowService: IAuxiliaryWindowService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();
		const input = browserViewService.getOrCreateLazy({
			id: 'codescrim-author-browser',
			url: 'about:blank',
			title: 'CodeScrim Browser',
		});
		this.authorWindow = this._register(new CodeScrimAuthorBrowserWindow(input, auxiliaryWindowService, configurationService,
			() => browserViewService.getOrCreateLazy({ id: generateUuid(), url: 'about:blank', title: 'CodeScrim Browser' })));
		this.onDidChangeAuthorPage = this.authorWindow.onDidChangePage;
		this.learnerWindow = this._register(new CodeScrimLearnerBrowserWindow(storageService));
		this._register(browserViewService.registerOpenHandler({
			shouldOpenEditor: (createdInput, _owner, openOptions) => !this.authorWindow.acceptCreatedPage(createdInput, openOptions),
		}));
	}

	openAuthorWindow(): Promise<void> {
		return this.authorWindow.open();
	}

	showLearnerSnapshot(snapshot: ICodeScrimBrowserSnapshot | undefined, scrollTop?: number, pages?: readonly ICodeScrimBrowserPageState[], activeSurface?: ICodeScrimBrowserSurfaceEvent): void {
		this.learnerWindow.show(snapshot, scrollTop, pages, activeSurface);
	}

	toggleLearnerWindow(): Promise<void> {
		return this.learnerWindow.toggle();
	}

	attachLearnerHost(host: HTMLElement): IDisposable {
		return this.learnerWindow.attach(this.layoutService.getContainer(getWindow(host)));
	}

	registerLearnerNavigationHandler(handler: (query: string) => Promise<boolean>): IDisposable {
		this.learnerWindow.setNavigationHandler(handler);
		return toDisposable(() => this.learnerWindow.clearNavigationHandler(handler));
	}
}
