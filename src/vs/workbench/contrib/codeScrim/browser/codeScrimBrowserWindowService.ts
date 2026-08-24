/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/codeScrimBrowserWindow.css';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
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
	) {
		super();
		const input = browserViewService.getOrCreateLazy('codescrim-author-browser', {
			url: 'about:blank',
			title: 'CodeScrim Browser',
		});
		this.authorWindow = this._register(new CodeScrimAuthorBrowserWindow(input, auxiliaryWindowService));
		this.onDidChangeAuthorPage = this.authorWindow.onDidChangePage;
		this.learnerWindow = this._register(new CodeScrimLearnerBrowserWindow(auxiliaryWindowService));
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

	registerLearnerNavigationHandler(handler: (query: string) => Promise<boolean>): IDisposable {
		this.learnerWindow.setNavigationHandler(handler);
		return toDisposable(() => this.learnerWindow.clearNavigationHandler(handler));
	}
}
