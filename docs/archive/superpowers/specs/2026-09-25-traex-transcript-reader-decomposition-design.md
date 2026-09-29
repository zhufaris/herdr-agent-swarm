# TraeX Transcript Reader Decomposition Design

## Goal

Deepen the TraeX transcript reader without changing its public interface or any
observation and recovery behavior. `TraexTranscriptReader` remains the single
module used by coordinators. Path discovery, record decoding, bounded boundary
scanning, baseline recovery, and incremental cursor reading become private
implementation modules.

This is a behavior-preserving refactor. Domain ports, open modes, unavailable
reasons, byte offsets, cache behavior, resource limits, lifecycle reduction,
redaction, output bounding, and no-replay decisions do not change.

## Current shape and problem

`src/runtime/traex-transcript.ts` currently combines five protocols in one
735-line file:

- validate session identities and choose an opening mode;
- discover and validate transcript paths with positive, negative, shared-index,
  and in-flight caches;
- find exact turn-start and completed-turn boundaries with bounded file scans;
- recover token and lifecycle baselines by forward or reverse scanning;
- incrementally read records, handle partial and oversized lines, split adjacent
  turns, and project trusted observations.

These protocols cooperate through canonical byte offsets, but they do not need to
share one implementation body. The current layout obscures which checks establish
path trust, which calculations define replay scope, and which state belongs to one
cursor.

## Considered approaches

### A. Stable reader facade with private transcript modules (chosen)

Keep `TraexTranscriptReader` and `TraexTranscriptReaderPort` unchanged. The reader
validates requested identities, selects an opening strategy, and assembles the
existing cursor. Private modules own discovery, decoding, scanning, baseline
recovery, and cursor mechanics.

This passes the deletion test: removing the reader would force every observer to
understand path trust, scan bounds, baselines, and cursor construction.

### B. Extract path discovery only

Move caching and filesystem discovery but retain scanners, lifecycle decoding, and
the cursor in the original file. This is safe but leaves most no-replay complexity
interleaved.

### C. Publish locator and scanner interfaces to coordinators

Let observers assemble paths, offsets, baselines, and cursors. This exposes the
recovery protocol, makes the modules shallow, and risks inconsistent opening
semantics. It is rejected.

## Chosen module shape

```text
Coordinator and observer ports
             |
             v
TraexTranscriptReader                 stable public facade
             |
             +-- TranscriptLocator    discovery, validation, caches
             +-- TranscriptBoundaryScanner
             |                         exact start/completion boundaries
             +-- TranscriptBaselineReader
             |                         token and lifecycle baselines
             +-- FileTraexTranscriptCursor
             |                         incremental bounded reads and batches
             `-- TranscriptRecordCodec
                                       envelope and lifecycle decoding
```

Only `TraexTranscriptReader` is imported by production callers. Internal modules
are implementation seams and are not added to domain ports or composition.

## Module responsibilities

### `TraexTranscriptReader`

The facade retains `open`, `openActiveTurn`, `openFirstTurn`, `openAtTurn`, and
`openAfterTurn`. It validates the supplied session and turn identities, maps
internal results onto the existing unavailable reasons, selects the correct
baseline and offset, and constructs the existing cursor interface. Exceptions
remain fail-closed as `transcript_validation_failed`.

### `TranscriptLocator`

Owns the filesystem trust boundary:

- canonical sessions root and realpath containment;
- exact UUID filename and first-record session metadata validation;
- bounded directory traversal and ambiguity detection;
- positive-path LRU, negative-cache TTL, per-session discovery coalescing, and
  shared discovery-index TTL.

It returns discovery facts; it does not choose reader unavailable reasons or scan
turn contents. The exported `scanTranscriptPaths` compatibility function remains
available from `traex-transcript.ts`.

### `TranscriptRecordCodec`

Owns Zod schemas and deterministic record interpretation for envelope, session
metadata, token count, task start, task completion, and abort. It also owns event
time conversion, lifecycle reduction, final-answer redaction, and markdown
bounding. It performs no filesystem I/O. Invalid or irrelevant records remain
ignored exactly as today.

### `TranscriptBoundaryScanner`

Owns bounded byte scanning:

- reusable backward record scanning;
- exact completed-turn boundary lookup;
- exact turn-start boundary lookup;
- partial first/last records and maximum-record enforcement.

The scanner preserves canonical byte offsets, newline behavior, UTF-8 record
boundaries, and exact `turnId + startedAt` fencing. It does not construct cursors.

### `TranscriptBaselineReader`

Owns forward tail and backward active-turn baseline recovery. It computes the
token baseline, latest lifecycle, and optional active-turn replay offset using the
same scan windows and record codec. Active work is replayed only from the exact
verified start record. Completed or aborted work produces no replay offset.

### `FileTraexTranscriptCursor`

Owns per-open mutable read state: current byte offset, pending complete records,
oversized-record skipping, lifecycle state, and projection. It preserves the
current batch split at adjacent start/completion/abort boundaries, bounded reads,
truncation failure, and `TraexTranscriptObservation` shape.

## Invariants and error behavior

- Session and turn IDs remain strict UUIDs.
- A path must remain inside the canonical sessions root and contain matching
  `session_meta` before it is cached or opened.
- `openAfterTurn` distinguishes `turn_boundary_not_found` from
  `turn_boundary_incomplete`; `openAtTurn` reports only the existing result set.
- Recovery scans remain bounded to 64 MiB with 1 MiB chunks and 4 MiB maximum
  records. Ordinary cursor reads retain their configured byte limit.
- Partial UTF-8 data is not projected until a complete newline-delimited record
  exists. Oversized cursor records remain skipped without exposing fragments.
- Adjacent turns remain separate observations. A completion or abort can settle
  only the matching active turn.
- Redaction and rendered-output limits are applied exactly where they are today.
- Positive LRU size, negative TTL, discovery index TTL, ambiguity, exhausted-scan,
  and concurrent discovery behavior remain unchanged.
- No persistence, queue, retry, or Agent submission behavior is introduced.

## Testing and architecture enforcement

Existing `traex-transcript.test.ts` and `traex-transcript-cache.test.ts` remain the
primary interface tests. Focused pure tests may be added for record interpretation
only where they improve branch clarity without duplicating interface coverage.
Architecture tests enforce that production code outside the facade/internal
directory cannot import transcript internals.

Completion requires the focused transcript suites, full Vitest suite, typecheck,
build, architecture check, documentation audit, public audit, and
`git diff --check`.

## Non-goals

- No changes to transcript format or TraeX event schemas.
- No changes to domain ports or coordinator behavior.
- No new cache, watcher, polling, or persistence authority.
- No new logging or exposed diagnostics.
- No push, installation, or service restart as part of this refactor.
