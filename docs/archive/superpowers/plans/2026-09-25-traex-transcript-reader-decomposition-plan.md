# TraeX Transcript Reader Decomposition Implementation Plan

## Objective

Implement the approved transcript-reader decomposition while preserving the
public reader interface, canonical byte offsets, recovery decisions, and bounded
resource behavior.

Design authority:
`docs/superpowers/specs/2026-09-25-traex-transcript-reader-decomposition-design.md`.

## Non-negotiable invariants

- `TraexTranscriptReader` remains the only production reader implementation.
- Domain ports and all five open methods remain unchanged.
- Session metadata and realpath containment remain the path trust boundary.
- Exact turn identity is `turnId + startedAt`; adjacent turns never merge.
- Recovery scans remain bounded to 64 MiB, 1 MiB chunks, and 4 MiB records.
- Cursor offsets remain byte offsets and partial records are not projected.
- Cache sizes, TTLs, in-flight coalescing, errors, redaction, and output limits do
  not change.

## Task 1: Lock the public behavior

Run and map `tests/traex-transcript.test.ts` and
`tests/traex-transcript-cache.test.ts` against opening modes, exact boundaries,
active recovery, partial/oversized records, adjacent turns, path validation, and
cache behavior. Add characterization only for uncovered seams.

## Task 2: Extract record codec

Create `src/runtime/traex-transcript/record-codec.ts`. Move schemas, envelope
parsing, lifecycle reduction, event-time conversion, final-answer redaction,
markdown bounding, and baseline marker checks. Keep parsing fail-soft and all
current validation/error behavior.

## Task 3: Extract bounded scanners and baselines

Create:

- `src/runtime/traex-transcript/boundary-scanner.ts`;
- `src/runtime/traex-transcript/baseline-reader.ts`.

Move backward record scanning and exact start/completion lookup into the scanner.
Move forward/latest and reverse active-turn baseline recovery into the baseline
reader. Preserve byte arithmetic, partial-record handling, scan bounds, stop
conditions, and error messages exactly.

## Task 4: Extract transcript locator

Create `src/runtime/traex-transcript/locator.ts`. Move root containment, metadata
validation, directory scanning, positive LRU, negative TTL, shared index TTL, and
per-session in-flight discovery. Preserve the optional `discover` and `scan` test
injection seams. Re-export `scanTranscriptPaths` and `TranscriptPathIndex` from the
existing facade file.

## Task 5: Extract file cursor

Create `src/runtime/traex-transcript/file-cursor.ts`. Move incremental reads,
partial-line buffering, oversized-record skipping, adjacent-turn batch selection,
projection, lifecycle state, and truncation detection. It continues to implement
`TraexTranscriptCursorPort`.

## Task 6: Reduce reader facade and enforce the seam

Make `traex-transcript.ts` validate identities, select the opening strategy, map
unavailable reasons, and assemble `FileTraexTranscriptCursor`. Add an architecture
guard preventing imports of `runtime/traex-transcript/*` outside the facade and
internal directory. Update `docs/architecture.md` with the resulting shape.

## Task 7: Completion audit

Verify no domain-port, caller, persistence, schema, submission, or observation
behavior changed. Run:

```bash
npx vitest run tests/traex-transcript.test.ts tests/traex-transcript-cache.test.ts tests/traex-transcript-projector.test.ts
npm test
npm run typecheck
npm run build
npm run architecture:check
npm run docs:audit
npm run public:audit
git diff --check
```

Commit only after all gates pass. Push, installation, and restart remain outside
this slice.
