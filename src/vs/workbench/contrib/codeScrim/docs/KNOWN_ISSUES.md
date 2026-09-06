# CodeScrim Known Issues

This file records defects observed during manual product testing. An item remains
open until the exact user flow has been reproduced and verified in a launched
development build; a source change or unit test alone is not sufficient to close
it.

## Recording keyboard commands

**Status:** Fix implemented; awaiting manual regression verification.

While recording, normal editor commands can stop reaching the active editor.
The problem was first observed with `Ctrl+S`, but `Ctrl+Z` is also affected. This
means the defect is broader than saving and must be investigated as a focus or
keybinding-routing regression rather than worked around one command at a time.

Acceptance criteria:

- The normal workbench implementations of save, undo, redo, copy, paste, find,
  and other editor keybindings continue to work during recording.
- Opening, focusing, or using the author browser does not leave keyboard focus in
  an auxiliary document after the instructor returns to the editor.
- CodeScrim recording observes editor operations without intercepting or replacing
  their commands.
- Automated coverage exercises at least save, undo, and redo through the actual
  keybinding dispatch path while recording is active.

Implementation note: CodeScrim no longer registers a higher-priority `Ctrl+S`
command. Recording-control actions restore focus to the active editor, leaving
save, undo, redo, and other shortcuts on the normal workbench dispatch path.

## Teaching-surface activity indicators

**Status:** Fix implemented; awaiting visual verification.

The learner needs a visible cue when the instructor is currently using the
browser or terminal, especially when the learner has hidden that surface. The
current context-key/toggled-action work did not produce a visible glow in manual
testing and must not be treated as delivered.

Acceptance criteria:

- The browser title-bar action has an unmistakable, theme-safe animated or
  persistent glow while browser activity is the latest instructor activity.
- The terminal action has the equivalent cue while terminal activity is latest.
- The cue remains visible when the corresponding learner surface is hidden.
- Editor activity clears both cues, and reduced-motion mode keeps a static cue.
- The behavior is visually verified in light, dark, and high-contrast themes.

Implementation note: replay now mirrors the teaching surface to explicit
workbench DOM state as well as context keys, so title-bar glow styling does not
depend on scoped menu context propagation. Reduced-motion mode remains static.

## Recorded browser tab activation

**Status:** Fix implemented; awaiting manual regression verification.

External navigation can create the recorded tab and the learner can see tab
metadata, but replay does not reliably show the instructor switching between
tabs. Rendering a list of tabs is not enough: activation and its corresponding
page state must follow the instructor timeline.

Acceptance criteria:

- Opening a target-blank popup or navigating to a different external site records
  a distinct tab without replacing the source tab.
- Every instructor tab activation produces an ordered timeline event.
- At that event, learner playback selects the same tab and displays that tab's
  latest DOM state and root/nested scroll positions.
- Learner-selected tabs may be inspected without corrupting the instructor
  timeline; the next instructor activation returns playback to the recorded tab.
- Seeking and restarting reconstruct the same open, closed, and active tab set.

Implementation note: ordered `activated` events are authoritative over delayed
BrowserView visibility events. Activation timestamps also dismiss a learner's
temporary tab selection on the instructor's next activation.

## Replay continuity

**Status:** Fix implemented; awaiting manual regression verification.

Playback has previously stopped at a repeatable interaction and only continued
after manually dragging the timeline and pressing Continue. Recorded save I/O
was one possible blocking path, but the full event application loop still needs
an end-to-end stall test covering editor, terminal, and browser events.

Acceptance criteria:

- A mixed lesson plays from start to end without manual scrubbing.
- Restarting the same lesson does not stop at the previous failure timestamp.
- Slow learner-projection I/O cannot block the media clock indefinitely.
- A stalled or failed event is diagnosed visibly instead of leaving a playing UI
  frozen at one position.

Implementation note: recorded workspace changes update the authoritative
in-memory replay immediately. Disk projection remains serialized but no longer
blocks the live playback tick.

## External-page fidelity and stability

**Status:** Fix implemented; awaiting manual regression verification.

External pages have shown incorrect large blank/black regions and browser-heavy
recordings have made the development window unresponsive. Whole-page screenshot
replay is explicitly rejected because it loses fluid scrolling and real DOM
interaction. External and local pages must use the same passive DOM-state model,
with bounded capture work.

Acceptance criteria:

- External pages replay as passive DOM, not a full-page image.
- Recorded root and nested scrolling remain fluid.
- Responsive layout matches the recorded viewport closely enough to avoid false
  mobile/expanded navigation regions.
- Mutation-heavy pages cannot queue unbounded snapshots or freeze the workbench.
- Unsupported cross-origin, canvas, media, or closed-shadow content is identified
  as a bounded fallback region rather than silently distorting the whole page.

Implementation note: new snapshots retain the instructor viewport for responsive
layout fidelity. Capture now has a timeout, per-snapshot limit, total-HTML budget,
and event-count ceiling; an abusive page is disabled for further passive capture
without stopping the interactive recording.
