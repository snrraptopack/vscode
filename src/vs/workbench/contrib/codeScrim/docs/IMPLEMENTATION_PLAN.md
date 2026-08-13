# Implementation Plan

## Delivery method

Each milestone is an end-to-end native slice with acceptance criteria and targeted tests. A milestone is not complete merely because UI exists; state transitions and cleanup must work.

## Milestone 0: Product contract and native shell

Status: complete.

- Create the isolated contribution and documentation.
- Register a native course-home editor input and editor pane.
- Register an explicit command to open the course home.
- Add one desktop workbench entry-point import.
- Render with native DOM and workbench theme tokens.

Acceptance criteria:

- The course home opens as a normal editor tab.
- No extension host, webview, activity-bar container, or sidebar view is involved.
- Reopening the command reveals the same logical singleton editor.
- Closing the editor disposes its scoped resources.

## Milestone 1: Session state and lesson shell

Status: complete.

- [x] Add `ICodeScrimSessionService` with an explicit state machine.
- [x] Add serializable lesson editor input and native lesson editor pane.
- [x] Add transport actions: play, pause, seek, restart.
- [x] Add an accessible timeline and transcript context.
- [x] Add a focused lesson layout lease with independently collapsible rails.

Acceptance criteria:

- State transitions are unit tested.
- The lesson editor survives workbench reload through serialization.
- Timeline actions update one authoritative clock.

Current vertical-slice note: the lesson editor now hosts the Milestone 2 recording-backed Monaco models, file navigation, and transport directly in its native center surface. Persisted resume metadata still moves to the package/checkpoint slice, where its schema can be versioned with the session.

## Milestone 2: Deterministic editor playback

Status: in progress.

- [x] Define the first v2 editor event contracts and append-only recording buffer.
- [x] Add a native editor recording slice for model edits, active-file changes, selections, and saves.
- [x] Capture a bounded immutable workspace checkpoint plus unsaved document state.
- [x] Record workspace file additions, updates, and deletions alongside editor events.
- [x] Apply incremental model edits through isolated native Monaco models.
- [x] Lazily materialize checkpoint and newly created text files without consulting the instructor's current disk.
- [x] Route replay resources and restored selections exclusively through the native learner lesson surface.
- [x] Add replay, stop, and restart commands with native status feedback.
- [x] Make Replay enter the learner lesson experience before applying its first event.
- [x] Load the prepared learner lesson at `0:00` and wait for an explicit Play action.
- [x] Bind the lesson's native center editor to recording-backed virtual models instead of replacing the lesson surface.
- [x] Add a recording-backed file tree and native multi-file tabs inside the learner experience.
- [x] Add arbitrary seek from the starting checkpoint.
- [x] Pause playback when the learner inspects another replay file, then return to the instructor's active file on resume.
- [x] Capture authoritative post-edit text anchors so intermediate reconstruction cannot drift from the instructor text.
- [x] Persist the latest stopped draft outside the workspace as an atomic encrypted `.scrim` recovery package.
- [x] Add a versioned binary envelope, AES-256-GCM authentication, gzip compression, and SHA-256 content-addressed blobs.
- [x] Add minimal native Save Recording and Open Recording commands.
- [x] Keep idle authoring controls out of the status bar; expose pause/resume and stop only during capture.
- [x] Exclude paused authoring time and events from the recorded session clock.
- [x] Add a CodeScrim-owned floating authoring dock without using the Activity Bar view system.
- [x] Keep automatic recovery outside the source workspace; create visible `.scrim` files only through Save As.
- [x] Validate package framing, versions, paths, event ordering, payloads, expansion limits, and blob integrity before replay.
- [x] Add compact learner/instructor comparison to the selected timeline-marker inspector.
- Add publisher signatures and account/course key envelopes for distributable packages.
- [x] Add required indexed intermediate checkpoints so long seeks restore the nearest snapshot instead of replaying from time zero.
- Capture normalized diagnostic/marker snapshots on the session clock for deterministic squiggles and Problems state.
- Keep captured instructor diagnostics separate from optional live diagnostics produced by a future learner sandbox.
- [x] Enter learner edit mode immediately on editing and pause before the instructor timeline advances.
- [x] Expose learner models to native language features without materializing them in the host workspace.
- [x] Capture learner changes as an in-memory checkpoint, restore the paused instructor frame, and continue from the same timestamp.
- [x] Render learner-edit markers on the playback timeline.
- [x] Make a marker open the learner checkpoint captured at that position.
- [x] Offer Review, Restore, Keep, and Delete actions from the selected marker inspector rather than interrupting normal playback.
- Persist named learner checkpoints and local Git-like history after marker semantics are stable.

