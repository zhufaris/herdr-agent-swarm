# Runtime Performance Hardening Design

## Goal

Reduce latency, CPU, filesystem, subprocess, memory, and shutdown risk in the
AgentSwarm runtime while preserving its durable workflow semantics: SQLite
remains authoritative, accepted prompts are never replayed after uncertain
delivery, per-binding ordinary turns remain FIFO, and Lark delivery continues
through durable projections and the outbox.

## Scope and delivery strategy

The work is delivered as four independently testable batches. Each batch can be
reviewed and deployed without requiring the later batches:

1. bound Primary Tool socket work and drain in-flight card convergence;
2. reduce transcript filesystem work and Herdr polling;
3. make Answer Card rendering and progress payloads bounded;
4. add SQLite hot-path indexes and bound history reads.

Operational correctness findings discovered during the audit are handled in a
separate cleanup batch so they do not obscure performance regressions. Build
artifact and dependency-size reductions remain optional last-mile work because
they do not materially improve live request latency.

## Invariants

- No change may cause automatic prompt replay after TraeX may have received a
  prompt.
- SQLite intent is committed before visible Lark delivery.
- CardKit element sequence remains monotonic, and frozen answer pages are never
  patched.
- Full tool activity remains durable even when the visible card shows only a
  bounded window.
- Shutdown must not close SQLite or the publisher while a projection flush can
  still write to them.
- Herdr remains authoritative for pane and agent runtime state. Cached or
  event-driven observations may improve latency but cannot replace periodic
  reconciliation.
- Cache entries are optimization hints only. Cache eviction or restart must not
  change workflow results.

## Batch 1: bounded local socket and shutdown work

### Primary Tool gateway

Each Unix-socket connection accepts exactly one newline-delimited request. Once
the first complete frame is found, the gateway marks the connection handled,
removes or disables the data listener, and rejects trailing input rather than
starting another tool invocation. The connection has an idle deadline and the
gateway caps simultaneously accepted sockets. These controls complement the
existing 64 KiB request limit; they do not change capability validation,
generation fencing, or server-side parent-turn derivation.

The MCP client applies a response byte limit before concatenating or parsing the
reply. It stores bounded chunks and joins once. An oversized response destroys
the connection and returns an actionable protocol error. The limit must exceed
all currently supported tool envelopes while remaining small enough to protect
the process heap.

### Card convergence shutdown

`CardUpdateScheduler` tracks every active flush promise. `stop()` becomes
asynchronous and performs three ordered actions: reject new schedules, cancel
pending timers, then await all already-started flushes. A flush that was already
running is allowed to complete, but it cannot schedule a retry after stop.
`ConversationViewProjector.stop()` awaits scheduler settlement before returning,
so the existing runtime shutdown sequence can safely stop the publisher and
close SQLite afterward.

This batch does not make process-local scheduled work durable. Durable desired
and delivered versions remain the recovery mechanism for work that had not
started before shutdown.

## Batch 2: transcript and Herdr observation efficiency

### Transcript discovery

The existing bounded positive LRU path cache remains. Add two complementary
controls keyed by validated TraeX session ID:

- a short negative cache for `transcript_not_found`, preventing repeated full
  directory walks during the first-turn grace period;
- in-flight discovery coalescing, so concurrent callers share one directory
  traversal.

Negative entries expire quickly so a newly created transcript is discovered
within the existing grace period. Ambiguous or validation-failed results are not
treated as ordinary negative cache hits. Successful discovery invalidates the
negative entry and populates the positive LRU.

Opening a transcript performs one bounded tail read and one JSONL parse pass.
That pass derives both the latest token count and the current turn lifecycle and
then constructs the cursor. It preserves the current maximum read size and
malformed-line tolerance.

### Herdr polling and observation

TraeX process and managed-agent startup polling uses capped exponential backoff
with jitter instead of a fixed 50 ms interval. The first checks remain prompt,
then settle toward a one-second ceiling. Timeout and success semantics remain
unchanged. The compatibility retry for `agent_pane_busy` follows the same bounded
policy.

Instance-turn reconciliation obtains one authoritative pane snapshot per scan,
indexes it by pane ID, and evaluates all observable turns against that snapshot.
The scan remains serialized for SQLite state transitions unless measurements
show a need for bounded concurrency. Pane closure prefers the existing Herdr
close event and performs one final authoritative verification; periodic polling
remains only as a compatibility fallback with backoff.

Native Herdr request transport receives its own failure state. Repeated native
timeouts open a short circuit so calls go directly to the CLI fallback. After a
cooldown, one probe may restore native operation. This transport breaker is
separate from the workflow-level Herdr breaker because successful CLI fallback
must not erase evidence that the native socket is unhealthy.

## Batch 3: bounded Answer Card rendering

### Markdown pagination

