# Upstream Integration and Sync Policy

## Objective

CodeScrim remains a thin, explicit fork of VS Code. Normal upstream synchronization should take hours or days, not weeks of rediscovering product changes.

## Rules

1. Prefer new files under `src/vs/workbench/contrib/codeScrim`.
2. Consume existing service interfaces before changing their implementations.
3. Add a missing capability to the component that owns it through the narrowest typed API.
4. Never access another component through its private storage keys or `IInstantiationService` service lookup.
5. Keep upstream hooks in isolated commits with `codescrim-api-hook` in the subject.
6. Do not edit generated files.
7. Do not copy upstream implementations into the CodeScrim directory.
8. Record every modified upstream-owned file in the ledger below.
9. Add or update a focused test for every new upstream API.
10. Merge `upstream/main` at least weekly while active development continues.

## Current integration ledger

| Upstream-owned file | Change | Reason | Expected conflict risk |
|---|---|---|---|
| `src/vs/workbench/workbench.desktop.main.ts` | One contribution import | Load native CodeScrim desktop workbench code | Low |
| `src/vs/platform/browserView/electron-main/browserView.ts` | Explicitly dock BrowserView DevTools on the right | Keep an inspected lesson page and its native DevTools visible together for authoring and capture | Low |
| `src/vs/platform/browserView/common/browserView.ts` | Add `captureDomSnapshot(id)` and `onDynamicDidChangeContent(id)` to `IBrowserViewService` | Browser replay must serialize the recorded page and know when fetches or interactions changed its state | Low — one method and one event on a large interface |
| `src/vs/platform/browserView/electron-main/browserView.ts` | Add `BrowserView.captureDomSnapshot()` plus a main-frame content-change event | Main-process implementation and typed event boundary for passive DOM-state capture | Low |
| `src/vs/platform/browserView/electron-main/browserViewMainService.ts` | Forward DOM snapshots and content-change events over the existing IPC channel | IPC plumbing for browser-state recording | Very low |
| `src/vs/platform/browserView/electron-browser/preload-browserView.ts` | Add the frozen `captureDomSnapshot` helper and coalesced mutation/input/change/scroll dirty signals | Page-side primitives capture settled application state without injecting logic into the page's main world | Low — isolated-world additions only |
| `src/vs/workbench/contrib/browserView/common/browserView.ts` | Add `captureDomSnapshot()` and `onDidChangeContent` to `IBrowserViewModel`/`BrowserViewModel` | Renderer-facing seams let CodeScrim record page state without CDP | Low |
| `src/vs/code/electron-browser/workbench/workbench.html` and `workbench-dev.html` | Allow the `codescrimBrowserReplay` Trusted Types policy | Serialized passive DOM states must become `TrustedHTML` before parsing for reconciliation into the lesson iframe | Low |

All other current product files are CodeScrim-owned files.

### Upstream API history

Each new upstream API is listed with its motivation and what to watch for on merge:

1. **DevTools docking hook** (`platform/browserView/electron-main/browserView.ts`). Forces BrowserView DevTools to dock right instead of floating. Watch for upstream refactors of `BrowserView` construction or DevTools positioning; resolution is to re-apply the one-line option.
2. **DOM snapshot chain** (`captureDomSnapshot`, 2026-08). Five files, one capability. The renderer model method delegates to the platform service, which forwards over IPC to the main-process view, which invokes the preloaded isolated-world helper that clones the live document, strips scripts and event-handler attributes, and returns a self-contained HTML string with scroll/title/URL metadata. Motivation: CodeScrim browser replay reconstructs the recorded page's DOM in a sandboxed iframe — real elements, offline, no recorded content executed. DOM state could not be captured through any existing renderer-facing API — only through CDP, which CodeScrim deliberately retired as a capture/replay foundation. A previous scroll-restore chain (`setScrollTop`) was added for an earlier live-browser replay design and was removed when replay moved to snapshot rendering; if a future design needs main-process-driven scrolling, re-add it through the same isolated-world pattern. Watch for:
   - upstream adding a native DOM serialization API to `WebContentsView` handling or `IBrowserViewService` (then this chain collapses into it and the fork hook is removable);
   - changes to the preload's isolated-world contract (`browserViewIsolatedWorldId`, the frozen `browserViewAPI` object) — a rename here silently breaks `captureDomSnapshot` because the call is an optional-chained string;
   - Electron behavior changes around `executeJavaScriptInIsolatedWorld` on destroyed/loading frames — the implementation already tolerates failure and returns undefined.

Milestone 1 added only CodeScrim-owned files and did not widen the upstream integration surface.

## Planned integration points

These are possibilities, not authorization to modify them:

| Area | Existing API first | Modification threshold |
|---|---|---|
| Editor/model | `IModelService`, `IEditorService`, `ITextFileService` | Only if replay-origin metadata cannot be carried safely |
| Files | `IFileService` | Only if atomic overlay materialization requires a missing operation |
| Terminal | `ITerminalService`, `ITerminalInstance` events | Only if output causation or snapshot state is unavailable |
| Debug | `IDebugService` and debug model events | Only if a required state transition is not observable |
| Browser | `IBrowserViewWorkbenchService`, `IBrowserViewModel` events, isolated-world preload helpers | Only if lesson-scoped context or required page state is inaccessible through typed APIs. CDP is not used for capture or replay |
| Layout | `IEditorGroupsService`, `IWorkbenchLayoutService` | Modify `EditorPart` only after an approved architecture decision |
| Audio | Existing Electron/media capabilities | Add a platform service only for reliable cross-platform capture |

## Sync procedure

The repository already has `upstream` pointing to `microsoft/vscode`.

1. Ensure CodeScrim changes are committed and the worktree is clean.
2. Fetch `upstream`.
3. Merge `upstream/main` into the long-lived CodeScrim branch.
4. Resolve the explicit integration ledger first.
5. Review upstream changes to every internal service CodeScrim consumes.
6. Run format/state tests, targeted workbench tests, layer validation when applicable, and the native smoke flow.
7. Update this ledger if any upstream-owned file changed.
8. Commit the merge without mixing unrelated product work.

Enable Git's recorded conflict resolution for recurring import conflicts:

```powershell
git config rerere.enabled true
```

## Upstream review checklist

- Did an imported service interface change?
- Did an event's ordering or lifetime change?
- Did browser-view IPC or preload isolated-world behavior change?
- Did editor serialization or group restoration change?
- Did terminal process/input ownership change?
- Does the opt-in `VSCODE_CODESCRIM_WORKSPACE_*` PowerShell prompt adapter still wrap the native prompt without changing OSC cwd metadata or non-CodeScrim terminals?
- Does `ITerminalService.registerShellLaunchConfigResolver` still run after profile conversion and before cwd resolution so lesson-scoped New/Split terminals can receive the learner root without importing CodeScrim into Terminal?
- Do `moveToBackground` and `showBackgroundTerminal` still preserve a live terminal instance so CodeScrim can temporarily quarantine author terminals and restore them on lesson exit?
- Did debug-session lifecycle change?
- Did security, workspace trust, or permission behavior change?
- Does the CodeScrim contribution still satisfy layer rules?
- Is a previously necessary fork hook now available upstream and removable?
