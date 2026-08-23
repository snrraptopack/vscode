# Performance and Scale

CodeScrim must remain responsive in ordinary projects and large monorepos. Development-build startup time is tracked separately from CodeScrim runtime cost: a source-built Code OSS window also compiles development CSS, initializes built-in extensions, and starts development-only diagnostics that are absent or reduced in a packaged product.

## Current risks

### Recording startup

Starting a recording currently enumerates the included workspace tree and captures the initial bytes needed for deterministic restore. The snapshot is bounded to 5,000 entries, 2 MiB per file, and 64 MiB total, and skips symbolic links, VCS metadata, and `node_modules`, but the walk and reads still happen before a recording is fully ready.

Observed on 2026-08-20: starting a recording in a project with 1,347 included entries made the cost visible in Creator Studio. This is a valid stress case, not an acceptable long-term startup experience.

Required direction:

- measure enumeration, read, hashing, and checkpoint assembly independently;
- reuse unchanged file identities from the previous recovery draft when metadata proves they are unchanged;
- move file reads and hashing off the renderer-critical path;
- allow recording to become active after a minimal editor checkpoint while the bounded workspace baseline completes in the background;
- surface skipped or failed entries without freezing the workbench;
- keep CodeScrim dormant until the user records, imports, or replays a session.

### In-memory recording growth

The pre-release draft keeps authoritative event data, indexed checkpoints, narration chunks, and browser frames available for immediate replay and recovery. Content-addressing currently reduces the exported package, but it does not by itself remove all duplication from the live draft.

Required direction:

- append events and media to a CodeScrim-owned temporary blob store during capture;
- keep only indexes, recent working state, and bounded write buffers in renderer memory;
- content-address workspace bytes, checkpoint documents, narration, and browser frames before Save As;
- apply backpressure instead of creating an unbounded queue when storage or capture is slower than the instructor;
- recover an interrupted active recording from the journal, not only the latest stopped draft.

### Browser visual capture

The first browser slice requests a JPEG screenshot of each visible instructor Integrated Browser at most every 750 ms and drops byte-identical consecutive frames. Static pages deduplicate well. Animations, video, cursor blinking, timers, and frequently changing development pages can produce a new frame every interval, making raw base64 strings expensive in both memory and package size.

Required direction:

- stream frames directly to the temporary content-addressed store;
- retain only frame references in the recording draft;
- make capture adaptive to visual change, visibility, recording pressure, and a maximum frame rate;
- permit dropped intermediate frames while preserving navigation and semantic milestones;
- collect encoded bytes, deduplication ratio, capture latency, dropped frames, and queue depth;
- investigate delta/video encoding only after measuring representative coding lessons; exact seekability remains mandatory.

### Checkpoints, seek, and packaging

Indexed checkpoints already prevent a long seek from replaying every event from time zero. The remaining costs are constructing live checkpoints, restoring large trees, hashing media, compressing, encrypting, and writing a package.

Current mitigation: checkpoint restoration creates directory structure first and then writes independent files with bounded concurrency. Replay also invalidates a retiring learner-workspace root before deletion, so a file-tree refresh cannot resolve a UUID that reset has already removed. This improves the current path without replacing the longer-term content-addressed projection design below.

Required direction:

- checkpoint by reference to content-addressed state instead of duplicating unchanged bytes;
- build checkpoints incrementally from the authoritative recorder state;
- perform package compression, hashing, and encryption outside the renderer-critical path;
- report progress and support cancellation for large Save As operations;
- benchmark cold seek, warm seek, restart, and package open independently.

## Performance budgets

These are engineering targets, not current guarantees:

| Operation | Target |
| --- | --- |
| CodeScrim idle contribution | No workspace enumeration, browser screenshot, microphone access, or replay polling |
| Start recording, up to 2,000 included entries | Interactive recording state within 500 ms at p95; remaining baseline work may continue asynchronously |
| Start recording, bounded large workspace | Interactive recording state within 2 s at p95 with progress and cancellation |
| Steady editor/terminal recording | No task longer than 50 ms on the renderer-critical path |
| Browser capture | At most one screenshot in flight per page; bounded pending writes and adaptive frame dropping |
| Timeline seek | Restore nearest checkpoint and become interactive within 250 ms at p95 for a ten-minute lesson |
| Memory | Growth must be bounded by configured buffers rather than lesson duration |
| Lesson playback | No recorded command, URL, script, or page content executes as a performance shortcut |

Benchmarks must report development and packaged builds separately. A development-build regression can still matter, but it must not be presented as packaged-product startup cost.

## Benchmark matrix

Measure at least:

- 100, 2,000, and 5,000 included workspace entries;
- many small files versus the same total bytes in fewer large files;
- one, ten, and sixty minutes of editor and terminal activity;
- a static browser page, a normal hot-reload application, and a continuously animated page;
- recordings with browser hidden, visible, and switched between multiple pages;
- cold and warm package open, seek, restart, and Save As;
- Windows, macOS, and Linux on representative low-, mid-, and high-memory machines.

Record snapshot duration and bytes, event rate, checkpoint duration, renderer long tasks, process CPU, renderer and browser-view memory, frame capture latency, frame deduplication ratio, temporary-store growth, package encode time, and replay seek latency.

## Known development crash

On 2026-08-20, opening Developer Tools while recording in a Windows source build terminated the Code OSS development window. Crashpad wrote native dump files; the renderer log ended without a corresponding JavaScript exception. The same run also contained unrelated extension-host startup delays and missing development Copilot dependencies, so the cause is not yet attributed to CodeScrim, browser capture, or memory pressure.

Before calling this fixed:

1. reproduce with and without an active CodeScrim recording;
2. reproduce with browser capture inactive and active;
3. reproduce without remote-debugging automation attached;
4. symbolicate the Crashpad dump and identify the failed process/thread;
5. add a regression scenario to the native UI smoke test if CodeScrim owns the cause.

Do not use Developer Tools as the only profiler for this case until the crash is understood. VS Code process diagnostics, performance marks, CPU profiles, heap snapshots from a separately attached debugger, and Crashpad dump analysis remain available.
