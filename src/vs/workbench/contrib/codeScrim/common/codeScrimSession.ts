/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const CODE_SCRIM_OPEN_COURSE_HOME_COMMAND_ID = 'codescrim.openCourseHome';
export const CODE_SCRIM_OPEN_DEMO_LESSON_COMMAND_ID = 'codescrim.openDemoLesson';

export interface ICodeScrimLessonDescriptor {
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly duration: number;
}

export type CodeScrimPlaybackStatus = 'ready' | 'playing' | 'paused' | 'ended';

export interface ICodeScrimSessionState {
	readonly lesson: ICodeScrimLessonDescriptor;
	readonly status: CodeScrimPlaybackStatus;
	readonly position: number;
	readonly duration: number;
}

/**
 * Host-neutral playback state machine. All times are milliseconds and the caller supplies the
 * monotonic clock, which keeps this class deterministic and straightforward to test.
 */
export class CodeScrimSessionClock {

	private _state: ICodeScrimSessionState | undefined;
	private anchorPosition = 0;
	private anchorTime = 0;

	get state(): ICodeScrimSessionState | undefined {
		return this._state;
	}

	openLesson(lesson: ICodeScrimLessonDescriptor, initialPosition = 0): ICodeScrimSessionState {
		const duration = Math.max(0, lesson.duration);
		const position = this.clampPosition(initialPosition, duration);
		this.anchorPosition = position;
		this.anchorTime = 0;
		return this.setState(lesson, position >= duration && duration > 0 ? 'ended' : 'ready', position, duration);
	}

	closeLesson(): undefined {
		this._state = undefined;
		this.anchorPosition = 0;
		this.anchorTime = 0;
		return undefined;
	}

	play(now: number): ICodeScrimSessionState | undefined {
		if (!this._state || this._state.status === 'playing') {
			return this._state;
		}

		const position = this._state.status === 'ended' ? 0 : this._state.position;
		this.anchorPosition = position;
		this.anchorTime = now;
		return this.setState(this._state.lesson, 'playing', position, this._state.duration);
	}

	pause(now: number): ICodeScrimSessionState | undefined {
		if (!this._state || this._state.status !== 'playing') {
			return this._state;
		}

		const state = this.resolvePlayingState(now);
		if (state.status === 'ended') {
			return state;
		}

		this.anchorPosition = state.position;
		this.anchorTime = now;
		return this.setState(state.lesson, 'paused', state.position, state.duration);
	}

	seek(position: number, now: number): ICodeScrimSessionState | undefined {
		if (!this._state) {
			return undefined;
		}

		const nextPosition = this.clampPosition(position, this._state.duration);
		const status = nextPosition >= this._state.duration && this._state.duration > 0
			? 'ended'
			: this._state.status === 'playing' ? 'playing' : this._state.status === 'ended' ? 'paused' : this._state.status;

		this.anchorPosition = nextPosition;
		this.anchorTime = now;
		return this.setState(this._state.lesson, status, nextPosition, this._state.duration);
	}

	restart(): ICodeScrimSessionState | undefined {
		if (!this._state) {
			return undefined;
		}

		this.anchorPosition = 0;
		this.anchorTime = 0;
		return this.setState(this._state.lesson, 'ready', 0, this._state.duration);
	}

	tick(now: number): ICodeScrimSessionState | undefined {
		if (!this._state || this._state.status !== 'playing') {
			return this._state;
		}

		return this.resolvePlayingState(now);
	}

	private resolvePlayingState(now: number): ICodeScrimSessionState {
		const state = this._state!;
		const elapsed = Math.max(0, now - this.anchorTime);
		const position = this.clampPosition(this.anchorPosition + elapsed, state.duration);
		const status = position >= state.duration ? 'ended' : 'playing';
		return this.setState(state.lesson, status, position, state.duration);
	}

	private setState(lesson: ICodeScrimLessonDescriptor, status: CodeScrimPlaybackStatus, position: number, duration: number): ICodeScrimSessionState {
		return this._state = Object.freeze({ lesson, status, position, duration });
	}

	private clampPosition(position: number, duration: number): number {
		if (!Number.isFinite(position)) {
			return 0;
		}

		return Math.min(Math.max(0, position), duration);
	}
}

export const ICodeScrimSessionService = createDecorator<ICodeScrimSessionService>('codeScrimSessionService');

export interface ICodeScrimSessionService {
	readonly _serviceBrand: undefined;
	readonly state: ICodeScrimSessionState | undefined;
	readonly onDidChangeState: Event<ICodeScrimSessionState | undefined>;

	openLesson(lesson: ICodeScrimLessonDescriptor, initialPosition?: number): void;
	closeLesson(): void;
	play(): void;
	pause(): void;
	seek(position: number): void;
	restart(): void;
}

export const ICodeScrimLayoutService = createDecorator<ICodeScrimLayoutService>('codeScrimLayoutService');

export interface ICodeScrimLayoutService {
	readonly _serviceBrand: undefined;

	/**
	 * Restores a learner layout lease that survived a window shutdown. This is called once after
	 * workbench restoration, before the author starts another CodeScrim session.
	 */
	restoreStaleCodeScrimLayout(): void;

	/**
	 * Enters the focused CodeScrim product shell and restores the previous workbench layout when
	 * the returned handle is disposed. Multiple visible CodeScrim panes share one layout lease.
	 */
	enterCodeScrimMode(): IDisposable;
}