Acceptance criteria:

- Play, seek, restore, and resume produce deterministic file contents.
- Learner changes survive until explicitly restored or discarded.
- Replay writes are not captured as learner events.
- A short native recording can be replayed without changing its final file contents or event ordering.

Current vertical-slice note: record, stop, recovery across restart, encrypted save/open, learner preview, play, pause, checkpoint-indexed seek, restart, manual file inspection, deterministic resume, and quiet learner experimentation now work for workspace and editor events. The checkpoint index captures portable file bytes, unsaved document text, active files, and selections under explicit safety limits. Replay owns an immutable instructor model plus a separately editable learner model for each materialized file. Editing pauses the instructor clock without adding another banner. Continue captures changed files in an in-memory learner checkpoint, silently restores the exact instructor frame, and resumes from that timestamp. Each captured experiment appears as a marker on the playback timeline; its compact inspector provides native diff review plus Restore, Keep, and Delete actions. Published key distribution/signatures, captured diagnostics, and non-editor domains are intentionally not claimed yet.

## Milestone 3: Native browser integration

- Create a lesson-scoped native browser editor.
- Record and replay navigation, viewport, console, network, and selected browser state through browser model/CDP services.
- Integrate native DevTools.

Acceptance criteria:

- A local development server remains live while the lesson is paused.
- Cookies, storage, authentication, and permissions are isolated according to lesson policy.
- Closing a lesson cleans up its browser context and restores the user's layout.

## Milestone 4: Terminal and debugging

- Capture terminal lifecycle, input, output, commands, working directories, dimensions, and exit state.
- Replay recorded terminal presentation without executing commands.
- Provide a real learner terminal rooted in the learner workspace.
- Capture debug lifecycle, breakpoints, focus, stack, variables, REPL, and relevant errors.
- Define runnable checkpoints for exercises that require live debug state.

Acceptance criteria:

- Terminal replay is timestamp-synchronized and seekable.
- Learner commands are never confused with instructor output.
- Debug events appear on the timeline and checkpoint restoration is explicit about what can be reconstructed.

## Milestone 5: Recording and narration

- Add native recording orchestration and one monotonic clock.
- Add cross-platform audio capture.
- Write chunked events and periodic checkpoints while recording.
- Recover a valid draft after a crash.
- Add chapter and checkpoint markers during recording.

Acceptance criteria:

- A ten-minute mixed editor/terminal/browser/debug recording remains responsive.
- Audio and IDE events remain synchronized after seeks.
- Interrupted recordings can be recovered or safely discarded.

## Milestone 6: Package, session editing, and exercises

- Implement the v2 package reader/writer and integrity validation.
- Add trimming, chapter editing, notes, exercises, and checkpoint editing.
- Add exercise validation hooks without coupling the package to a single language.
- Add v1 prototype import as a migration tool.

## Milestone 7: Secure learner execution

- Materialize a learner workspace from an instructor checkpoint without mutating instructor state.
- Require an explicit learner action before running code, tasks, terminal commands, debug configurations, or project scripts.
- Define local sandbox and remote/container runner capability levels.
- Enforce process, CPU, memory, disk, time, network, secret, and filesystem policies.
- Make trust decisions and unsupported isolation guarantees visible before execution.
- Destroy ephemeral execution environments while allowing an explicitly saved learner branch to persist.

Acceptance criteria:

- Passive playback cannot start a process or make a network request through recorded events.
- A learner can run a checkpoint only after choosing an available sandbox policy.
- Instructor snapshots remain byte-identical before and after learner execution.
- Cleanup terminates child processes and removes ephemeral writable state.

This milestone begins only after deterministic restore and learner overlays are stable. The product must not label ordinary local workspace execution as a strong sandbox.

## Milestone 8: Contextual learning assistant

- Define a privacy-filtered lesson context provider.
- Compare instructor and learner state.
- Support assistance levels controlled by session policy.
- Connect AI only after deterministic state and comparison are reliable.

## Validation strategy

- Unit-test host-neutral format, clock, state-machine, and replay logic.
- Use targeted workbench tests for editor/layout/service integration.
- Use native UI smoke tests for course home, playback, pause/edit, seek, restore, browser, terminal, and debugger flows.
- Run layer validation when a new cross-layer import is introduced.
- Avoid broad builds as a ritual; use the smallest validation that covers each change.
