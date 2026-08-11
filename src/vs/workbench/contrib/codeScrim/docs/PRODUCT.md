# Product Contract

## Product statement

CodeScrim is a development environment built for interactive technical learning. The learner enters a real development session instead of watching a separate video and copying its contents into an editor.

The session itself is the lesson. Code changes, project state, terminal activity, browser behavior, debugging actions, narration, and timeline position advance together.

## Primary experience

### Creator

1. Open a real project.
2. Start a native CodeScrim recording.
3. Work normally in the editor, terminal, browser, and debugger while narrating.
4. Stop recording.
5. Review the captured session.
6. Add chapters, checkpoints, exercises, and explanations.
7. Publish or share the session.

### Learner

1. Open a course or lesson in the CodeScrim course editor.
2. Start playback.
3. Watch the instructor's actual development state unfold through native IDE surfaces.
4. Pause at any time.
5. Inspect, edit, run, browse, and debug the project.
6. Ask for help using the exact lesson and learner context.
7. Restore the instructor state or preserve the experiment as a branch.
8. Continue from the same timeline position.

## Surface requirements

- Course discovery, progress, and lesson navigation appear in a native editor-area experience.
- Lesson playback controls and timeline appear in the editor area, never as a sidebar-only player.
- Code playback uses normal Monaco text editors.
- Browser playback uses the native integrated browser based on Electron `WebContentsView`.
- Terminal playback and experimentation use the native terminal.
- Debugging uses the native debug service and views.
- Familiar VS Code extensions, themes, settings, keybindings, source control, navigation, and language tooling continue to work.

## Playback requirements

- Play, pause, resume, seek, restart, and chapter navigation are deterministic.
- Seeking restores the complete instructor state at the selected time.
- Playback does not overwrite learner changes without an explicit restore decision.
- User interaction during playback pauses the instructor clock before the learner's action is lost.
- Long lessons use indexed checkpoints and do not replay the entire event stream from time zero on every seek.
- A malformed event can be isolated and reported without permanently freezing playback.

## Safe experimentation requirements

- Instructor content remains immutable.
- Learner changes are stored separately from instructor checkpoints.
- Restore discards only the selected learner overlay.
- Learners can preserve an experiment, compare it with instructor state, and return to the lesson path.
- Session playback never silently modifies the creator's source workspace.
- Creator preview always opens the learner lesson experience and never creates temporary replay folders inside the source workspace.
- Instructor playback is passive state reconstruction and never executes recorded commands, tasks, debug launches, project scripts, or binaries.
- Running code is an explicit learner action against a separate learner workspace governed by trust, resource, network, process, and lifetime limits.

## Learning requirements

- Chapters identify meaningful conceptual sections, not merely timestamps.
- Checkpoints represent restorable development states.
- Exercises can pause guidance and define validation criteria.
- AI assistance receives lesson position, instructor state, learner state, terminal output, browser state, diagnostics, debug state, and recent learner actions.
- Assistance levels can restrict the AI to explanation, hints, guidance, suggested changes, or full solutions.

## Product principles

1. Interactivity over video.
2. Real tools over simulations.
3. Learning over automatic completion.
4. Safe experimentation.
5. Natural creation.
6. Portable sessions.
7. Debugging is part of the lesson.
8. Native integration without unnecessary upstream divergence.

## Explicit non-goals for the first release

- Live multi-user collaboration.
- Strong DRM or impossible client-side extraction.
- Support for every IDE host.
- Full cloud marketplace and creator analytics.
- Pixel-perfect reproduction of every transient animation.
- Automatically executing recorded terminal commands during passive playback.
- Treating the instructor snapshot as an execution sandbox.

## First-release success criteria

- A creator can record a project session containing code, files, terminal activity, browser navigation, debugging events, chapters, and narration.
- A learner can seek to a checkpoint and receive the same instructor project state.
- A learner can pause, modify the project, run it, inspect the browser, and debug it.
- A learner can restore or preserve their experiment and resume playback.
- A single portable session package can be validated before any project files are materialized.
- Updating from a normal upstream VS Code change does not require redesigning CodeScrim.
