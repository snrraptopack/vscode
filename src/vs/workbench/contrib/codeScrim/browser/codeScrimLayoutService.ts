/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ICodeScrimLayoutService } from '../common/codeScrimSession.js';

const LAYOUT_CONTROL_SETTING = 'workbench.layoutControl.enabled';
const LAYOUT_RECOVERY_STORAGE_KEY = 'codeScrim.layoutRecovery';
const LEGACY_LAYOUT_RECOVERY_STORAGE_KEY = 'codeScrim.legacyLayoutRecoveryComplete';
const LAYOUT_RECOVERY_VERSION = 1;

const managedParts = [
	Parts.ACTIVITYBAR_PART,
	Parts.SIDEBAR_PART,
	Parts.PANEL_PART,
	Parts.AUXILIARYBAR_PART,
	Parts.STATUSBAR_PART,
] as const;

interface ICodeScrimStoredLayoutRecovery {
	readonly version: typeof LAYOUT_RECOVERY_VERSION;
	readonly parts: readonly {
		readonly id: typeof managedParts[number];
		readonly visible: boolean;
	}[];
}

export class CodeScrimLayoutService extends Disposable implements ICodeScrimLayoutService {

	declare readonly _serviceBrand: undefined;

	private leaseCount = 0;
	private recoveryAttempted = false;
	private readonly activeLayout = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
	}

	restoreStaleCodeScrimLayout(): void {
		if (this.recoveryAttempted || this.leaseCount > 0) {
			return;
		}

		this.recoveryAttempted = true;
		const recovery = this.readStoredRecovery();
		if (recovery) {
			this.storageService.remove(LAYOUT_RECOVERY_STORAGE_KEY, StorageScope.WORKSPACE);
			for (const { id, visible } of recovery.parts) {
				this.layoutService.setPartHidden(!visible, id);
			}
			this.markLegacyRecoveryComplete();
			return;
		}

		this.restoreLegacyStrippedLayout();
	}

	enterCodeScrimMode(): IDisposable {
		this.restoreStaleCodeScrimLayout();
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

		// The panel starts hidden with the rest of the learner chrome, but unlike the other
		// workbench parts it may be revealed afterwards. CodeScrim terminal replay is hosted in
		// the real Terminal panel so its native sash, toolbar and toggle commands keep working.
		const enforcedHiddenParts = managedParts.filter(part => part !== Parts.PANEL_PART);
		const partVisibility = managedParts.map(part => ({
			part,
			visible: this.layoutService.isVisible(part, mainWindow),
		}));
		this.storageService.store(LAYOUT_RECOVERY_STORAGE_KEY, JSON.stringify({
			version: LAYOUT_RECOVERY_VERSION,
			parts: partVisibility.map(({ part, visible }) => ({ id: part, visible })),
		} satisfies ICodeScrimStoredLayoutRecovery), StorageScope.WORKSPACE, StorageTarget.MACHINE);

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
			this.storageService.remove(LAYOUT_RECOVERY_STORAGE_KEY, StorageScope.WORKSPACE);
		}));

		return disposables;
	}

	private readStoredRecovery(): ICodeScrimStoredLayoutRecovery | undefined {
		const raw = this.storageService.get(LAYOUT_RECOVERY_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return undefined;
		}

		try {
			const candidate = JSON.parse(raw) as Partial<ICodeScrimStoredLayoutRecovery>;
			if (candidate.version !== LAYOUT_RECOVERY_VERSION || !Array.isArray(candidate.parts)) {
				return undefined;
			}

			const validPartIds = new Set<string>(managedParts);
			const parts = candidate.parts.filter((part): part is ICodeScrimStoredLayoutRecovery['parts'][number] =>
				!!part && validPartIds.has(part.id) && typeof part.visible === 'boolean');
			return parts.length ? { version: LAYOUT_RECOVERY_VERSION, parts } : undefined;
		} catch {
			return undefined;
		}
	}

	private restoreLegacyStrippedLayout(): void {
		if (this.storageService.getBoolean(LEGACY_LAYOUT_RECOVERY_STORAGE_KEY, StorageScope.WORKSPACE, false)) {
			return;
		}

		this.markLegacyRecoveryComplete();
		const activityBarHidden = !this.layoutService.isVisible(Parts.ACTIVITYBAR_PART, mainWindow);
		const sideBarHidden = !this.layoutService.isVisible(Parts.SIDEBAR_PART, mainWindow);
		const auxiliaryBarHidden = !this.layoutService.isVisible(Parts.AUXILIARYBAR_PART, mainWindow);
		if (!activityBarHidden || !sideBarHidden || !auxiliaryBarHidden) {
			return;
		}

		// Builds before crash-safe leases could persist CodeScrim's stripped learner layout without
		// persisting its restoration snapshot. Repair that distinctive state once per workspace.
		this.layoutService.setPartHidden(false, Parts.ACTIVITYBAR_PART);
		this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		this.layoutService.setPartHidden(false, Parts.STATUSBAR_PART);
	}

	private markLegacyRecoveryComplete(): void {
		this.storageService.store(LEGACY_LAYOUT_RECOVERY_STORAGE_KEY, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
