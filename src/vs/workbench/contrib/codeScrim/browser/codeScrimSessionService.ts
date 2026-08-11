/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { CodeScrimSessionClock, ICodeScrimLessonDescriptor, ICodeScrimSessionService, ICodeScrimSessionState } from '../common/codeScrimSession.js';

export class CodeScrimSessionService extends Disposable implements ICodeScrimSessionService {

	declare readonly _serviceBrand: undefined;

	private readonly clock = new CodeScrimSessionClock();
	private readonly timer = this._register(new MutableDisposable());
	private readonly _onDidChangeState = this._register(new Emitter<ICodeScrimSessionState | undefined>());
	readonly onDidChangeState = this._onDidChangeState.event;

	get state(): ICodeScrimSessionState | undefined {
		return this.clock.state;
	}

	openLesson(lesson: ICodeScrimLessonDescriptor, initialPosition = 0): void {
		if (this.state?.lesson.id === lesson.id) {
			return;
		}

		this.publish(this.clock.openLesson(lesson, initialPosition));
	}

	closeLesson(): void {
		this.publish(this.clock.closeLesson());
	}

	play(): void {
		this.publish(this.clock.play(this.now()));
	}

	pause(): void {
		this.publish(this.clock.pause(this.now()));
	}

	seek(position: number): void {
		this.publish(this.clock.seek(position, this.now()));
	}

	restart(): void {
		this.publish(this.clock.restart());
	}

	private publish(state: ICodeScrimSessionState | undefined): void {
		this.syncTimer(state);
		this._onDidChangeState.fire(state);
	}

	private syncTimer(state: ICodeScrimSessionState | undefined): void {
		if (state?.status !== 'playing') {
			this.timer.clear();
			return;
		}

		if (!this.timer.value) {
			const handle = mainWindow.setInterval(() => this.publish(this.clock.tick(this.now())), 100);
			this.timer.value = toDisposable(() => mainWindow.clearInterval(handle));
		}
	}

	private now(): number {
		return mainWindow.performance.now();
	}
}