Inline-code preservation uses a deterministic linear scanner rather than a
backreference regular expression. Protected tool ranges and candidate line ends
are walked with sorted pointers instead of nested range scans. Page selection
operates on the active page window and avoids normalizing the complete remaining
answer before applying the 9,000-character rendered limit.

Continuation offsets remain offsets in the canonical source string. Rendering
is therefore a presentation-only transform and cannot corrupt durable answer
recovery. Existing rules for code fences, tables, diffs, links, and tool output
remain covered by regression tests.

### Progress timeline

The durable `RunCardView` continues to retain the progress information required
for recovery and final state. The CardKit renderer, however, emits only a fixed
recent window plus summary counts for older events. Collapsing content is not
considered a size bound because collapsed elements are still serialized and
sent to Lark.

Project, instance, and space directory cards share a serialized-size guard. A
single oversized section is split before it enters a page, and all list cards
use deterministic page boundaries.

## Batch 4: SQLite hot paths and bounded history

Schema migration adds indexes matching actual query predicates:

```sql
CREATE INDEX IF NOT EXISTS instance_turns_observable
ON instance_turns(created_at, id)
WHERE state IN ('dispatching','running','blocked','dispatch-uncertain');

CREATE INDEX IF NOT EXISTS instance_events_instance_id
ON instance_events(instance_id, id);

CREATE INDEX IF NOT EXISTS instance_turns_instance_history
ON instance_turns(instance_id, created_at, id);
```

The migration is additive and idempotent. Tests inspect `EXPLAIN QUERY PLAN` to
confirm the intended indexes are usable instead of assuming an index helps from
its declaration alone.

Instance history becomes cursor-paginated and list views select only the columns
they need. Existing internal callers that require complete history must state
that requirement explicitly rather than inheriting an unbounded default. Startup
recovery replaces repeated `Array.includes()` membership checks with `Set` or SQL
deduplication, reducing lock-held work without changing result ordering.

## Cache lifecycle and observability

`ConversationViewProjector` and the Lark message-to-card lookup use bounded LRU
caches. Terminal or archived bindings are evicted after their final projection
has been scheduled, and all process-local caches are cleared during stop. A cache
miss reloads SQLite or Lark identity through the existing authoritative path.

Repeated dependency failures are logged on state transitions rather than on
every binding or retry. The first failure remains a warning, identical repeats
are summarized with counts and outage duration, and recovery emits one record.
Durable per-binding degradation state is unchanged.

## Operational correctness cleanup

The compatibility plugin initializes a missing project registry from
`config/projects.example.json`. Safe restart fails closed when an active managed
unit cannot provide matching and complete `/status` safety data; only explicit
`--force` bypasses this guard. Lifecycle validation uses the same environment the
rendered systemd unit will receive.

The `/swarm reset <title>` contract is made truthful by using the requested title
after the same normalization and uniqueness rules as other pane titles. The
unused legacy `createRoot` path and confirmed unused imports/exports can then be
removed in a small cleanup commit.

## Testing and rollout

Each batch begins with focused regression or complexity-bound tests and runs the
nearest affected Vitest files. Every batch also runs `npm run typecheck` and
`npm run build`; batches spanning workflow, persistence, or shared runtime
behavior run the full `npm test` suite before completion.

Performance tests assert bounded work rather than fragile wall-clock thresholds:
number of directory traversals, subprocess polls, JSONL reads, Markdown parser
passes, snapshot requests, card elements, and SQL query plans. Socket tests send
fragmented input, multiple frames, oversized responses, and idle connections.
Shutdown tests hold a card delivery in flight and prove that projector shutdown
does not return until it settles.

Deployment remains one batch at a time. After build and restart, verify `/ready`,
`/status`, outbox depth, card convergence failures, and bounded recent logs. No
deployment step starts either legacy service.

## Acceptance criteria

- One Primary Tool connection can execute at most one authenticated tool call;
  requests, responses, idle time, and concurrent connections are bounded.
- Projector shutdown waits for active card convergence and permits recovery of
  work that had not started.
- Repeated transcript acquisition does not repeatedly scan the full sessions
  tree, and transcript baseline state is derived from one tail read.
- Slow TraeX startup does not create unbounded 50 ms CLI polling.
- One instance-turn reconciliation scan does not fetch one full Herdr snapshot
  per turn.
- Answer rendering remains responsive for long or adversarial Markdown and keeps
  canonical source offsets intact.
- Visible progress and directory card payloads have explicit size bounds while
  durable history remains available.
- SQLite hot queries use verified indexes, and instance history has a bounded
  cursor API.
- Existing prompt FIFO, no-replay, generation fencing, outbox idempotency, and
  CardKit sequence tests continue to pass.
- The production service becomes ready after each deployed batch, with zero
  unexpected outbox backlog or card convergence failures.
