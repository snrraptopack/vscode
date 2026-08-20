/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { hasKey } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandDetectionCapability, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { IShellLaunchConfig, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICreateTerminalOptions, ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { ICodeScrimLearnerWorkspaceService } from '../common/codeScrimLearnerWorkspace.js';
import { ICodeScrimReplayService } from '../common/codeScrimReplay.js';
import { ICodeScrimSessionService } from '../common/codeScrimSession.js';
import { CODE_SCRIM_WORKSPACE_LABEL_ENV, CODE_SCRIM_WORKSPACE_ROOT_ENV, getCodeScrimWorkspaceLabel } from './codeScrimTerminalPresentation.js';

interface ICodeScrimLiveLearnerTerminal {
	readonly workspaceRoot: string;
	readonly instance: ITerminalInstance;
	readonly listeners: DisposableStore;
}

/** Owns explicit learner shells without mixing them into recorded terminal replay. */
export class CodeScrimLearnerTerminal extends Disposable {
	private readonly observedCapabilities = new Set<ICommandDetectionCapability>();
	private readonly terminals = new Map<number, ICodeScrimLiveLearnerTerminal>();
	private readonly suspendedHostTerminals: ITerminalInstance[] = [];
	private readonly synchronizeScheduler = this._register(new RunOnceScheduler(() => {
		// A long-running learner process may continue emitting output after replay resumes.
		// Background output must not repeatedly pause the instructor clock.
		if (this.replayService.state.status !== 'playing') {
			void this.replayService.synchronizeLearnerWorkspace().catch(onUnexpectedError);
		}
	}, 500));
	private pendingCreation: Promise<void> | undefined;

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICodeScrimLearnerWorkspaceService private readonly learnerWorkspaceService: ICodeScrimLearnerWorkspaceService,
		@ICodeScrimReplayService private readonly replayService: ICodeScrimReplayService,
		@ICodeScrimSessionService private readonly sessionService: ICodeScrimSessionService,
	) {
		super();
		this._register(this.terminalService.registerShellLaunchConfigResolver((config, options) => this.resolveShellLaunchConfig(config, options)));
		this._register(this.terminalService.onDidCreateInstance(instance => this.handleCreatedInstance(instance)));
		for (const instance of [...this.terminalService.foregroundInstances]) {
			this.handleCreatedInstance(instance);
		}
	}

	/** Reveal a real shell rooted in the disposable learner projection. */
	async show(): Promise<void> {
		const workspaceRoot = this.learnerWorkspaceService.primaryRoot;
		if (!workspaceRoot) {
			this.notificationService.warn(localize('codeScrim.learnerTerminalUnavailable', "The learner workspace is not ready yet."));
			return;
		}

		this.replayService.beginLearnerEdit();
		this.reconcileWorkspaceRoot();
		if (!this.terminals.size && !this.pendingCreation) {
			this.pendingCreation = this.create(workspaceRoot).finally(() => this.pendingCreation = undefined);
		}
		await this.pendingCreation;

		const active = this.terminalService.activeInstance;
		const terminal = active ? this.terminals.get(active.instanceId) ?? [...this.terminals.values()].at(-1) : [...this.terminals.values()].at(-1);
		if (terminal) {
			this.terminalService.setActiveInstance(terminal.instance);
			await this.terminalService.revealActiveTerminal(false);
		}
	}

	/** Close shells whose projected working directory was replaced by replay restart or package load. */
	reconcileWorkspaceRoot(): void {
		const workspaceRoot = this.learnerWorkspaceService.primaryRoot?.toString();
		for (const terminal of [...this.terminals.values()]) {
			if (terminal.workspaceRoot !== workspaceRoot) {
				this.disposeTerminal(terminal.instance.instanceId);
			}
		}
	}

	private async create(workspaceRoot: URI): Promise<void> {
		const instance = await this.terminalService.createTerminal({
			config: { ...this.createLearnerShellConfiguration(workspaceRoot), waitOnExit: false },
			location: TerminalLocation.Panel,
		});
		if (workspaceRoot.toString() !== this.learnerWorkspaceService.primaryRoot?.toString()) {
			instance.dispose();
			return;
		}
		this.track(instance);
	}

	private resolveShellLaunchConfig(config: IShellLaunchConfig, options: ICreateTerminalOptions | undefined): IShellLaunchConfig {
		const workspaceRoot = this.learnerWorkspaceService.primaryRoot;
		const contributedProfile = options?.config && hasKey(options.config, { extensionIdentifier: true });
		if (!workspaceRoot || contributedProfile || config.customPtyImplementation || config.attachPersistentProcess || config.isFeatureTerminal ||
			config.isExtensionOwnedTerminal || config.extHostTerminalId || config.type || config.env?.[CODE_SCRIM_WORKSPACE_ROOT_ENV]) {
			return config;
		}

		const learnerConfig = this.createLearnerShellConfiguration(workspaceRoot);
		return { ...config, ...learnerConfig, env: { ...config.env, ...learnerConfig.env } };
	}

	private createLearnerShellConfiguration(workspaceRoot: URI): IShellLaunchConfig {
		const workspaceLabel = getCodeScrimWorkspaceLabel(this.sessionService.state?.lesson.title, localize('codeScrim.learnerWorkspaceLabel', "Workspace"));
		return {
			name: localize('codeScrim.liveLearnerTerminalName', "CodeScrim Learner"),
			icon: Codicon.terminal,
			cwd: workspaceRoot,
			env: {
				[CODE_SCRIM_WORKSPACE_ROOT_ENV]: workspaceRoot.fsPath,
				[CODE_SCRIM_WORKSPACE_LABEL_ENV]: workspaceLabel,
			},
			ignoreConfigurationCwd: true,
			isTransient: true,
			forceShellIntegration: true,
		};
	}

	private handleCreatedInstance(instance: ITerminalInstance): void {
		if (typeof instance.shellLaunchConfig.env?.[CODE_SCRIM_WORKSPACE_ROOT_ENV] === 'string') {
			this.track(instance);
			return;
		}

		// Recorded terminals are CodeScrim-owned custom PTYs. Ordinary foreground shells
		// belong to the author workbench and stay alive, but must not leak into the lesson.
		if (instance.shellLaunchConfig.customPtyImplementation || instance.isDisposed || this.suspendedHostTerminals.includes(instance)) {
			return;
		}
		this.suspendedHostTerminals.push(instance);
		this.terminalService.moveToBackground(instance);
	}

	private track(instance: ITerminalInstance): void {
		const workspaceRoot = instance.shellLaunchConfig.env?.[CODE_SCRIM_WORKSPACE_ROOT_ENV];
		if (typeof workspaceRoot !== 'string' || this.terminals.has(instance.instanceId)) {
			return;
		}

		const listeners = new DisposableStore();
		const terminal = { workspaceRoot: URI.file(workspaceRoot).toString(), instance, listeners };
		this.terminals.set(instance.instanceId, terminal);
		listeners.add(instance.onDisposed(() => {
			listeners.dispose();
			this.terminals.delete(instance.instanceId);
		}));
		listeners.add(instance.onDidInputData(() => {
			this.replayService.beginLearnerEdit();
			this.synchronizeScheduler.schedule();
		}));
		listeners.add(instance.onData(() => this.synchronizeScheduler.schedule()));
		this.observeCommandDetection(instance, listeners);
	}

	private observeCommandDetection(instance: ITerminalInstance, listeners: DisposableStore): void {
		const capability = instance.capabilities.get(TerminalCapability.CommandDetection);
		if (capability) {
			this.observeCapability(capability, listeners);
		}
		listeners.add(instance.capabilities.onDidAddCommandDetectionCapability(capability => this.observeCapability(capability, listeners)));
	}

	private observeCapability(capability: ICommandDetectionCapability, listeners: DisposableStore): void {
		if (this.observedCapabilities.has(capability)) {
			return;
		}
		this.observedCapabilities.add(capability);
		listeners.add({ dispose: () => this.observedCapabilities.delete(capability) });
		listeners.add(capability.onCommandFinished(() => this.synchronizeScheduler.schedule(50)));
	}

	private disposeTerminal(instanceId: number): void {
		const terminal = this.terminals.get(instanceId);
		if (!terminal) {
			return;
		}
		this.terminals.delete(instanceId);
		this.synchronizeScheduler.cancel();
		terminal.listeners.dispose();
		terminal.instance.dispose();
	}

	override dispose(): void {
		for (const instanceId of [...this.terminals.keys()]) {
			this.disposeTerminal(instanceId);
		}
		super.dispose();
		const hostTerminals = this.suspendedHostTerminals.splice(0).filter(instance => !instance.isDisposed);
		void Promise.all(hostTerminals.map(instance => this.terminalService.showBackgroundTerminal(instance, true))).catch(onUnexpectedError);
	}
}
