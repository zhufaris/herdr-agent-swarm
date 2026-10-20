# Transient Recovery and Ring Elegance

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Three existing local failure and hot-path behaviors weaken runtime stability or
perform avoidable work:

- `HerdrEventSourceSession` caches failed capability, stream-support, and
  session-ring support probes for the process lifetime. A transient Herdr/Core
  socket failure can therefore permanently disable native recovery or poison
  every later identity/attach attempt until restart.
- `WorkerTurnObserver` polls every 250 ms through `setInterval`; rejected cursor
  reads are swallowed. A persistent Core read failure retries roughly four
  times per second per Worker and can enqueue no-op promise continuations while
  providing no bounded warning signal.
- `PreparedDeliveryRing` already owns a `byReplyId` map, but both delivery
  engines copy and scan the full ring before every offer. History invalidation
  repeatedly splices/unshifts the queue, and bulk discard repeatedly shifts the
  head.

The production system currently remains ready and its Ring-to-Gateway path is
fast, so this work must preserve all delivery, recovery, ordering, fencing, and
uncertain-effect semantics rather than introduce a new scheduler or replay path.

## Solution

Repair each behavior inside its existing owning module:

- Cache only successful Core capability/support probe results. A failed general
  capability attempt returns the existing conservative unsupported result for
  that call and clears the cache; failed stream/ring support attempts preserve
  their rejection while clearing the cache. The next caller may retry.
- Replace Worker `setInterval` polling with one self-scheduling timeout. Read
  failures use capped exponential backoff, log only when the retry tier changes,
  and reset to the configured base interval after any successful read. Existing
  observation, acknowledgement, final drain, detach, and terminal-state rules
  remain unchanged.
- Deepen `PreparedDeliveryRing` with map-backed membership and one-pass bulk
  operations. The engines ask the ring whether a reply is cached; history
  invalidation partitions once while preserving order; bulk removal clears the
  queue/map/byte state once and returns released bytes. Remove the unused
  `markDirty` method and narrow internal result types that have no external
  consumers.

This local-owner approach was auto-selected under explicit autonomous authority.
Alternatives were a shared generic retry/cache framework and a new global
recovery worker/deque subsystem. Both add interfaces and lifecycle state without
evidence that the three bounded owners need cross-module coordination.

## User Stories

### SCN-1: A transient Core probe recovers without restart

When the first capability, stream, or session-ring probe fails transiently, the
failed promise is not retained. A later call re-executes the probe and can use
the recovered native capability. Concurrent callers during one attempt still
share that single attempt.

### SCN-2: A Worker cursor failure cannot spin at 250 ms forever

When a Worker exact-turn cursor repeatedly rejects, only one read remains in
flight and retry delay grows to a finite cap. Warnings are bounded by retry-tier
changes. A successful read resets the base interval, and stop/final drain retain
their existing behavior.

### SCN-3: Ring optimization preserves delivery semantics

Duplicate reply IDs, stale identities, FIFO order, byte accounting, active-grant
protection, ready-token invalidation, history supersession order, and process
byte limits produce the same observable outcomes while avoiding copied linear
membership scans and repeated array mutation during bulk work.

## Implementation Decisions

### INV-1: Failed Core probes are never process-lifetime facts

`HerdrEventSourceSession` owns probe single-flight state. A successful result may
be cached for the session lifetime. A rejected attempt must clear only its own
cache entry so a newer successful attempt cannot be erased by a stale failure.
General capability failure remains fail-closed for that call; support-probe
failure remains an error for that call. No submission, replay, or SQLite state
is involved.

### INV-2: Worker polling has one timer and one active read

`WorkerTurnObserver` owns live cursor scheduling. The next timeout is scheduled
only after the current read/observe/ack chain settles. Consecutive read failures
increase a deterministic delay from the configured base interval to a bounded
maximum; successful reads reset the failure count. Stopping clears the pending
timer before final drain. This does not terminalize a Worker or invent recovery
evidence.

### INV-3: Ring cache identity and ordering stay authoritative

`PreparedDeliveryRing` remains the single in-memory owner of queue order,
`replyId` membership, cached byte accounting, ready tokens, grants, dirty state,
and revisions. New bulk operations must update these fields together. Active
head work is never invalidated, removed history is returned in original queue
order, and bulk clear returns exact released bytes for process accounting.

### ARCH-1: Keep repairs local to existing deep modules

The Core session wrapper, Worker observer, and Ring expose the smallest existing
interfaces needed by their callers. No generic retry abstraction, new port,
new persistence owner, new scheduler, or adapter dependency is introduced.
Runtime/adapters continue to depend on existing domain ports; the Ring remains
transport-neutral.

### ARCH-2: Preserve durable and external-effect boundaries

SQLite remains authoritative for workflow intent and checkpoints; the Ring
remains disposable cache. No uncertain external effect or Agent Input is
replayed. No delivery ordering, idempotency key, checkpoint, generation, owner,
or card identity fence changes.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, ARCH-1, ARCH-2

- Add failing Core-session tests proving first-failure/second-success behavior
  for general capabilities, stream support, and session-ring support, plus
  concurrent single-flight preservation.
- Add fake-timer Worker tests proving bounded exponential retries, warning-tier
  behavior, success reset, terminal stop, and final drain compatibility.
- Add Ring tests for O(1) membership behavior through the public ring seam,
  alternating multi-item history invalidation with stable order and bytes, and
  one-pass bulk removal. Extend both delivery-engine duplicate paths.
- Run the focused test files, affected Ring hot-path/recovery suites,
  `npm run typecheck`, `npm run build`, `npm run architecture:check`, and the
  full Vitest suite. After deployment verify build identity, `/ready`, Core
  ingestion, backlog non-regression, and recent delivery latency.

## Out of Scope

No schema migration, SQLite repair, orphaned-scope retirement policy, automatic
uncertain-effect recovery, delivery scheduler replacement, Ring capacity change,
generic retry library, Core protocol change, Lark rendering change, dependency
upgrade, build/install lock, or status-probe redesign is included.

## Further Notes

Workspace mode: in-place work inside the existing isolated clean worktree
`/tmp/herdr-agent-swarm-main-ring-stability-20261012`, branch `main`, starting
revision `9ed2fbd0e13368cb189437129eb041cf820033b8`. The original user checkout is
untouched. Locked dependencies were present and `npm ls --depth=0` passed.

Fresh baseline records observed by main for request
`round-20261012-transient-recovery-ring-elegance`:

```spec-coder-verification
{"record_id":"d606af9fc09f4089a2a2d83e4281b3f5","command":["/usr/bin/npm","test"],"exit_code":0,"status":"captured","observed_at":"2026-10-12T19:01:50.533147+00:00","result":"301 files and 4712 tests passed"}
```

```spec-coder-verification
{"record_id":"81df623be597478098cc338c22e123c3","command":["/usr/bin/npm","run","typecheck"],"exit_code":0,"status":"captured","observed_at":"2026-10-12T19:02:27.454804+00:00"}
```

```spec-coder-verification
{"record_id":"92afc6c4c7d64c9fb2bfe2cff00c4b01","command":["/usr/bin/npm","run","build"],"exit_code":0,"status":"captured","observed_at":"2026-10-12T19:02:38.260202+00:00","build_id":"sha256:57c43404c4df829c7a61e640b94c986507282ee3f7dedc09b8e355c1269b5445"}
```

No glossary or ADR change is warranted: the domain language and durable
architecture are unchanged. Approach selection and Gate 1 were auto-selected
under explicit autonomous authority; this specification is the unique bounded
recommendation for Gate 2.
