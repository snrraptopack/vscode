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
- isolated replay through real Monaco models without modifying workspace files; and
- focused unit tests for playback, recording-clock, checkpoint, and replay-cursor transitions.

Recording is started and stopped through native CodeScrim commands. While active, a normal VS Code status-bar entry shows the captured event count and stops the recording when clicked. `CodeScrim: Replay Last Recording` then opens isolated native editor models and applies the recorded events on their original monotonic timeline. Replay status can stop or restart the run.

This is an in-memory workspace/editor vertical slice: restarting the product discards the draft, and terminal, browser, debugger, narration, persisted packages, seeking, a virtual file explorer, learner overlays, and sandboxed learner execution remain on the roadmap. Passive replay never executes recorded code or commands.
