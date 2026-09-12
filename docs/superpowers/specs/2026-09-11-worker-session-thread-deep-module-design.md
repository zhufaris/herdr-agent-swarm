# Worker Session Thread Deep-Module Refactor Design

## Status

Implemented. Worker Session Thread application behavior and SQLite transitions
now sit behind the deep-module interfaces described below.

## Goal

Concentrate Worker Session Thread behavior behind deep modules so callers do not
need to understand placement modes, thread lifecycle, Worker/Primary ownership
fences, command precedence, outbox target columns, or delivery ACK mechanics.

This is a structural refactor. It must preserve the currently implemented
behavior:

- a new Worker Session generation gets one canonical group-root Worker Main
  Card and independent thread;
- a pre-migration Worker remains `legacy-unpublished` until an operator requests
  one passive entry thread;
- ordinary thread text creates an independent FIFO turn;
- `/status`, `/steer <text>`, and `/stop` keep their current meanings;
- stale roots fail closed;
- delivery retries never repeat an Agent operation;
- an already delivered Worker Main Card is never moved or duplicated.

## Structural diagnosis

The current implementation is functionally correct, but its interface is spread
across several shallow modules:

- `InboundMessageRoutingWorkflow` performs both active and historical thread
  lookups and therefore understands thread lifecycle.
- `InstanceInteractionWorkflow` parses thread-local commands, reloads Worker and
  Binding ownership, invokes Worker messaging, and renders acknowledgements in
  addition to its existing instance-directory responsibilities.
- `WorkerLifecycleActions` knows how `legacy-unpublished` becomes `reserving` and
  how a passive entry is rendered and published.
- `SqliteCardContextStore` knows canonical versus legacy placement and chooses
  the Worker Main delivery target.
- `SqliteOutboxDeliveryStore` knows the complete Worker/Binding/session/pane
  validation query and the mode-specific ACK transition.
- the broad `InstanceStore` exposes Worker Thread persistence methods that most
  instance callers must never use.

The deletion test fails for the current Worker Thread modules: deleting the
thread store would redistribute its state-machine knowledge among these callers
rather than remove that complexity. The refactor must make that knowledge local.

## Chosen architecture

Create two deep modules at two real seams.

### Application module: `WorkerSessionThreadWorkflow`

This module owns all user-facing Worker Thread behavior. Its public interface has
two entry points:

```ts
interface WorkerSessionThreadWorkflowPort {
  handleMessage(message: IncomingLarkMessage): Promise<WorkerThreadRouteResult>;
  publishFromCard(
    action: IncomingLarkCardAction,
    target: WorkerThreadPublicationTarget
  ): Promise<LarkCardActionResult>;
}

type WorkerThreadRouteResult =
  | { handled: false }
  | { handled: true; disposition: "prompt_queued" | "command_completed" | "rejected" };
```

`handleMessage` accepts only the normalized inbound message. It resolves the
scope internally and either owns the message completely or returns
`{ handled: false }`. A known stale root is handled with rejection and never
falls through. Callers do not receive a `WorkerSessionThread` row and do not need
to understand active versus stale lookup order.

`publishFromCard` accepts the verified callback envelope plus a compact target
identity. It reloads all mutable facts, renders the passive legacy entry when
needed, reserves durable publication, wakes delivery, and returns final callback
feedback. The caller does not interpret `legacy-unpublished`, `reserving`,
`active`, or `stale`.

The module hides:

- thread-local command parsing and precedence;
- operator authorization;
- Worker, Worker Session, parent Binding, generation, pane, chat, and lifecycle
  validation;
- ordinary FIFO submission and acknowledgement rendering;
- exact-active-turn resolution for steer and stop;
- passive status and legacy-entry rendering;
- publication idempotency and wake-up decisions;
- stale-root and unavailable-module feedback.

The module depends on three existing real seams: an injected Worker messaging
workflow, outbound intent port, and presentation port. Its SQLite dependency is a
dedicated Worker Thread store port, not `InstanceStore`.

### Persistence module: `SqliteWorkerSessionThreadStore`

This module owns every SQLite transition and query for Worker Session Threads.
Its consumer-shaped interface is:

