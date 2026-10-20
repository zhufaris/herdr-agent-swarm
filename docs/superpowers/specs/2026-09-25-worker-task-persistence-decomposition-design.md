# Worker Task Persistence Decomposition Design

## Goal

Deepen the Worker Task persistence module so its public interface continues to
express atomic application operations while admission, transition, projection,
queue, Human Review, and recovery rules become locally understandable. This is
a behavior-preserving refactor: SQLite schema, durable rows, public commands,
CardKit payloads, idempotency keys, FIFO ordering, and recovery decisions do not
change.

## Current shape and problem

`SqliteWorkerTurnStore` is one 476-line class that currently owns several
protocols:

- Worker Task admission, idempotency, capacity, priority, and parent validation;
- Worker Task Card and Answer timeline persistence;
- FIFO claim and runtime-turn ownership;
- generation-fenced lifecycle and projection transitions;
- terminal queue-position repair;
- parent Binding and Worker-session validation for Human Review delivery;
- restart recovery, legacy-session cancellation, diagnostics, and history.

These concerns must cooperate transactionally, but they do not all need to live
in one implementation body. The present class mixes Worker Runtime aggregate
policy with Conversation Projection and Delivery Operations details. That makes
the important transaction boundaries harder to distinguish from incidental SQL
and forces maintainers to hold unrelated protocols in context at once.

The problem is implementation locality, not the public operations themselves.
Splitting callers across several repositories would expose ordering and
transaction rules and would make the design shallower.

## Considered approaches

### A. Stable transaction facade with internal protocol modules (chosen)

Keep `SqliteWorkerTurnStore` as the capability exposed by the SQLite graph. It
owns the outer transaction for every atomic use case and delegates implementation
steps to internal modules that share its `SqliteContext`. Callers do not learn a
new protocol.

This creates locality without weakening consistency and passes the deletion
test: removing the facade would spread transaction ordering and cross-context
coordination into coordinators and composition.

### B. Multiple public capability stores

Expose separate acceptance, dispatch, projection, notification, and recovery
stores to workflows. Although the type names would look precise, callers would
need to know which operations must share a transaction and in what order. This
creates shallow modules and risks partial transitions.

### C. Pure helper extraction only

Extract validation and routing functions but retain all SQL orchestration in the
existing class. This is useful inside approach A, but by itself it leaves the
largest source of complexity untouched.

The chosen design combines A with narrowly scoped pure policies from C.

## Authority and aggregate boundaries

There is no new global aggregate root. A Worker Task remains the consistency
subject for its execution identity and lifecycle. A Worker session generation
constrains admission and FIFO ownership. Conversation projections and delivery
intents remain separate durable models coordinated in the same SQLite
transaction when a user-visible transition requires it.

SQLite remains authoritative for:

- Worker Task state, actor provenance, priority, parent, and event history;
- one-active-turn FIFO claim and queue positions;
- exact Worker generation and runtime-turn identity;
- Worker Task Card projections and Answer timeline checkpoints;
- Human Review delivery intent and idempotency;
- restart recovery eligibility.

Sharing a transaction across these records does not merge their bounded
contexts. The transaction facade coordinates context-owned participants while
preserving their separate language and responsibilities.

## Chosen module shape

```text
Coordinator consumer ports
          |
          v
SqliteWorkerTurnStore                 stable public transaction facade
          |
          +-- WorkerTurnAcceptance    admission and initial durable view
          +-- WorkerTurnTransition    fenced lifecycle/event transition
          +-- WorkerTurnProjection    card, timeline, and page persistence
          +-- WorkerTurnQueue         claim and queue-position maintenance
          +-- WorkerHumanReview       current-route decision and intent reservation
          `-- WorkerTurnRecovery      restart and legacy-session convergence

