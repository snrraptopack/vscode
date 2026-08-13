# Session Format

## Goals

The CodeScrim package is the portable product asset. It must be deterministic, streamable, versioned, safe to validate, and independent of VS Code implementation classes.

## Container

The implemented `.scrim` v1 format is an opaque binary envelope:

```text
magic bytes: CODESCRM
header length: unsigned 32-bit big-endian integer
public routing header: bounded UTF-8 JSON
encrypted payload: gzip-compressed AES-256-GCM ciphertext
```

The public header contains only the container version, package ID, key ID, algorithms, nonce, and ciphertext length. Filenames, source code, event data, checkpoint metadata, and later media indexes remain inside authenticated ciphertext. Stable routing fields are supplied as AES-GCM additional authenticated data, so changing them invalidates the package.

Inside the encrypted payload, large and repeated values use SHA-256 content-addressed blobs. The manifest references hashes instead of duplicating workspace bytes, document text, or event chunks. Events are currently indexed in chunks of 500; later packages can add creator and automatic checkpoint indexes without changing the outer envelope.

The local authoring key is generated with Web Crypto and stored separately through VS Code's OS-backed secret storage. It is never embedded in the `.scrim` file or written into the instructor workspace. Published-course key envelopes and publisher signatures remain a later distribution layer.

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

The concrete TypeScript schema is owned by `CodeScrimPackageCodec`. Readers validate the public frame, authenticate and decrypt the payload, enforce expansion limits, validate content hashes and portable paths, then normalize the current schema into `ICodeScrimRecordingDraft` before replay sees it.

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

Editor resources are represented by workspace-root index and normalized forward-slash relative path. Text changes preserve the model event's descending range-offset order. The current in-memory draft also stores the authoritative full document text after each edit as an integrity anchor. That prevents a damaged or stale incremental range from corrupting every later replay frame. The package writer will replace this per-edit duplication with content-addressed chunks and periodic text anchors/checkpoints while retaining the same deterministic recovery guarantee.

Editor diagnostics are not part of the first draft schema. A later diagnostic track will capture normalized marker snapshots on the shared session clock so recorded squiggles and Problems state remain deterministic across machines and toolchain versions. Live diagnostics from a learner's editable sandbox will be a separate overlay and will never rewrite the captured instructor track.

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
