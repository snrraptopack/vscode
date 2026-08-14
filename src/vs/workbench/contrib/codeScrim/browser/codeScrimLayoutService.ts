/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ICodeScrimLayoutService } from '../common/codeScrimSession.js';

const LAYOUT_CONTROL_SETTING = 'workbench.layoutControl.enabled';

export class CodeScrimLayoutService extends Disposable implements ICodeScrimLayoutService {

	declare readonly _serviceBrand: undefined;

	private leaseCount = 0;
	private readonly activeLayout = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();
	}

	enterCodeScrimMode(): IDisposable {
		this.leaseCount++;
		if (this.leaseCount === 1) {
			this.activeLayout.value = this.applyLayout();
		}

		let disposed = false;
		return toDisposable(() => {
			if (disposed) {
				return;
			}

			disposed = true;
			this.leaseCount = Math.max(0, this.leaseCount - 1);
			if (this.leaseCount === 0) {
				this.activeLayout.clear();
			}
		});
	}

	private applyLayout(): DisposableStore {
		const disposables = new DisposableStore();
		disposables.add(this.editorGroupsService.mainPart.enforcePartOptions({
			showTabs: 'none',
			editorActionsLocation: 'hidden',
		}));
		const previousLayoutControlValue = this.configurationService.inspect<boolean>(LAYOUT_CONTROL_SETTING)?.memoryValue;
		void this.configurationService.updateValue(LAYOUT_CONTROL_SETTING, false, ConfigurationTarget.MEMORY);

		const parts = [
			Parts.ACTIVITYBAR_PART,
			Parts.SIDEBAR_PART,
			Parts.PANEL_PART,
			Parts.AUXILIARYBAR_PART,
			Parts.STATUSBAR_PART,
		] as const;
		// The panel starts hidden with the rest of the learner chrome, but unlike the other
		// workbench parts it may be revealed afterwards. CodeScrim terminal replay is hosted in
		// the real Terminal panel so its native sash, toolbar and toggle commands keep working.
		const enforcedHiddenParts = parts.filter(part => part !== Parts.PANEL_PART);
		const partVisibility = parts.map(part => ({
			part,
			visible: this.layoutService.isVisible(part, mainWindow),
		}));

		for (const { part } of partVisibility) {
			this.layoutService.setPartHidden(true, part);
		}

		disposables.add(this.layoutService.onDidChangePartVisibility(({ partId, visible }) => {
			if (!visible) {
				return;
			}

			const part = enforcedHiddenParts.find(candidate => candidate === partId);
			if (part) {
				this.layoutService.setPartHidden(true, part);
			}
		}));
		disposables.add(toDisposable(() => {
			void this.configurationService.updateValue(LAYOUT_CONTROL_SETTING, previousLayoutControlValue, ConfigurationTarget.MEMORY);
			for (const { part, visible } of partVisibility) {
				this.layoutService.setPartHidden(!visible, part);
			}
		}));

		return disposables;
	}
}