```ts
interface WorkerSessionThreadStore {
  resolveScope(scope: WorkerThreadScope): WorkerThreadResolution;
  reserveLegacyEntry(request: LegacyEntryRequest): PublicationDecision;
  reserveCanonicalMain(request: CanonicalMainRequest): ProjectionDecision;
}

interface WorkerSessionThreadDeliveryStore {
  settlePublication(receipt: WorkerThreadDeliveryReceipt): SettlementDecision;
}
```

`resolveScope` returns one tagged result:

```ts
type WorkerThreadResolution =
  | { kind: "none" }
  | { kind: "stale"; threadId: string }
  | { kind: "active"; target: ValidatedWorkerThreadTarget };
```

`ValidatedWorkerThreadTarget` contains only facts the application module needs:
Worker ID, Worker Session generation, project ID, runtime generation, parent
identity, mode, and confirmed root. Producing it proves all current ownership
fences in one query. Callers must not reload and reinterpret the same ownership
rules.

`reserveLegacyEntry` reloads and validates the callback identity, Main View, and
placement marker inside one SQLite transaction. It accepts a render callback or
already-rendered bounded card only at this seam and returns a semantic decision:
`reserved`, `pending`, `existing`, or `stale`. It owns the outbox insert and
idempotency key.

`reserveCanonicalMain` is the only operation card-context convergence uses. It
accepts the desired Worker Main View and rendered card, then decides internally
whether to reserve the first group root, wait for an in-flight create, update a
confirmed canonical Main Card, persist a legacy projection at its existing
target, or reject stale ownership. `SqliteCardContextStore` no longer branches on
thread mode or state.

`settlePublication` runs inside the outer outbox ACK transaction. It validates
the frozen outbox/session identity, activates or stales the thread, checkpoints a
canonical Main View only when appropriate, records the root identity, and returns
the projection invalidations to emit. `SqliteOutboxDeliveryStore` does not query
or update `worker_session_threads` directly.

Session termination and instance removal call one persistence operation such as
`retireSession(workerId, workerSessionGeneration, occurredAt)`. The SQL and
historical retention policy remain hidden in the module.

## Seam placement and dependency strategy

SQLite is local-substitutable: production and tests use real temporary SQLite, so
the persistence module is tested through its interface without a mock adapter.
Lark and Herdr remain external ports already represented by existing adapters.
Worker messaging remains an application module injected into the new workflow.

Do not introduce an interface for pure command parsing or card rendering merely
to make them mockable. Keep those as private functions or existing presentation
functions. A seam is justified only for the application workflow and the SQLite
transaction store because both have multiple real consumers/adapters.

## Resulting call graph

```text
InboundMessageRoutingWorkflow
  -> WorkerSessionThreadWorkflow.handleMessage(message)
       -> WorkerSessionThreadStore.resolveScope(scope)
       -> InstanceMessagingWorkflow / OutboundIntentPort

WorkerLifecycleActions
  -> WorkerSessionThreadWorkflow.publishFromCard(action, target)
       -> WorkerSessionThreadStore.reserveLegacyEntry(request)

SqliteCardContextStore
  -> WorkerSessionThreadStore.reserveCanonicalMain(view, card)

SqliteOutboxDeliveryStore
  -> WorkerSessionThreadDeliveryStore.settlePublication(receipt)
```

`InboundMessageRoutingWorkflow` retains only top-level precedence: ask the Worker
Thread module first, then run existing instance/global/Primary routing when it
returns `handled: false`. `InstanceInteractionWorkflow` returns to coordinating
instance directory commands and delegates Worker Thread callbacks rather than
containing their implementation.

## Interface contraction

Remove these Worker Thread methods from the broad `InstanceStore`:

- `reserveWorkerSessionThread`;
- `loadWorkerSessionThread`;
- `findWorkerSessionThreadByScope`.

Remove the separate active and historical lookup methods from
`InboundRoutingStore`. The new workflow's `handleMessage` owns resolution and
returns only whether it handled the message.

The concrete capability graph may share one
`SqliteWorkerSessionThreadStore` instance among the workflow, card-context,
outbox-delivery, lifecycle, and integrity adapters. That sharing is implementation
wiring, not part of the public interface.

## State and transaction invariants

The refactor preserves these rules inside the persistence module:

- `(workerId, workerSessionGeneration)` has at most one thread row.
- `legacy-unpublished` can become `reserving` only through an authorized explicit
  legacy-entry request.
