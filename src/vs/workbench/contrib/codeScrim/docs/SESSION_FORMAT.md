# Session Format

## Goals

The CodeScrim package is the portable product asset. It must be deterministic, streamable, versioned, safe to validate, and independent of VS Code implementation classes.

## Container

The planned `.scrim` v2 format is a ZIP-compatible container:

```text
lesson.scrim
├── manifest.json
├── checkpoints/
│   ├── 000000.json
│   └── 000001.json
├── events/
│   ├── 000000.ndjson
│   └── 000001.ndjson
├── blobs/
│   └── <sha256>
├── media/
│   ├── narration.opus
│   └── transcript.json
└── indexes/
    └── timeline.json
```

Large payloads use content-addressed blobs. Manifest and index entries reference hashes rather than duplicating file contents.

## Manifest

Required conceptual fields:

- format identifier and semantic schema version;
- session ID, title, description, author, and creation time;
- required product capabilities;
- duration and clock timebase;
- workspace roots and platform expectations;
- checkpoint and event-chunk indexes;
- media tracks;
- chapters, exercises, and assistance policy;
- integrity hashes and optional signature metadata.

The concrete TypeScript schema will be added with the package service. This document deliberately avoids freezing field spelling before parser and migration tests exist.

## Time model

- Internal timestamps are integer microseconds from the monotonic session start.
- Wall-clock timestamps are metadata only.
- All adapters use the recorder's clock; adapters do not call `Date.now()` independently for ordering.
- Events with the same timestamp retain a recorded sequence number.
- Media alignment records its start offset against the same timebase.

## Event envelope

Every event contains:

- stable event ID;
- schema version;
- timestamp and sequence number;
- domain;
- event kind;
- payload;
- optional causation ID for related activity;
- optional privacy classification.

Domains initially include:

- workspace;
- editor;
- terminal;
- debug;
- browser;
- narration;
- lesson;
- learner.

Domain payloads are discriminated unions. Arbitrary `unknown` payloads are accepted only at the package-validation boundary and normalized before entering the replay engine.

The first editor schema uses these version-1 event kinds:

- `editor.activeResourceChanged`;
- `editor.documentChanged`;
- `editor.selectionChanged`;
- `editor.documentSaved`.

The first workspace schema uses `workspace.entriesChanged`. Its payload atomically removes zero or more portable workspace resources and introduces zero or more directory/file entries. File entries carry base64 bytes in the in-memory draft; the package writer will move those bytes into content-addressed blobs.

Editor resources are represented by workspace-root index and normalized forward-slash relative path. Text changes preserve the model event's descending range-offset order. This initial draft schema stays in memory until the checkpoint and package writer can persist it atomically.

The in-memory recording draft includes a bounded snapshot of the starting workspace plus an initial document checkpoint for every workspace model already observed when recording begins. Workspace entries preserve directories and file bytes; document checkpoints additionally preserve unsaved text, language ID, version ID, and EOL sequence. Capture is first-write-wins: later edits never mutate the checkpoint used to restart replay.

The current safety policy captures at most 5,000 entries, 2 MiB per file, and 64 MiB of file bytes per snapshot operation. Symbolic links and `.git`, `.hg`, `.svn`, and `node_modules` directory trees are skipped, and the skipped count is visible when recording starts. These are vertical-slice limits, not the final package policy. The persisted package will use content-addressed blobs, configurable inclusion rules, and validation before materialization.

## Checkpoints

A checkpoint contains enough state to seek without replaying from time zero:

- content-addressed workspace tree;
- open editors, active editor, selections, and view state;
- terminal presentation snapshots;
- breakpoints and debug presentation state;
- browser URLs, context identifier, storage snapshot references, viewport, and selected DevTools state;
- active chapter and exercise state.

Checkpoints are created at creator markers and automatically according to time and event-volume thresholds.

## Learner branches

Learner changes are never appended to the instructor event stream. A branch records:

- parent session and checkpoint;
- learner file overlay;
- learner terminal and browser actions when explicitly saved;
- notes and bookmarks;
- comparison metadata;
- resume position.

## Validation and safety

Before materialization, the package service validates:

- container and manifest size limits;
- supported versions and required capabilities;
- relative normalized paths;
- file count, single-file size, total expanded size, and compression ratio;
- event count, event size, ordering, and schema;
- referenced blob existence and hashes;
- URL protocols and permission policy;
- signature when protected content requires one.

Opening a lesson never automatically executes terminal commands, tasks, debug configurations, workspace scripts, or downloaded binaries. Executable actions require an explicit trust and learner interaction model.

Passive replay and learner execution are separate capabilities. A replay package describes state and recorded presentation; it is not itself a sandbox. When secure execution is implemented, the learner's explicit run action will materialize a writable overlay into an environment whose actual isolation guarantees are declared by the host.

## Compatibility

- Readers reject unsupported major versions.
- Readers migrate older minor versions into the current in-memory model.
- Writers emit only the current version.
- Host-specific data belongs in namespaced optional capability blocks.
- The v1 prototype JSON format will eventually have a one-way importer; it does not define the v2 architecture.
