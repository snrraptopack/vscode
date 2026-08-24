/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/codeScrimBrowserWindow.css';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { ICodeScrimBrowserSnapshot } from '../common/codeScrimBrowser.js';
import { CodeScrimAuthorBrowserWindow } from './codeScrimAuthorBrowserWindow.js';
import { CodeScrimLearnerBrowserWindow } from './codeScrimLearnerBrowserWindow.js';

export const ICodeScrimBrowserWindowService = createDecorator<ICodeScrimBrowserWindowService>('codeScrimBrowserWindowService');

export interface ICodeScrimBrowserWindowService {
	readonly _serviceBrand: undefined;
	openAuthorWindow(): Promise<void>;
	showLearnerSnapshot(snapshot: ICodeScrimBrowserSnapshot | undefined, scrollTop?: number): void;
	toggleLearnerWindow(): Promise<void>;
	registerLearnerNavigationHandler(handler: (query: string) => Promise<boolean>): IDisposable;
}

export class CodeScrimBrowserWindowService extends Disposable implements ICodeScrimBrowserWindowService {
	declare readonly _serviceBrand: undefined;
	private readonly authorWindow: CodeScrimAuthorBrowserWindow;
	private readonly learnerWindow: CodeScrimLearnerBrowserWindow;

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
		this.learnerWindow = this._register(new CodeScrimLearnerBrowserWindow(auxiliaryWindowService));
		this._register(browserViewService.registerOpenHandler({
			shouldOpenEditor: (createdInput, _owner, openOptions) => !this.authorWindow.acceptCreatedPage(createdInput, openOptions),
		}));
	}

	openAuthorWindow(): Promise<void> {
		return this.authorWindow.open();
	}

	showLearnerSnapshot(snapshot: ICodeScrimBrowserSnapshot | undefined, scrollTop?: number): void {
		this.learnerWindow.show(snapshot, scrollTop);
	}

	toggleLearnerWindow(): Promise<void> {
		return this.learnerWindow.toggle();
	}

	registerLearnerNavigationHandler(handler: (query: string) => Promise<boolean>): IDisposable {
		this.learnerWindow.setNavigationHandler(handler);
		return toDisposable(() => this.learnerWindow.clearNavigationHandler(handler));
	}
}
