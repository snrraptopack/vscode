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

Current vertical-slice note: the lesson editor is a native transport and session-state shell. It deliberately does not simulate code playback; Milestone 2 will drive real text models and editor inputs from recorded events. Persisted resume metadata moves to the package/checkpoint slice, where its schema can be versioned with the session.

## Milestone 2: Deterministic editor playback

Status: in progress.

- [x] Define the first v2 editor event contracts and append-only recording buffer.
- [x] Add a native editor recording slice for model edits, active-file changes, selections, and saves.
- [x] Capture a bounded immutable workspace checkpoint plus unsaved document state.
- [x] Record workspace file additions, updates, and deletions alongside editor events.
- [x] Apply incremental model edits through isolated native Monaco models.
- [x] Lazily materialize checkpoint and newly created text files without consulting the instructor's current disk.
- [x] Open replay resources and restore selections through `IEditorService`.
- [x] Add replay, stop, and restart commands with native status feedback.
- Make Replay enter the learner lesson experience before applying its first event.
- Bind the lesson's native center editor to recording-backed virtual models instead of replacing the lesson surface.
- Add a recording-backed file tree and creator comparison action inside the learner experience.
- Persist checkpoints and event chunks in a portable package.
- Add arbitrary seek from a checkpoint.
- Pause before a learner edit is overwritten.
- Store learner changes as an overlay.

Acceptance criteria:

- Play, seek, restore, and resume produce deterministic file contents.
- Learner changes survive until explicitly restored or discarded.
- Replay writes are not captured as learner events.
- A short native recording can be replayed without changing its final file contents or event ordering.

Current vertical-slice note: record, stop, replay, stop replay, and restart replay now work for workspace and editor events during one product process. The starting tree captures portable file bytes under explicit safety limits; later additions, updates, and deletions are timeline events. Replay uses a separate URI scheme, does not consult files that the instructor later changes or deletes, and cannot save into the recorded workspace. The next slice moves that working replay target into the native learner lesson experience and adds its browsable virtual tree. Draft persistence, seek, learner edits during replay, and non-editor domains are intentionally not claimed yet.

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
