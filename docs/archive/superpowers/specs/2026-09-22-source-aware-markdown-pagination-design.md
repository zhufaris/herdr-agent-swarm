# Source-Aware Markdown Pagination Optimization

## Goal

Reduce CPU time and transient allocation while rendering long Primary Answer and
Worker Turn Card streams without changing their canonical source offsets, visible
Markdown semantics, or durable continuation protocol.

## Baseline

The current renderer parses the complete source, renders everything from the
active page start to the end, collects all later line boundaries, and repeatedly
renders candidate ranges during binary searches. On this host, rendering one
9,000-character page from a 512 KiB mixed prose/code source took approximately
43.9 ms at offset 0, 23.9 ms near the middle, and 10.0 ms near the tail. Streaming
convergence can invoke this path every 500 ms.

## Design

`src/runtime/lark-markdown.ts` remains the single pure rendering boundary shared
by Primary Answer and Worker Turn Card presentation. Each public page-render call
will construct one ephemeral `MarkdownPageIndex` containing source block metadata,
canonical line boundaries, and atomic tool-activity ranges. The index belongs only
to that call; it is neither cached across revisions nor persisted.

Page selection will scan forward from the requested canonical `pageStart` and
maintain the latest render-safe candidate that fits the output budget. It will
stop once the next candidate exceeds the budget. The implementation must not
render the complete remaining source as a preliminary fit check and must not
repeat full range renders inside binary searches. The chosen canonical range is
rendered once for the returned page.

When a range cannot be split at a safe line boundary, the renderer retains the
existing hard-progress fallback for one long source line. Continuation suffix
space is reserved only when overflow is proven. A short final page returns
`nextPageStart: null`.

## Semantic invariants

- `nextPageStart` is always an offset into the original canonical source string.
- Rendering never rewrites the source or persists presentation-only transforms.
- CRLF normalization, safe-link and HTML handling, code-fence closure/reopening,
  table and TraeX diff fencing, tool-activity compaction, and atomic tool blocks
  preserve current observable behavior.
- Frozen Answer pages remain immutable; later content continues on a new card.
- Primary Answer and Worker Turn Card continue through their existing presentation
  ports, so no coordinator, SQLite schema, outbox identity, or Gateway contract
  changes are required.
- Memory use remains bounded by the already bounded source. No process-global or
  workflow-state cache is introduced.

## Alternatives rejected

An incremental parser cache keyed by prompt or Worker turn could make appended
renders cheaper, but it would require cache identity, append-only validation,
eviction, and terminal cleanup across presentation boundaries. That lifecycle is
not justified before the pure renderer is made linear.

An exact-input LRU would be simpler, but streaming changes the source on nearly
every update and therefore offers little reuse. It would also retain large source
strings without removing the repeated work on cache misses.

## Verification

Tests will preserve the existing page results and canonical boundaries for mixed
Markdown, CRLF, tables, diffs, incomplete and continued fences, long lines, and
atomic tool activities. Coverage will exercise both Primary Answer and Worker Turn
Card presentation.

A deterministic renderer-work test will prove that selecting a page does not
render the full remaining 512 KiB source or repeatedly rerender candidate ranges.
A local benchmark will compare the same 512 KiB fixture before and after the
change at early, middle, and late page starts. The target is at least a 50%
reduction for early and middle pages on this host; benchmark timing is evidence,
not a brittle CI pass/fail threshold.

The final local measurement used the baseline fixture above and averaged 20 warm
renders per position. Early, middle, and late pages improved from 43.9/23.9/10.0
ms to 8.1/7.1/7.0 ms. A 512 KiB tool-activity-heavy fixture rendered in
12.8/13.5/11.9 ms across the same positions.

Before handoff, run the focused Markdown, Answer stream, Worker Card, and affected
integration suites, followed by `npm test`, `npm run typecheck`, `npm run build`,
`npm run architecture:check`, `npm run docs:audit`, and `npm run public:audit`.

## Non-goals

- Changing the 9,000-character Answer page limit or the 512 KiB turn-output cap.
- Adding cross-request parser caches or durable render indexes.
- Changing CardKit card layout, delivery scheduling, outbox coalescing, or retry
  behavior.
- Optimizing bounded turn-output accumulation or workspace snapshot collection in
  this slice.
