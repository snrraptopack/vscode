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

The first native adapter snapshots a bounded workspace tree, then records real file lifecycle events, text-model changes, active resources, selections, editor scrolling, and saves while the creator continues using the normal workbench. Continuous wheel and trackpad movement is sampled at a bounded cadence while preserving the final resting position. Resources are stored as workspace-root index plus relative path; models outside the workspace are ignored so drafts do not capture absolute machine paths. A native status-bar entry is the only persistent recording chrome.

### `ICodeScrimReplayService`

Loads validated packages, seeks to checkpoints, applies incremental events, coordinates native surfaces, and prevents replay mutations from being interpreted as learner actions.

The current workspace/editor slice projects checkpoint files and timeline-created files into a CodeScrim-owned learner directory outside the instructor workspace. A private instructor model receives recorded filesystem, text, active-resource, and selection events on the recording's monotonic clock. Its paired learner model uses the projected file URI and binds to the full native editor, allowing installed language providers to use their normal file-backed document path. The learner Files tab uses a native workbench async file tree over that directory, so icon themes, expandable folders, keyboard navigation, contextual creation, and resource drag/drop follow workbench behavior. Internal learner drags use tree-scoped transfer data rather than advertising editor inputs, preventing a file move from opening or splitting the editor grid. Learner-created entries are structural experiment state: Continue captures them with the learner checkpoint, removes them from the active instructor frame, and a timeline marker can restore them without adding them to the immutable recording. All replay mutations are serialized so a timer tick, scrub, restart, or manual file switch cannot dispose a model another operation is still using. Normal playback applies recorded incremental edits so Monaco preserves caret continuity; authoritative post-edit text anchors remain a corruption-recovery fallback.

Timeline dragging uses a separate in-memory preview projection. Once per animation frame it restores the nearest checkpoint and applies only the editor, terminal, and browser delta needed for the selected position. It updates the visible code, caret, scroll position, terminal presentation, and passive browser document without materializing files or restarting language services. Releasing the handle performs one authoritative seek into the disposable learner workspace while retaining the preview on screen, which keeps scrubbing responsive without weakening replay determinism.

Private instructor models retain the exact recorded state used for restore and comparison. The visible learner models use file-backed learner URIs and are synchronized to the normal document, editor, and language services. During passive replay those visible models contain the instructor's current text, so both instructor playback and learner edits receive live type inference, hover information, diagnostics, completions, formatting, and other installed language features. Recorded save events update only the disposable learner projection, never the creator's workspace. Running learner code remains a separate explicit sandbox capability.

Learner models are non-simple native models registered with the normal document and editor services, so language providers see both their documents and their visible embedded editors. The built-in TypeScript provider has one additional adapter change because it historically gated diagnostics on workbench tabs; it now also accepts standard visible text editors. This is a provider compatibility fix, not the CodeScrim language architecture.

### `ICodeScrimLearnerWorkspaceService`

Materializes recording checkpoints beneath CodeScrim-owned application storage and maps portable root-index/relative-path resources to learner URIs. It mirrors recorded file creation, deletion, and save boundaries, accepts learner-owned files and folders even when a lesson starts empty, includes binary assets, restores unsaved checkpoint text over captured disk bytes, and removes the projection when replay closes. A persisted ownership marker lets a later replay remove staging left by an interrupted window.

