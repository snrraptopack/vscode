# Experimental Synchronized Video Track

## Status and boundary

This is an experiment, not an approved replacement for CodeScrim's event replay.
Implementation belongs on a dedicated experiment branch and must be evaluated
before changing the production session format or product decisions.

The experiment starts with **WebM**. MP4 packaging/transcoding is a later
compatibility phase after the interaction and synchronization model is proven.

## Product behavior under evaluation

The instructor records the actual screen while CodeScrim records its structured
editor, file, terminal, browser, narration, and checkpoint tracks. The learner
normally watches the screen recording, so the exact instructor presentation is
preserved even when a native surface is difficult to reconstruct.

There is no visible “Try” button and no separate try mode. An invisible overlay
sits above the video presentation and detects a learner double-click. A
double-click at media time `t` performs one transition:

1. Pause the video at `t`.
2. Convert `t` to the CodeScrim session clock.
3. Restore the nearest checkpoint and replay structured events up to `t`.
4. Replace the video presentation with the synchronized interactive CodeScrim
   editor/workbench state.

The transition should feel like the recorded screen became editable, not like
the learner opened another application. The overlay must remain visually absent.
Normal single-click playback controls must remain usable, either through separate
controls outside the overlay or carefully specified event forwarding.

## Proposed WebM vertical slice

- Capture one WebM screen track with a monotonic start anchor.
- Prefer VP9 video and Opus audio where the Electron runtime supports them;
  record the actual selected codecs in metadata rather than assuming support.
- Continue recording the existing structured CodeScrim tracks and checkpoints.
- Store video as a content-addressed package blob with an optional media-track
  manifest; do not make old packages require video.
- Maintain a synchronization map between WebM media time and the CodeScrim
  microsecond timeline, including pause/resume discontinuities.
- Add a video presentation surface and an invisible double-click overlay.
- On transition, perform an authoritative seek and show the interactive surface
  only after the target state is ready, avoiding a half-video/half-editor frame.
- Preserve the timestamp so a later return-to-video experiment can resume at the
  same logical point.

## Questions that must be answered before production work

- Does screen capture include narration audio, or is narration kept as a separate
  track and mixed only during playback/export?
- Is the captured region the full application window, a workbench region, or a
  selectable display/window source?
- How are display scaling, resizing, and multiple monitors represented?
- What is the acceptable transition latency from double-click to interactive
  state, and should a brief neutral loading veil be allowed?
- How should the learner return to video without losing interactive changes?
- Should browser/terminal processes be restored live, represented passively, or
  remain visible as the paused video when no safe interactive state exists?
- What package-size ceiling, recording duration, and quality presets are viable?
- Which consent, privacy, secret-redaction, and capture-indicator requirements
  apply to full-screen recording?

## Experiment success criteria

- Video and structured replay remain synchronized through recording pauses,
  seeks, and a lesson of representative length.
- Double-click consistently enters the correct file, cursor, terminal/browser
  context, and timestamp.
- The video-first path preserves instructor visual fidelity without weakening the
  learner workspace sandbox.
- Capture and encoding do not make authoring unresponsive.
- The package remains recoverable if video finalization fails; structured Scrim
  data is never discarded because the experimental media track failed.
- A measured result supports an explicit keep, revise, or reject decision before
  MP4 work begins.

## Deliberately deferred

- MP4 encoding, transcoding, or export.
- Shareable standalone video export.
- Cloud streaming and adaptive bitrate delivery.
- Production package-version changes.
- Replacing the existing interactive replay engine.