All modules use the same SqliteContext and primary connection.
Only the facade starts use-case transactions.
```

The names describe implementation roles, not new public repositories. Internal
modules may expose package-private interfaces for testing, but production
composition continues to publish the existing Worker-turn capability.

### `SqliteWorkerTurnStore`

The facade retains the current public methods so callers, capability graph, and
domain ports remain stable in this slice. Its implementation should contain only:

1. entry validation that belongs to the public operation;
2. one outer `SqliteContext.transaction()` when the operation is atomic;
3. ordered delegation to internal protocol modules;
4. assembly of the existing return value.

It must not duplicate SQL or lifecycle policy retained by a collaborator.

### `WorkerTurnAcceptance`

Owns admission implementation for `acceptInstanceTurn` and
`acceptInstanceTurnWithCard`:

- current Worker generation validation;
- idempotency collision validation;
- queue capacity and priority-turn exclusion;
- ordinary/follow-up parent rules;
- queue-position calculation;
- turn insertion and `turn.accepted` event insertion;
- initial Worker Task projection and create intent reservation.

The facade keeps the whole acceptance sequence in one transaction. Rendering
failure, outbox capacity failure, or projection failure rolls back every write.

### `WorkerTurnTransition`

Owns the state-transition implementation behind
`transitionInstanceTurnWithProjection` and the simple lifecycle update path:

- load and validate the current Task and projection;
- enforce Worker generation and optional exact runtime-turn fences;
- update lifecycle state and insert the episode event;
- reduce and persist the Worker Task projection;
- invoke terminal queue repair;
- invoke Human Review reservation for a new blocked episode;
- return the existing transition result.

This module orchestrates participants but does not start its own independent
transaction. A repeated `blocked -> blocked` observation creates neither a new
episode event nor another notification.

### `WorkerTurnProjection`

Owns Worker Task Card, page, and Answer timeline persistence and mapping. It
contains projection-specific SQL, reducers, delivery checkpoints, and row
mapping. It does not decide Worker lifecycle transitions or whether work may be
dispatched.

Projection writes invoked by acceptance or transition participate in the
facade's current transaction. Standalone projection/checkpoint operations retain
their present atomic behavior. Canonical source offsets, frozen-page behavior,
and delivery versions remain unchanged.

### `WorkerTurnQueue`

Owns durable FIFO mechanics:

- pending-count queries;
- one-active-turn exclusion;
- priority-first, then creation/row order claim;
- terminal queue-position recalculation;
- claim event insertion where part of the claim transition.

The module does not schedule process-local work. `WorkerTurnDispatcher` remains
the application-level wake and dispatch owner.

### `WorkerHumanReview`

Owns the pure current-route decision and durable intent construction for a real
blocked episode. Its input contains only the current Worker, Task, projection,
parent Binding, event ID, and renderer. Its result retains the existing
`reserved | skipped` outcome.

The route remains current only when Worker role and generation, active Worker
session generation, parent Binding generation and pane, attached active Binding,
root message, and Worker runtime pane all agree. Stale routing skips only the
notification; it does not roll back the blocked Worker state. A renderer or
outbox reservation failure still rolls back the entire transition.

The idempotency key remains:

```text
worker-review:<workerId>:<workerSessionGeneration>:<turnId>:<blockedEventId>
```

No remote approval, denial, terminal input, process control, or pane control is
introduced. High-risk approval remains local to Herdr.

### `WorkerTurnRecovery`

Owns restart recovery and legacy Worker-session convergence:

- cancel queued work that belongs to an unrecoverable detached legacy session;
- return never-dispatched `claimed` work to `queued`;
- list exact observable `dispatching`, `running`, `blocked`, and
  `dispatch-uncertain` work for observation;
- preserve recovery event history and result-capture state.

It never requeues work that may have crossed the Agent boundary.

## Pure domain policies

Pure functions are introduced only where they remove repeated decisions or make
an invariant directly testable. Candidate policies are:

- `validateWorkerTurnAdmission` for kind, priority, parent, identity, and capacity
  decisions after the required records/counts are loaded;
- `matchesExpectedWorkerRuntimeTurn` for exact runtime-turn identity;
- `decideWorkerHumanReviewRoute` for the generation/pane/session route fence;
- `nextWorkerQueuePositions` for deterministic terminal reordering.

They return typed decisions or throw the same errors as today. They do not read
SQLite, render CardKit, publish events, or enqueue work. A helper is not created
when it would merely rename one SQL statement.

## Dependency direction and transaction discipline

The internal persistence modules may depend on domain entities, reducers, and
ports plus `SqliteContext`. They must not import coordinators, events, concrete
Gateway adapters, or composition. Presentation remains callback-injected where
the existing atomic contract requires rendering before commit.

Nested calls may reuse `SqliteContext.transaction()` only with its existing
nesting semantics; the intended shape is one facade-owned outer transaction. No
module creates a database connection, manually commits, or emulates a transaction
across repositories.

The following operations remain indivisible:

- Task row + accepted event + initial Task projection + create intent + context
  invalidation;
- Task state + lifecycle event + Task projection + queue projection repair +
  Human Review intent + context invalidation;
- restart cancellation/requeue + recovery events + affected projection updates.

## Migration sequence

1. Add focused Worker dispatcher characterization for confirmed non-delivery,
   confirmed delivery, generation change after claim, and shutdown cancellation.
2. Extract row mappers and pure fence/admission/Human Review decisions with
   byte-for-byte and outcome-for-outcome characterization.
3. Extract `WorkerTurnProjection`, including timeline/page persistence, without
   changing public methods.
4. Extract `WorkerTurnQueue` and route existing facade calls through it.
5. Extract `WorkerTurnAcceptance`; keep `acceptInstanceTurnWithCard` as the outer
   transaction and verify rollback behavior.
6. Extract `WorkerHumanReview` and `WorkerTurnTransition` together so blocked
   episode identity and intent reservation cannot temporarily separate.
7. Extract `WorkerTurnRecovery`.
8. Remove dead helpers and tighten architecture tests around the internal module
   direction.

Each step must compile and pass focused tests. The migration does not temporarily
publish internal modules through the composition root.

## Failure and recovery semantics

- A stale Worker generation or exact runtime-turn identity remains a no-op/null
  result at the same public seam.
- An idempotency key reused for different Task content remains an error.
- Queue capacity and priority exclusion remain fail-before-insert decisions.
- Any failure while building the initial Card or Human Review intent rolls back
  the complete transaction.
- Stale Human Review routing commits the blocked transition but emits no intent.
- A lost process-local wake remains recoverable from SQLite scans.
- Restart recovery requeues only `claimed` work that has not crossed dispatch;
  uncertain or observed work remains under exact observation.

## Verification

Focused store tests must continue to cover:

1. atomic insertion, duplicate acceptance, and rendering/outbox rollback;
2. capacity, priority, ordinary/follow-up parent, and queue-order rules;
3. one-active-turn claim and Worker generation fencing;
4. exact runtime-turn ownership and stale transition rejection;
5. projection, timeline, page, and delivery checkpoint persistence;
6. terminal queue-position recalculation;
7. one notification per blocked episode and a new notification for a later
   episode;
8. current versus stale Human Review routing and safe creator mention;
9. rollback of state, event, projection, invalidation, and outbox when Human
   Review rendering fails;
10. restart requeue, legacy cancellation, observable-turn selection, and
    no-replay handling.

Add direct `WorkerTurnDispatcher` characterization before changing persistence
internals so dispatch outcomes remain fixed at the consumer seam. Add architecture
checks that the facade remains the published capability, collaborators share the
injected context, and no internal persistence module imports outer layers.

After every extraction run the nearest Worker and SQLite tests. Before handoff,
run the full Vitest suite, `npm run typecheck`, `npm run build`, the repository
architecture check, documentation audit, public audit, and `git diff --check`.

## Explicit non-goals

- No SQLite schema or migration change.
- No public store method, coordinator contract, or composition topology change.
- No state, event kind, idempotency key, queue order, retry, or recovery change.
- No CardKit payload, Human Review copy, mention, or routing change.
- No new in-memory queue or durable authority.
- No rename of the legacy public `Instance*` vocabulary in this slice.
- No Outbox recovery, Primary Prompt, transcript parser, or service lifecycle
  refactor.
- No generic repository framework or one-interface-per-class abstraction.
