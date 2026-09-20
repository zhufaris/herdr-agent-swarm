# Event, Store, and Outbox Hardening Design

## Status

Approved as the next architecture-hardening sequence after unified event
integration and event-interface convergence.

## Objective

Make outbound delivery failure boundaries explicit, deepen the outbox and SQLite
modules, reduce manual post-commit orchestration, and improve lifecycle-event
diagnostics without introducing another durable source of truth.

## Ordered slices

### 1. Delivery commit and observer isolation

An external Lark call, its durable delivery checkpoint, and process-local
post-delivery observers are separate failure domains. Once Lark succeeds and the
outbox row is durably marked delivered, a checkpoint listener failure must not
enter transport retry or dead-letter handling. Listener failures are isolated,
logged, counted, and left to normal durable convergence.

All delivery state transitions use compare-and-set semantics. A delivery or
failure transition applies only to a pending row and returns an explicit outcome
when the row is stale, missing, or already terminal. Concurrent or repeated
completion cannot move a delivered row back toward retry or dead-letter state.

### 2. Deep outbound runtime modules

Split the current dispatcher along its two state machines:

- `OutboundDrainRuntime` owns wake-up subscription, safety scans, retry timers,
  bounded concurrency, shutdown settlement, and scan diagnostics.
- `OutboundDeliveryExecutor` owns payload materialization, target validation,
  Lark transport selection, durable delivery/failure transitions, and isolated
  post-delivery notifications.

The public `LarkOutboxDispatcher` name may remain as a small compatibility
facade if existing callers benefit, but production composition and tests verify
behavior through the focused interfaces. The split must not add another queue or
change lane ordering.

### 3. Focused SQLite outbox capabilities

Keep one `SqliteContext`, one database connection, and existing nested
transaction behavior. Split implementation ownership into focused modules:

- queue and lane-head maintenance;
- delivery checkpoints and failure transitions;
- quarantine, automatic recovery, and manual dead-letter actions;
- retention.

Cross-module operations continue to run through the shared context, so an outer
transaction remains atomic. SQL and migration schemas stay compatible with live
databases.

### 4. Kernel contraction

Expose complete capability modules directly from `SqliteStoreBundle` where an
existing focused module satisfies the consumer interface. Keep the kernel only
for construction, lifecycle, and genuinely cross-module transactional use cases.
Remove forwarding methods only after all production callers use the capability
module and focused tests cover the replacement.

### 5. Typed post-commit effects pilot

Introduce a typed receipt for one bounded workflow, starting with prompt
acceptance. The transaction returns the durable result plus explicit
post-commit effects such as lifecycle fan-out, outbound wake-up, and prompt work
wake-up. A small executor performs those effects only after the outermost SQLite
transaction commits. Rollback discards them.

The receipt is not durable state and is never replayed as a command. Existing
startup scans, safety scans, and reconciliation remain the recovery mechanisms.
The pilot is expanded only if it reduces caller knowledge without obscuring
transaction ownership.

### 6. Lifecycle diagnostics

Extend `BridgeEventBus` diagnostics with listener count, publication count, and
per-subscriber failure information. Duplicate subscriber names fail fast so
diagnostics remain attributable. Subscriber failures stay isolated and never
change an already committed workflow outcome.

## Preserved invariants

- SQLite is authoritative for inbound records, workflow state, delivery intent,
  idempotency, retries, quarantine, and audit state.
- Fresh Herdr snapshots are authoritative for pane and agent runtime state.
- Lark is an external projection, never a workflow source of truth.
- Outbound intent is persisted before a wake-up.
- A successful external delivery is never retried because a local observer
  failed afterward.
- Lane ordering, frozen-page behavior, superseded-event dismissal, exact-turn
  fencing, FIFO, and no-replay behavior remain unchanged.
- There is no generic `publish(any)`, durable lifecycle-event log, or second
  SQLite connection.

## Verification and completion criteria

Each slice receives focused tests before a thematic commit. The final audit maps
all six slices to concrete source and test evidence and runs architecture checks,
strict unused checking, typecheck, build, `git diff --check`, and the complete
Vitest suite. The work is complete only when the worktree is clean and every
listed invariant is covered by implementation or a focused regression test.
