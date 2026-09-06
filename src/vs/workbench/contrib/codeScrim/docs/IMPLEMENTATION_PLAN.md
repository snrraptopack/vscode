# Implementation Plan

Manual defects that must be reproduced before more UI work are tracked in
[KNOWN_ISSUES.md](KNOWN_ISSUES.md).

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
- [x] Add a native editor recording slice for model edits, active-file changes, selections, scrolling, and saves.
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
- [x] Connect file-backed replay models to native language providers so instructor playback and learner edits receive live inference, hover information, completions, and diagnostics.
- [x] Enter learner edit mode immediately on editing and pause before the instructor timeline advances.
- [x] Expose learner models to native language features without materializing them in the host workspace.
- [x] Project checkpoints into a disposable CodeScrim-owned learner workspace with file-backed model URIs and crash recovery.
- [x] Let learners create files and folders from the Files tab and preserve those entries as learner experiment state.
- [x] Replace the learner's flat file list with a native workbench tree supporting file icons, folder expansion, contextual creation, and learner-scoped drag/drop that cannot open or split the editor grid.
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

Current vertical-slice note: record, stop, recovery across restart, encrypted save/open, learner preview, play, pause, checkpoint-indexed seek, restart, manual file inspection, learner-owned file/folder creation, deterministic resume, and quiet learner experimentation now work for workspace, editor, and passive terminal events. The checkpoint index captures portable file bytes, unsaved document text, active files, selections, and accumulated terminal presentation under explicit safety limits. Replay owns an immutable instructor model plus a separately editable learner model for each materialized file. File-backed learner models participate in native language tooling throughout instructor playback and learner experimentation. Recorded ANSI output is rendered in VS Code's native integrated Terminal panel through a read-only replay PTY; no command is executed during replay. Editing or creating a workspace entry pauses the instructor clock without adding another banner. Continue captures changed files and created entries in an in-memory learner checkpoint, silently restores the exact instructor frame, and resumes from that timestamp. Each captured experiment appears as a marker on the playback timeline; its compact inspector provides native diff review plus Restore, Keep, and Delete actions. Published key distribution/signatures and remaining domains are intentionally not claimed yet.

## Milestone 3: Native browser integration

- [x] Host the instructor's real Integrated Browser model in a resizable native auxiliary window without creating an editor tab.
- [x] Capture visible instructor DOM states and navigation metadata into encrypted, content-addressed packages.
- [x] Replay passive instructor browser state in a separate resizable learner auxiliary window without loading recorded URLs or executing page content.
- [x] Record root viewport scrolling as a lightweight animation-frame-paced track, independent of DOM snapshots.
- [x] Keep target-blank/popup pages in the standalone instructor browser and record instructor tab activation.
- [x] Record browser tab open/close/navigation metadata and editor/browser focus as independent timeline streams.
- [x] Capture committed CodeScrim-owned background pages so external target-blank navigation is available before activation.
- [x] Capture form values, focus, hover, active state, nested-element scroll, and safe canvas/video paint state with coalesced DOM checkpoints.
- [x] Let the learner address/search field seek to URLs and titles contained in the recording without issuing a network request.
- Record structured viewport size, text selection ranges, console, network, download, permission, dialog, and richer pointer metadata through browser model/CDP services.
- Keep passive recorded browser presentation separate from a learner's live browser: opening or seeking a recording must not start the instructor's server or issue recorded network requests.
- [x] Keep the lesson editor canvas code-only and provide a title-bar action to reopen the passive learner browser window.
- Add an explicitly launched live learner browser after sandboxed execution and port discovery exist.
- Connect My Preview to explicitly started learner execution, with detected ports and provider capabilities determining how local addresses are exposed.
- Integrate native DevTools.

Browser capture coverage is intentionally split into explicit tracks so adding
fidelity does not turn DOM serialization into one unbounded event stream:

- **Document lifecycle:** tab open/close/activate, committed navigation,
  redirects, title, loading start/finish, same-document history changes, and
  bounded post-load hydration checkpoints.
- **Teaching focus:** editor/browser focus and the active recorded browser tab.
- **Interactive DOM state:** DOM mutations, forms, focus, hover/pressed state,
  details elements, nested scroll offsets, root scrolling, selection, and
  viewport geometry.
- **Browser chrome:** address/title state, popup and target-blank relationships,
  dialogs, permissions, downloads, and failure/loading presentation.
