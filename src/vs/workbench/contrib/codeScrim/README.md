# CodeScrim Native Workbench

CodeScrim turns the VS Code workbench into an interactive technical-learning environment. A lesson replays real development state through the native editor, terminal, debugger, and integrated browser. The learner can pause, experiment safely, restore the instructor state, and continue.

The canonical product vision is [product-vision-and-features.md](../../../../../product-vision-and-features.md).

## Non-negotiable boundaries

- CodeScrim is native workbench functionality. It is not implemented as an extension, bundled extension, webview, or sidebar player.
- The editor, terminal, debugger, and browser used by a lesson are the real workbench surfaces.
- Playback records and restores development state. It must not degrade the lesson into recorded pixels.
- Instructor state is immutable. Learner experiments live in an isolated overlay or branch.
- The session format is portable and independent of VS Code-specific object shapes.
- New implementation stays inside this contribution unless a narrow capability must be added to the service that owns it.
- Upstream modifications are kept explicit and recorded in [docs/UPSTREAM_INTEGRATION.md](docs/UPSTREAM_INTEGRATION.md).

## Documentation map

- [Product contract](docs/PRODUCT.md)
- [Native architecture](docs/ARCHITECTURE.md)
- [Session format](docs/SESSION_FORMAT.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Development setup](docs/DEVELOPMENT.md)
- [Upstream integration](docs/UPSTREAM_INTEGRATION.md)
- [Architecture decisions](docs/DECISIONS.md)

## Current implementation

The current native slice provides:

- a CodeScrim course-home editor in the main editor area;
- a serializable native lesson editor, opened from the course home or command palette;
- one workbench-level session service with a deterministic monotonic playback clock;
- a focused three-pane lesson workspace with independently collapsible native rails;
- a scoped layout lease that restores the previous workbench layout on exit;
- native play, pause, seek, replay, and restart controls;
- native editor recording for text edits, active files, selections, and saves;
- an immutable starting checkpoint for every document touched during recording;
- a bounded immutable workspace-tree snapshot with recorded file lifecycle changes;
- isolated replay through real Monaco models without modifying workspace files;
- a native learner-preview surface with a themed virtual file tree and multi-file tabs;
- deterministic timeline scrubbing while paused or playing;
- automatic pause for manual file inspection and return to the instructor's active file on resume;
- recording pause/resume with paused wall-clock time removed from the learner timeline;
- restart-safe draft recovery plus encrypted `.scrim` save/open commands; and
- focused unit tests for playback, recording-clock, checkpoint, and replay-cursor transitions.

Creator actions live in a CodeScrim-owned floating dock opened by a circular bottom-left launcher. It does not register an Activity Bar container or extension-style view and does not resize the editor. The status bar is empty while authoring is idle; during capture it exposes only the unmistakable live state, pause/resume, event count, and stop action. `CodeScrim: Replay Last Recording` opens the native learner experience, reconstructs isolated editor models, and applies the recorded events on their original monotonic timeline. Replay status can stop or restart the run.

This is a persisted workspace/editor vertical slice: the latest stopped draft is recovered across product restarts and may be exported or opened as an opaque authenticated `.scrim` package. Automatic recovery is stored in product profile storage and never creates a visible file in the instructor workspace. A visible `.scrim` exists only after an explicit Save As destination is chosen through the operating-system save dialog. Rich package-library/configuration UI, publisher signatures, account/course key distribution, indexed intermediate checkpoints, terminal, browser, debugger, narration, captured diagnostics, learner overlays, and sandboxed learner execution remain on the roadmap. Passive replay never executes recorded code or commands. Replay currently provides syntax tokenization from the recorded language ID, but deterministic lint/type squiggles require the planned diagnostic event track rather than rerunning the instructor's language server against virtual models.