This service creates a file-system and tooling boundary only. It does not execute commands, filter network access, hide secrets, or claim process isolation; those responsibilities belong to the secure learner-execution milestone.

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
- The learner terminal is a separate native shell created only from the lesson's terminal button. Its working directory is the disposable learner projection, its input pauses replay for experimentation, and its lifecycle is never added to the instructor terminal track.
- Supported shell-integration adapters present that physical root as a stable `CodeScrim:\<lesson>` prompt. The OSC working-directory metadata and process cwd remain physical, so native file links, command detection, and execution are not faked.
- While the lesson surface is active, a scoped terminal launch-config resolver applies the same learner root and prompt metadata to native terminals created from the Terminal panel's New and Split actions. The resolver ignores replay PTYs, feature terminals, tasks, restored processes, and extension-owned terminals, and is disposed with the lesson.
- Foreground host terminals that predate the lesson are moved into the terminal service's background collection while the learner surface owns the workbench. Their processes remain alive and are restored when CodeScrim exits, preventing an author shell from appearing beside learner and replay terminals.
- Passive replay preserves the package's original terminal bytes but projects the recorded workspace-root text to the same logical `CodeScrim:\<lesson>` path at presentation time. This avoids exposing an instructor-machine path without mutating the recording or pretending that a replay PTY has a host working directory.
- This local shell is an execution bridge, not a sandbox. Until the sandbox milestone, its child processes, network access, inherited environment, and access outside the projected working directory have the normal host-terminal capabilities.
- Known vertical-slice issue: opening the native terminal panel or beginning terminal replay can disturb the learner editor's caret/active-line presentation. The panel path currently drops the terminal service's `preserveFocus` argument, so this requires explicit editor-state preservation or a native terminal integration correction rather than a Boolean call-site change.

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
- The first desktop implementation uses Electron's inherited `getUserMedia` and `MediaRecorder` support and stores an independently decodable segment for each active recording interval.
- Replay decodes narration through a product-owned `AudioContext`, corrects meaningful drift against replay position, and pauses or seeks with the rest of the lesson.
- CodeScrim deliberately does not depend on Chat Voice Mode: that path produces speech-service PCM, while lesson narration needs portable encoded media.
- Device selection, input-level UI, narration replacement, crash-safe live chunk persistence, and any future signed native sidecar remain later audio layers.

## Browser capture and replay

- The instructor opens the core Integrated Browser through a CodeScrim title-bar action. CodeScrim does not ship or invoke the Simple Browser extension.
- Recording captures serialized DOM states of visible instructor pages through the preloaded isolated-world helper: the live document is cloned, scripts and event-handler attributes are stripped, and live form state is persisted before the state leaves the page. An isolated `MutationObserver` plus input, change, scroll, and navigation signals marks the page dirty after fetch-driven renders and instructor interaction. CodeScrim coalesces those signals, captures the settled state on the session clock, and deduplicates identical states.
- Browser replay is DOM-state reconstruction, not video and not live re-navigation: the Lesson Preview parses each recorded state as trusted passive HTML and reconciles it into one persistent sandboxed iframe. The frame document is not replaced between states, avoiding white flashes and preserving the continuity expected from editor replay. Recorded page scripts are never executed.
- The replay surface is the same element the learner interacts with, mirroring the code replay model: during playback it shows the instructor's DOM state; learner interaction happens on real DOM in the same surface.
- Snapshots are content-addressed and encrypted with the rest of the `.scrim`; URLs are metadata rather than replay instructions.
- My Preview is a separate native Integrated Browser opened only by learner action. Its history, execution, and network effects are not instructor replay state.
- Full DOM states are the first correct event representation. A later package optimization may encode intermediate states as DOM patches between periodic full checkpoints without changing replay behavior. Console and network metadata can augment this track without making passive replay execute requests or page scripts.

## Native UI composition

### Course home

A serializable native `EditorInput` and `EditorPane` render courses, learning paths, progress, saved experiments, and recent lessons in the editor area.

### Lesson mode

The active lesson initially owns a fixed native workspace inside the editor area:

- course navigation is a left rail;
- transcript and notes are a right rail;
- the center is an unframed editor canvas with a docked transport;
- each rail owns its collapse action; when collapsed, one restore action remains on the corresponding edge of the center canvas.

`ICodeScrimLayoutService` leases the surrounding workbench layout while a lesson is visible. It hides document tabs, editor-group actions, the global layout controls, activity bar, normal sidebars, panel, and status bar. Attempts to reopen those workbench parts during the lease are rejected so they cannot squeeze or split the lesson. Every prior visibility and option value is restored when the last lesson lease closes. The visibility snapshot is also persisted before the lease changes the native layout, allowing the next startup to recover the author workbench if the window exits while a lesson is open.

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