- **Runtime evidence:** console entries and request/response metadata. Passive
  replay records this evidence but never repeats a request or executes a script.
- **Visual fallbacks:** canvas, WebGL, video frames, closed shadow roots, and
  cross-origin frame regions require bounded visual state when safe DOM capture
  is impossible. This is a fallback for opaque regions, not a whole-page video.
- **Packaged resources:** CSS, fonts, images, and other presentation assets need
  a content-addressed resource track when they cannot be read through the page's
  same-origin DOM. Replay must not depend on the learner being online.

Current implementation covers the first two tracks, root/nested scrolling, and
the listed interactive DOM state. It captures background-tab mutations and
several settled states after loading so hydrated external pages do not freeze at
their first paint. The remaining browser-chrome, runtime-evidence, opaque-region,
and packaged-resource work stays explicit above rather than being implied by a
generic “browser snapshot” claim.

Acceptance criteria:

- A local development server remains live while the lesson is paused.
- Cookies, storage, authentication, and permissions are isolated according to lesson policy.
- Closing a lesson cleans up its browser context and restores the user's layout.

## Milestone 4: Terminal and debugging

- [x] Capture terminal lifecycle, input, raw output, working directories, dimensions, title, and exit state.
- [x] Replay and seek recorded terminal presentation through the native integrated Terminal panel and a read-only replay PTY without executing commands.
- [x] Add shell-integration command boundaries, deterministic multi-terminal switching, and progressively disclosed terminal activity markers.
- Preserve the learner editor's recorded caret and active-line presentation when the native terminal panel opens or terminal replay begins. The current panel transition can make the editor appear to jump back to the start of the line.
- [x] Provide a real learner terminal rooted in the disposable learner workspace, created only by explicit learner action and kept separate from read-only instructor terminal replay.
- Capture debug lifecycle, breakpoints, focus, stack, variables, REPL, and relevant errors.
- Present recorded instructor debug state as deterministic, read-only replay without launching the original debug adapter or program.
- Keep learner debugging as a separate live session against learner files and an explicitly prepared execution environment.
- Define runnable checkpoints for exercises that require live debug state.

Acceptance criteria:

- Terminal replay is timestamp-synchronized and seekable.
- Learner commands are never confused with instructor output.
- Debug events appear on the timeline and checkpoint restoration is explicit about what can be reconstructed.

## Milestone 5: Recording and narration

- [x] Add native recording orchestration and one monotonic clock.
- [x] Add an initial cross-platform microphone capture and synchronized replay path.
- [x] Write chunked events and periodic checkpoints while recording.
- [x] Recover the latest stopped draft after a restart.
- Persist active audio chunks during recording so an interrupted narration can also be recovered.
- Add microphone selection, input-level feedback, mute, and narration-volume controls.
- Add chapter and checkpoint markers during recording.

Acceptance criteria:

- A ten-minute mixed editor/terminal/browser/debug recording remains responsive.
- Audio and IDE events remain synchronized after seeks.
- Interrupted recordings can be recovered or safely discarded.

## Milestone 6: Package, session editing, and exercises

- [x] Implement the current pre-release v6 package reader/writer, encryption, and integrity validation.
- Add trimming, chapter editing, notes, exercises, and checkpoint editing.
- Support removing unwanted timeline ranges, splitting a recording into lessons, replacing narration, and saving named session revisions without requiring a complete re-record.
- Regenerate affected timeline positions and indexed checkpoints after structural edits, and reject edits whose file/event dependencies cannot produce a deterministic session.
- Add exercise validation hooks without coupling the package to a single language.
- Keep obsolete pre-release package schemas unsupported; add migration only after a public compatibility promise exists.

## Milestone 7: Secure learner execution

- [x] Materialize a learner workspace from an instructor checkpoint without mutating instructor state.
- [x] Provide an explicitly opened local learner shell as the pre-sandbox execution bridge, clearly documented as ordinary host execution.
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
- Enforce the recording-start, memory, browser-capture, packaging, and seek budgets in [PERFORMANCE.md](PERFORMANCE.md) against small projects and bounded monorepo fixtures.
- Stream live events and media to a temporary content-addressed journal so recording memory is bounded by buffers rather than lesson duration.
- Investigate the documented Windows development-build crash when Developer Tools opens during recording; do not attribute it without a symbolicated native dump.
- Run layer validation when a new cross-layer import is introduced.
- Avoid broad builds as a ritual; use the smallest validation that covers each change.
