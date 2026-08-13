# Native Architecture

## Architectural shape

CodeScrim is a workbench contribution that coordinates existing native services. It does not own replacements for the editor, terminal, debugger, or browser.

```text
Native input adapters
  editor | files | terminal | debug | browser/CDP | audio
                         |
                         v
                append-only recorder
                         |
                         v
             portable session package
                         |
                         v
              session clock + replay
                         |
           +-------------+-------------+
           |                           |
 instructor checkpoint          learner overlay
           |                           |
           +-------------+-------------+
                         |
                         v
             native workbench surfaces
```

## Source layout

```text
src/vs/workbench/contrib/codeScrim/
├── common/             Host-neutral types, event contracts, state machines
├── browser/            Native DOM editor panes and renderer services
├── electron-browser/   Desktop adapters for browser, terminal, debug, and audio
├── test/               Unit and workbench tests
└── docs/               Product and engineering contracts
```

Only capabilities that require main-process authority belong under:

```text
src/vs/platform/codeScrim/
├── common/             IPC-safe service contracts
└── electron-main/      Native audio, package streaming, or OS integration
```

That platform directory must not be created merely to bypass dependency injection. A renderer implementation remains in the workbench contribution when it can use existing services.

## Core services

### `ICodeScrimSessionService`

Owns the active course, lesson, session mode, timeline position, playback state, selected checkpoint, and learner-branch identity. It is the single state authority.

It exposes direct operations for control flow and events only for broadcasting state changes.

### `ICodeScrimRecorderService`

Starts and stops recordings, owns recorder adapters, normalizes timestamps against one monotonic clock, writes event chunks, and creates checkpoints.

The first native adapter snapshots a bounded workspace tree, then records real file lifecycle events, text-model changes, active resources, selections, and saves while the creator continues using the normal workbench. Resources are stored as workspace-root index plus relative path; models outside the workspace are ignored so drafts do not capture absolute machine paths. A native status-bar entry is the only persistent recording chrome.

### `ICodeScrimReplayService`

Loads validated packages, seeks to checkpoints, applies incremental events, coordinates native surfaces, and prevents replay mutations from being interpreted as learner actions.

The current workspace/editor slice lazily materializes checkpoint files and timeline-created files as replay-owned Monaco text models. A private instructor model receives recorded filesystem, text, active-resource, and selection events on the recording's monotonic clock. Its paired learner model uses an isolated `untitled:` URI and binds to the full native editor, allowing extension-host language features while remaining disconnected from disk. The learner surface exposes a themed virtual tree, multi-file tabs, manual inspection, and arbitrary seek. All replay mutations are serialized so a timer tick, scrub, restart, or manual file switch cannot dispose a model another operation is still using. Authoritative post-edit text anchors prevent incremental range drift from corrupting later frames.

Private instructor models retain their recorded language for native tokenization but are not synchronized to extension-host language services. Learner models are synchronized and can receive live editing diagnostics, completions, formatting, and other language features. Deterministic instructor squiggles still require a timestamped captured-diagnostics track. Save events remain timeline markers during passive playback, so replay never writes instructor state into the creator's workspace or depends on files that remain on the creator's disk. Running learner code remains a separate explicit sandbox capability.

### `ICodeScrimWorkspaceService`

Materializes immutable instructor state and learner overlays. It owns restore, branch, compare, and cleanup behavior.

### `ICodeScrimLayoutService`

Enters and exits lesson layouts using `IEditorGroupsService`, `IEditorService`, and `IWorkbenchLayoutService`. It restores the user's previous layout when a lesson closes.

### `ICodeScrimPackageService`

Validates manifests, streams event chunks and media, verifies hashes, and performs schema migration. Parsing is separated from materializing files.

## Native input adapters

### Editor and files

- `IModelService` observes model creation and content changes.
- `IEditorService` observes active and visible editors.
- `IFileService` observes file operations.
- `ITextFileService` observes save and revert state.
- Selections, visible ranges, and active-file changes are captured only when meaningful to instruction.

### Terminal

- `ITerminalService` observes terminal lifecycle.
- `ITerminalInstance.onDidInputData` and `onDidSendText` capture intentional input.
- `ITerminalInstance.onData` captures output.
- Commands, output, exit state, dimensions, and working directory are separate event fields.
- Passive replay renders recorded output. It never reruns commands without an explicit exercise or learner action.

### Debugger

- `IDebugService` observes sessions, state, focus, breakpoints, stack frames, call stacks, REPL, and watched expressions.
- Replay initially restores presentation and breakpoint state; recreating runtime state requires an explicit runnable checkpoint.

### Integrated browser

- `IBrowserViewWorkbenchService` owns native browser editor inputs and models.
- `IBrowserViewModel` provides navigation, permissions, storage, screenshots, DevTools, selection, and device state.
- `IBrowserViewCDPService` captures Console, Network, Runtime, DOM, Page, and Storage domain events.
- Browser state belongs to a lesson-scoped browser context so authentication and storage can be isolated or restored deliberately.
- rrweb may be an optional visual fallback for unsupported state; it is not the primary browser architecture.

### Audio

- One monotonic session clock timestamps audio and IDE events.
- Audio capture is a native product service, not a hidden webview.
- The platform implementation may use a small signed sidecar when Electron does not expose a reliable cross-platform recording API.

## Native UI composition

### Course home

A serializable native `EditorInput` and `EditorPane` render courses, learning paths, progress, saved experiments, and recent lessons in the editor area.

### Lesson mode

The active lesson initially owns a fixed native workspace inside the editor area:

- course navigation is a left rail;
- transcript and notes are a right rail;
- the center is an unframed editor canvas with a docked transport;
- each rail owns its collapse action; when collapsed, one restore action remains on the corresponding edge of the center canvas.

`ICodeScrimLayoutService` leases the surrounding workbench layout while a lesson is visible. It hides document tabs, editor-group actions, the global layout controls, activity bar, normal sidebars, panel, and status bar. Attempts to reopen those workbench parts during the lease are rejected so they cannot squeeze or split the lesson. Every prior visibility and option value is restored when the last lesson lease closes.

Playback still targets real workbench surfaces: normal Monaco text models and editors, the native browser editor, terminal instances, and debug services. The lesson shell must not embed simulated copies of those surfaces.

The initial implementation does not modify `EditorPart`. If a later design requires a transport spanning all editor groups, that change must be justified by an architecture decision and recorded as an upstream integration point.

## State separation

```text
base checkpoint (immutable)
        + instructor events to time T
        = instructor state at T

instructor state at T
        + learner overlay
        = learner working state
```

Playback advances instructor state. Learner edits advance only the overlay. Resume never destroys the overlay implicitly.

## Dependency rules

- `common` imports only host-neutral/base/platform-common modules.
- `browser` may depend on workbench browser services.
- `electron-browser` may depend on desktop-only workbench and platform services.
- Workbench code may import existing editor, terminal, debug, and browser services; those components must not import CodeScrim.
- Service dependencies are constructor-injected.
- Every created disposable is registered immediately with the correct session or component lifetime.
- No component manipulates another component's storage keys.
