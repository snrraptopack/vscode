# Architecture Decisions

This is an append-only decision log. Superseded decisions remain recorded and point to the decision that replaced them.

## CS-001: Native workbench product

Status: accepted.

CodeScrim is implemented as native VS Code workbench and platform code. It does not use an extension, bundled extension, webview player, or sidebar player.

Reason: the product must coordinate real editor, terminal, debug, browser, layout, storage, and lifecycle state beyond the stable extension API.

## CS-002: Editor-area course and lesson surfaces

Status: accepted.

Course discovery and lesson controls use native editor inputs and panes. The layout controller opens real code and browser editors alongside the lesson surface.

Reason: the learning interface should feel like the primary product, while preserving standard workbench editor behavior.

## CS-003: The code is the playback

Status: accepted.

Recorded code changes play through real Monaco text models and editors. Code is not rendered into a video or a simulated editor inside the lesson surface.

## CS-004: Existing native integrated browser

Status: accepted.

CodeScrim uses VS Code's `WebContentsView` browser editor, browser model, DevTools, and CDP service. The external browser-extension/rrweb prototype architecture is not carried forward.

rrweb may later be evaluated as an optional visual fallback only.

## CS-005: Immutable instructor state and learner overlay

Status: accepted.

Instructor checkpoints and events are immutable. Learner experiments are recorded separately and are never silently discarded on resume.

## CS-006: Portable v2 package before legacy compatibility

Status: accepted.

The production format uses a chunked, checkpointed, content-addressed container. The prototype v1 JSON format will be imported later and does not constrain the native runtime.

## CS-007: Thin fork and explicit upstream hooks

Status: accepted.

CodeScrim code stays isolated. Every modification to an upstream-owned file is documented, narrow, and independently testable.

## CS-008: One monotonic playback authority

Status: accepted.

`ICodeScrimSessionService` owns playback state. Its host-neutral state machine receives monotonic timestamps from the browser implementation, and UI surfaces invoke direct operations rather than maintaining their own timers.

Reason: editor, terminal, browser, debugger, and narration events must agree on ordering and seek position, while the state transition logic must remain deterministic in tests.

## CS-009: Focused lesson layout lease

Status: accepted.

An active lesson temporarily owns the editor area and hides unrelated workbench chrome. Its left and right lesson rails collapse independently from controls on the rails themselves. A collapsed rail leaves exactly one restore control on the same edge of the unframed center canvas.

Global split and layout actions are hidden for the duration of the lesson, and normal workbench parts cannot be reopened while the layout lease is active. Closing the lesson restores the user's prior workbench visibility and editor options.

Reason: global workbench layout actions can split or squeeze the coordinated lesson workspace, while grouped or displaced rail controls make recovery ambiguous. A scoped lease preserves a focused bootcamp interface without permanently changing user settings.

## CS-010: Recording uses the normal workbench

Status: accepted.

Creator recording does not open a simulated editor or a dedicated recording page. Native adapters observe the real workbench while the creator edits normally. Authoring actions live in a CodeScrim-owned floating dock opened from a circular bottom-left launcher; the dock is not an Activity Bar container and does not alter editor layout. The status bar is quiet while idle and exposes only active capture state, pause/resume, and stop while recording.

The first adapter records only resources inside an open workspace and serializes them as a workspace-root index plus a relative path. External absolute paths are not added to a draft.

Reason: authoring should retain standard VS Code behavior, and portable session assets must not encode machine-specific paths.

## CS-011: Editor replay is isolated from workspace files

Status: accepted.

The first replay implementation creates real Monaco models from the immutable recording checkpoint. The private instructor model uses a CodeScrim-owned URI, while the editable learner model uses an isolated `untitled:` URI so it participates in VS Code's normal language-feature pipeline without representing or writing a host file. Recorded editor events target the instructor model and are projected into the learner model when the learner has not taken control. Recorded save events are passive timeline markers rather than file writes.

Reason: the vertical slice must prove native, deterministic code playback without risking the creator's source files. The learner receives a real editable editor with language-aware features, while instructor state remains immutable and execution stays behind an explicit sandbox policy.

## CS-012: Recordings own their workspace history

Status: accepted.

A recording starts from an immutable, portable workspace checkpoint and records later file additions, updates, moves-as-remove-plus-create, and deletions. Replay materializes from recorded bytes and events; it never falls back to the instructor's current disk when a recorded file is missing.

Lesson parts can reference a prior published checkpoint as their base, while each package remains explicit about the blobs required to reconstruct its starting state.

Reason: an instructor may deliberately delete or restructure files, publish a lesson later, or continue a concept in another lesson. Those actions cannot make earlier teaching state disappear.

## CS-013: Passive replay and learner execution are separate

Status: accepted.

Instructor playback reconstructs recorded state and presentation only. It never reruns terminal commands, tasks, debug launches, project scripts, or binaries. A learner may later choose to execute code in a writable learner overlay, but only through an explicit run action and a host-declared sandbox policy.

Reason: deterministic teaching playback should be safe to open. Execution has materially different trust, isolation, resource, network, secret, and cleanup requirements and must not be implied by the word “replay.”

## CS-014: Replay always enters the learner experience

Status: accepted.

Previewing or replaying an instructor recording opens the same native lesson experience used by learners. Recorded files appear through a recording-backed virtual workspace in that experience; CodeScrim never creates a `.replay` or `.scrim` directory inside the instructor's source workspace.

The creator can inspect the replay tree and timeline, compare a replay file with the current source file, and validate the course navigation, lesson context, transport, and workbench behavior exactly as a learner will receive them. Starting a new recording first closes the transient preview state. Closing the window disposes transient virtual models, while explicitly saved recording packages remain in CodeScrim-owned storage outside the project.

Reason: creator preview must exercise the real learner path without polluting Git, file watchers, imports, search results, or a later recording with temporary files.

## CS-015: Packages are opaque authenticated binary envelopes

Status: accepted.

The `.scrim` container exposes only a bounded routing header. The session manifest, source files, checkpoints, events, and media indexes are compressed and encrypted with AES-256-GCM; repeated content is addressed by SHA-256 inside the encrypted payload. The local authoring key is held separately by OS-backed secret storage, and package writes commit through an atomic sibling-file move.

Reason: renaming JSON or placing it in ZIP would discourage only casual inspection and would expose source filenames and metadata. Authenticated encryption makes ordinary extraction meaningless and detects tampering before untrusted data enters replay. Separating the key from the package also leaves a clean boundary for future account entitlements, course key envelopes, key rotation, and publisher signatures.