- a post-migration Worker with no placement can reserve `canonical-main` only
  through its first eligible Main projection.
- an attempted or confirmed publication target is immutable.
- publication ACK, outbox settlement, thread activation/staleness, bridge-message
  recording, and canonical Main checkpoint remain one SQLite transaction.
- stale root detection is authoritative and never falls through to another
  conversation route.
- termination or removal preserves historical root identity while making it
  unroutable.
- no storage or projection transition dispatches an Agent prompt.

## Error model

The application module maps internal results to bounded user outcomes:

- missing scope: `handled: false`;
- known but stale scope: handled rejection with guidance to `/instances`;
- reserving publication: accepted/pending notice with failure inspection
  guidance;
- existing publication: idempotent existing notice;
- stale callback or ownership: warning, no outbox row;
- queue full or stopped Worker: existing durable bounded rejection behavior;
- no exact active turn for `/steer` or `/stop`: explicit rejection, never a new
  task;
- delivery uncertainty: retained by outbox recovery and never recreated from the
  application workflow.

Unexpected persistence errors propagate so the durable inbound dispatcher can
retry. Expected user-state errors are rendered and accepted exactly once.

## Test strategy

Replace tests that assert through internal seams with behavior tests at the two
deep-module interfaces.

Application module tests use a fake Worker Thread store plus existing messaging
and outbound ports to prove:

- none, active, and stale routing outcomes;
- ordinary FIFO submission and duplicate acknowledgement;
- `/status`, exact `/steer`, exact `/stop`, and unknown slash rejection;
- fixed-session routing despite a different selected target;
- legacy publication decisions and callback feedback;
- authorization and failure mapping.

Persistence module tests use temporary SQLite to prove:

- canonical and legacy reservation decisions;
- migration to `legacy-unpublished` without outbound writes;
- unique session placement and immutable claimed targets;
- active/stale resolution under every identity fence;
- canonical versus legacy ACK behavior and rollback on checkpoint failure;
- termination/removal retention and integrity;
- retry, duplicate ACK, owner loss, and uncertain delivery behavior.

Keep a small number of integration tests across ingress, card context, and outbox
to prove wiring. Remove direct tests of the old distributed branches after the
new interface tests cover the same behavior. Tests should not query internal
tables except in the dedicated SQLite adapter suite.

## Migration strategy

No database schema migration is required for this structural refactor. Existing
migrations 35 and 36 and their stored data remain unchanged. Move behavior in
small compile-safe slices:

1. introduce the application and persistence interfaces plus tagged results;
2. implement the SQLite methods behind the new persistence interface while old
   callers still exist;
3. move inbound handling and legacy publication into
   `WorkerSessionThreadWorkflow`;
4. replace card-context and ACK SQL branches with persistence method calls;
5. remove Worker Thread methods from `InstanceStore` and `InboundRoutingStore`;
6. replace shallow tests and delete obsolete helpers;
7. run focused and full verification before any install or restart.

At every step, current SQLite rows and outbox claims remain valid. There is no
dual-write period, card recreation, prompt replay, or live migration side effect.

## Acceptance criteria

- `InboundMessageRoutingWorkflow` makes one Worker Thread call and contains no
  lifecycle lookup sequence or thread-specific user copy.
- `InstanceInteractionWorkflow` contains no thread-local command parsing.
- `WorkerLifecycleActions` contains no `legacy-unpublished` or publication-state
  branching.
- `SqliteCardContextStore` contains no canonical/legacy thread state machine.
- `SqliteOutboxDeliveryStore` contains no direct SQL against
  `worker_session_threads`.
- `InstanceStore` and `InboundRoutingStore` no longer expose Worker Thread
  persistence details.
- Worker Thread behavior and durability remain unchanged under focused and full
  regression tests.
- `npm run typecheck`, `npm run build`, `npm test`, architecture checks, and
  `git diff --check` pass before handoff.

## Non-goals

- Changing user-visible Worker Thread semantics.
- Unifying Primary aliases and Worker threads into one generic conversation
  aggregate.
- Changing migrations 35/36 or rewriting deployed thread rows.
- Changing FIFO, exact-turn control, no-replay, CardKit pagination, or outbox
  retry behavior.
- Installing, restarting, publishing, tagging, or pushing as part of the
  refactor.
