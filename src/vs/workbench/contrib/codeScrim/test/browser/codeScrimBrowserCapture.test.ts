/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IBrowserViewModel } from '../../../browserView/common/browserView.js';
import { CodeScrimBrowserCapture } from '../../browser/codeScrimBrowserCapture.js';
import { ICodeScrimBrowserWindowService } from '../../browser/codeScrimBrowserWindowService.js';

suite('CodeScrimBrowserCapture', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('captures external pages as interactive passive DOM', async () => {
		let domCaptureCount = 0;
		const model = new class extends mock<IBrowserViewModel>() {
			override readonly id = 'external-page';
			override readonly url = 'https://github.com/example/project';
			override readonly title = 'Project';
			override readonly visible = true;
			override readonly focused = true;
			override readonly loading = false;
			override readonly onDidChangeVisibility = Event.None;
			override readonly onDidChangeFocus = Event.None;
			override readonly onDidNavigate = Event.None;
			override readonly onDidChangeTitle = Event.None;
			override readonly onDidChangeContent = Event.None;
			override readonly onDidScroll = Event.None;
			override readonly onDidChangeLoadingState = Event.None;
			override readonly onDidClose = Event.None;
			override async captureDomSnapshot(): Promise<{ html: string; scrollY: number; title: string; url: string }> {
				domCaptureCount++;
				return { html: '<html><body><button>Open</button></body></html>', scrollY: 20, title: this.title, url: this.url };
			}
		}();
		const browserService = new class extends mock<ICodeScrimBrowserWindowService>() {
			override readonly onDidChangeAuthorPage = Event.None;
			override readonly authorPageModels = [model];
			override readonly activeAuthorPageId = model.id;
		}();
		const capture = disposables.add(new CodeScrimBrowserCapture(browserService, new NullLogService()));
		await capture.start(() => 0);
		await capture.pause(0);
		const track = await capture.finish(0);

		assert.deepStrictEqual({
			domCaptureCount,
			url: track?.snapshots[0]?.url,
			interactiveDom: track?.snapshots[0]?.html.includes('<button>Open</button>'),
			scrollTop: track?.snapshots[0]?.scrollTop,
		}, { domCaptureCount: 2, url: model.url, interactiveDom: true, scrollTop: 20 });
	});
});
