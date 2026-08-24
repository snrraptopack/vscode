/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { toCodeScrimBrowserReplayDocument } from './codeScrimBrowserReplayDocument.js';

const guardedDocuments = new WeakSet<Document>();

/** Applies a passive browser state without replacing the replay frame document. */
export function applyCodeScrimBrowserReplayDom(frame: HTMLIFrameElement, html: string): boolean {
	const currentDocument = frame.contentDocument;
	if (!currentDocument?.documentElement) {
		// A recorded link may have navigated an older replay frame away from its
		// local document. Return it to a passive srcdoc so rewind can recover.
		frame.srcdoc = toCodeScrimBrowserReplayDocument(html);
		return false;
	}
	const targetDocument = new mainWindow.DOMParser().parseFromString(toCodeScrimBrowserReplayDocument(html), 'text/html');
	if (!targetDocument.documentElement) {
		return false;
	}
	reconcileNode(currentDocument.documentElement, targetDocument.documentElement, currentDocument);
	installPassiveNavigationGuards(currentDocument);
	return true;
}

function reconcileNode(current: Node, target: Node, ownerDocument: Document): void {
	if (current.isEqualNode(target)) {
		return;
	}
	if (!canReconcile(current, target)) {
		current.parentNode?.replaceChild(ownerDocument.importNode(target, true), current);
		return;
	}
	if (current.nodeType === mainWindow.Node.TEXT_NODE || current.nodeType === mainWindow.Node.COMMENT_NODE) {
		if (current.nodeValue !== target.nodeValue) {
			current.nodeValue = target.nodeValue;
		}
		return;
	}
	if (current.nodeType !== mainWindow.Node.ELEMENT_NODE) {
		return;
	}
	const currentElement = current as Element;
	const targetElement = target as Element;
	syncAttributes(currentElement, targetElement);

	let index = 0;
	while (index < target.childNodes.length) {
		const targetChild = target.childNodes.item(index)!;
		const currentChild = current.childNodes.item(index);
		if (!currentChild) {
			current.appendChild(ownerDocument.importNode(targetChild, true));
		} else if (canReconcile(currentChild, targetChild)) {
			reconcileNode(currentChild, targetChild, ownerDocument);
		} else {
			current.replaceChild(ownerDocument.importNode(targetChild, true), currentChild);
		}
		index++;
	}
	while (current.childNodes.length > target.childNodes.length) {
		current.lastChild?.remove();
	}
	syncLiveProperties(currentElement, targetElement);
}

function installPassiveNavigationGuards(document: Document): void {
	const targetWindow = document.defaultView;
	if (!targetWindow || guardedDocuments.has(document)) {
		return;
	}
	guardedDocuments.add(document);
	const preventLinkNavigation = (event: Event) => {
		const target = event.target as Node | null;
		const element = target?.nodeType === 1 ? target as Element : target?.parentElement;
		if (element?.closest('a[href], area[href]')) {
			event.preventDefault();
		}
	};
	targetWindow.document.addEventListener('click', preventLinkNavigation, true);
	targetWindow.document.addEventListener('auxclick', preventLinkNavigation, true);
	targetWindow.document.addEventListener('submit', event => event.preventDefault(), true);
}

function canReconcile(current: Node, target: Node): boolean {
	if (current.nodeType !== target.nodeType) {
		return false;
	}
	if (current.nodeType !== mainWindow.Node.ELEMENT_NODE) {
		return true;
	}
	const currentElement = current as Element;
	const targetElement = target as Element;
	return currentElement.localName === targetElement.localName && currentElement.namespaceURI === targetElement.namespaceURI;
}

function syncAttributes(current: Element, target: Element): void {
	for (const name of current.getAttributeNames()) {
		if (!target.hasAttribute(name)) {
			current.removeAttribute(name);
		}
	}
	for (const attribute of target.attributes) {
		if (current.getAttribute(attribute.name) !== attribute.value) {
			current.setAttribute(attribute.name, attribute.value);
		}
	}
}

function syncLiveProperties(current: Element, target: Element): void {
	switch (target.localName) {
		case 'input': {
			const input = current as HTMLInputElement;
			input.value = target.getAttribute('value') ?? '';
			input.checked = target.hasAttribute('checked');
			break;
		}
		case 'textarea':
			(current as HTMLTextAreaElement).value = target.textContent ?? '';
			break;
		case 'select': {
			const select = current as HTMLSelectElement;
			for (const option of select.options) {
				option.selected = option.hasAttribute('selected');
			}
			break;
		}
		case 'details':
			(current as HTMLDetailsElement).open = target.hasAttribute('open');
			break;
	}
}
