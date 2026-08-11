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
