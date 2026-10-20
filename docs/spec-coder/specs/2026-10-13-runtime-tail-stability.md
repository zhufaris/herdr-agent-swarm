# Runtime Tail Stability

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

The deployed `6d14d0a5` build removed repeated canonical snapshot ingestion, but
fresh production evidence now isolates three smaller stability costs:

- startup retained Session Activity recovery ran nine slow write transactions
  with 240.7 ms mean duration; one production-shaped page contains 129 retained
  pairs and 144 mutations for one scope, causing 864 prune statements where six
  are sufficient;
- `EXPLAIN QUERY PLAN` builds an automatic checkpoint index for Primary rows and
  scans `core_event_lane_checkpoints` for Worker rows because the join has no
  `(agent_kind, session_id, lane_id)` index;
- Lark message-card updates discard a resolved SDK response even though the
  adapter already owns a nonzero-code validator, and the Herdr event projector
  retains reasoning-sequence state across turn boundaries.

These are local hot-path and lifecycle defects. The system does not need another
queue, worker, cache, table, timer, recovery ledger, or public interface.

## Solution

Auto-selected under the goal's explicit no-wait authority: optimize at the
existing owners.

The selected approach adds ordered migration 131 for the checkpoint session
lookup, loads and translates one retained recovery page before opening the
existing write transaction, and prunes once per changed scope after all page
mutations. The transaction still owns fingerprints, mutations, projection
updates, notifications, and the returned recovery result.

The same change set makes the Lark adapter validate the resolved update response
through its existing validator and resets reasoning-sequence state on the
existing `turn_started` boundary.

Alternatives rejected:

- moving all SQLite ownership into a worker thread would address a broader
  class of synchronous stalls but introduces a new queue/protocol and migration
  of hundreds of call sites without evidence that this round needs it;
- adding only the checkpoint index leaves 864 redundant prune statements and a
  broad write transaction;
- adding only metrics or transaction labels improves attribution but not the
  measured cost or silent provider-failure behavior.

## User Stories

### SCN-1: Retained activity recovery holds a narrow write transaction

For one bounded retained page, evidence loading and lifecycle translation occur
before the write transaction. All valid mutations preserve their current order
and visible result, while each changed pane scope is pruned exactly once.

### SCN-2: Retained checkpoint lookup uses a released index

Fresh and upgraded databases expose a checkpoint session index. The production
recovery plan uses that index for both Primary and Worker producer branches and
does not build an automatic index or scan the checkpoint table.

### SCN-3: Lark update failures remain retryable provider failures

A resolved message-card update response with a nonzero provider code throws the
same normalized adapter error used by other Lark message operations. A success
response remains unchanged, allowing the durable outbox to settle only an
acknowledged provider success.

### SCN-4: Reasoning sequence state is turn-scoped

When a new turn starts, reasoning sequence mappings from the prior turn are
discarded before new deltas are projected. Current-turn deduplication and output
ordering remain unchanged.

## Implementation Decisions

### INV-1: Recovery semantics remain page-idempotent

The same retained pairs produce the same ordered mutations, identity updates,
visible fingerprints, Main Card projection decisions, and notifier calls.
Batching prune changes only redundant maintenance work. A failed write rolls
back all page mutations and pruning as before.

### INV-2: Query work does not require a write lock

Retained Core events and their translated lifecycle mutations are immutable
evidence for the duration of the synchronous call. They may be loaded before
`BEGIN IMMEDIATE`; all state-dependent fingerprints and writes remain inside the
transaction.

### INV-3: Provider success is explicit

The Lark SDK resolving a Promise is not sufficient evidence of success. The
adapter validates the response code before returning to delivery settlement.

### INV-4: Turn-local maps cannot retain prior-turn identity

`turn_started` is the authoritative reset boundary for calls, emitted message
IDs, and reasoning-sequence mappings.

### ARCH-1: Deepen existing modules only

`SqliteSessionActivityStore` owns recovery batching, SQLite schema/migrations own
the lookup index, `LarkAdapter` owns SDK response translation, and
`HerdrEventProjector` owns turn-local state. No new public port or runtime
component is introduced; dependency direction remains unchanged.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, SCN-4, INV-1, INV-2, INV-3, INV-4, ARCH-1

- Count recovery SQL through the existing store seam and prove 144 same-scope
  mutations execute six prune statements rather than 864, while output remains
  identical.
- Assert the retained query executes before the labeled write transaction and
  that an injected mutation failure rolls the page back.
- Cover fresh/prior epoch migration 131, exact index columns, canonical
  fingerprint convergence, idempotent reopen, and both recovery-plan branches.
- Simulate resolved Lark update responses with success and nonzero codes.
- Project two turns with repeated reasoning IDs and prove the second turn starts
  with an empty reasoning-sequence map.

## Out of Scope

No SQLite worker-thread conversion, durable recovery cursor, outbox recovery
pagination, Turn Card retry-policy change, inbound rate limiting, Pi transcript
incremental reader, Ring eviction, logging aggregation, public API change, or
manual production-database mutation.

## Further Notes

Workspace `/tmp/herdr-agent-swarm-main-ring-stability-20261012` is the existing
isolated clean `main` worktree at
`6d14d0a5453cb3d1113b88376fd84dba9210b7fa`; the original checkout remains
excluded. Dependencies are installed from the lockfile. Baseline record
`83a061293e2941059bf315efdc273bb5` passed four files and 176 tests. Its compact
conversation summary is intentionally not presented as reusable authenticated
evidence; the verification CLI returned `rerun`, so main freshly reran the same
four files after artifact creation and again observed 176 passing tests.
