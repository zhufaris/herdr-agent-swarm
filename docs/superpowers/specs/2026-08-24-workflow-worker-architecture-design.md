# Workflow and Event-Driven Worker Architecture

## Status

Approved direction. This document defines the first migration from the current
monolithic coordinator toward capability-focused workflows and event-driven
workers. SQLite remains the durable workflow authority. In-memory events are
only wake-up hints.

## Problem

`SyncCoordinator` currently owns inbound routing, binding provisioning, prompt
acceptance, ordinary-turn execution, steering, detached observation, recovery,
operations, and shutdown coordination. Its broad `BindingStorePort` dependency
allows every responsibility to reach nearly the entire persistence surface.

The current direct scheduling calls are correct but increasingly coupled:
prompt acceptance, Answer-card delivery, Herdr reconciliation, and startup
recovery each need to know which worker method to call. Adding another wake-up
source therefore changes the coordinator rather than only publishing a signal.

SQLite is not the problem. It is required for FIFO ordering, idempotency,
uncertain-dispatch safety, recovery, projections, the outbox, and the instance
lease. The problem is that durable state ownership and execution scheduling are
not separated into explicit application modules.

## Goals

- Split the application into workflows with narrow capability dependencies.
- Drive prompt execution through coalesced wake-up events for low latency.
- Keep correctness independent of event delivery.
- Preserve one ordinary turn per binding and FIFO ordering.
- Preserve priority steering and exact `/stop` semantics.
- Never replay a prompt after it may have reached TraeX.
- Make startup, reconciliation, and shutdown behavior explicit and testable.
- Migrate incrementally without changing the SQLite schema or visible Lark
  behavior in the first slice.

## Non-goals

- Replacing SQLite with an in-memory queue or external message broker.
- Treating Herdr plugin events as an authoritative event history.
- Splitting `SqliteBindingStore` into multiple database connections or classes
  in the first slice.
- Changing CardKit rendering, pagination, outbox ordering, or retry semantics.
- Extracting every coordinator responsibility in one change.
- Adding remote process termination or remote high-risk approval.

## Chosen architecture

The target combines capability-focused workflow modules with event-driven
workers. Producers first commit durable intent to SQLite, then emit a wake-up.
Workers respond by querying SQLite and atomically claiming eligible work.

```text
Lark ingress       Answer delivery       Herdr reconcile       startup recovery
     |                    |                     |                      |
     +---- durable state transition in SQLite -----------------------+
                                  |
                                  v
                         WorkflowWakeupBus
                     best effort, coalesced hints
                                  |
                                  v
                       PromptExecutionWorkflow
                   query + atomic claim from SQLite
                     /             |             \
             ordinary turn     steering     detached observer
                     \             |             /
                      durable lifecycle results
                                  |
                                  v
                       BridgeEventBus -> views
                                  |
                                  v
                         SQLite outbox -> Lark
```

The wake-up bus never carries prompt text or authoritative workflow state. A
wake-up identifies the smallest useful scope, while the worker reloads current
facts from SQLite before acting. Duplicate, reordered, or missing wake-ups are
safe.

## Event roles

The system keeps two deliberately separate event concepts.

### Domain lifecycle events

`BridgeEventBus` continues to publish durable workflow outcomes such as
`PromptQueued`, `TurnStarted`, `TurnCompleted`, and binding state changes. These
events feed deterministic run-card and topic projections. They are presentation
and lifecycle events, not commands to execute work.

### Workflow wake-ups

A new `WorkflowWakeupBus` signals that durable state may now be actionable. Its
initial event union is:

```ts
type WorkflowWakeup =
  | { kind: "prompt-ready"; bindingId: string }
  | { kind: "steering-ready"; bindingId: string; parentPromptId: string }
  | { kind: "detached-observer-ready"; bindingId: string; promptId: string }
  | { kind: "binding-runtime-changed"; bindingId: string };
```

The bus is process-local, bounded by the number of active binding keys, and
coalesces redundant signals. Publishers do not wait for a full TraeX turn to
finish. Listener failures are logged and followed by later recovery scans.

`answer-card-ready` is not a distinct long-term work type. Successful Answer
card creation publishes `prompt-ready`; the workflow then checks whether the
prompt is queued and dispatchable. This keeps Lark-specific concepts outside
the execution workflow.

## Durable-before-wake contract

Every producer follows this order:

1. Perform the durable SQLite transition.
2. Commit the transaction.
3. Publish the scoped wake-up.
4. Return without assuming that the wake-up was received.

Publishing before commit is forbidden because a worker could observe no work
and the only low-latency hint would be consumed prematurely. When a producer
cannot publish after commit, the work remains recoverable through startup scan
or reconciliation.

The first slice does not add a transactional event outbox for wake-ups. That
would duplicate durable job state without improving correctness. If future
workers require cross-process consumers, a durable dispatcher can be designed
separately.

## PromptExecutionWorkflow

`PromptExecutionWorkflow` owns all prompt execution policy and in-memory
execution state:

- one ordinary worker per binding;
- steering serialization per binding and parent turn;
- `TurnSupervisor`;
- ordinary FIFO claiming and execution;
- priority steering and `/stop` handling after acceptance;
- detached observer attachment and completion detection;
- queue-position refreshes;
- shutdown grace and observer detachment;
- prompt-specific startup recovery.

Its public surface is intentionally small:

```ts
interface PromptExecutionWorkflowPort {
  start(): Promise<void>;
  wake(event: WorkflowWakeup): void;
  stop(): Promise<void>;
  isBindingBusy(bindingId: string): boolean;
  activeTurn(bindingId: string): ActiveTurnSnapshot | null;
}
```

Prompt acceptance remains an inbound/application command in the first slice. It
uses `activeTurn` only to decide whether eligible text becomes steering, commits
the prompt and Answer-card intent atomically, publishes lifecycle events, then
emits the relevant wake-up. This avoids moving Lark command parsing into the
execution workflow.

The workflow owns execution after durable acceptance. `SyncCoordinator` and
`SessionReconciler` must no longer call `scheduleWorker`, `scheduleSteering`, or
detached-observer methods directly.

## Capability-focused ports

The first slice introduces interfaces based on consumer needs rather than one
interface per SQL table. `SqliteBindingStore` implements them structurally and
remains one transactional component.

`PromptExecutionStore` contains only the reads and transitions needed by prompt
execution, including binding eligibility, prompt claims, dispatch checkpoints,
detached state, queue convergence, run-card reads, and queue-position support.

`PromptAcceptanceStore` contains the atomic acceptance transition, queue-depth
checks, binding lookup required by inbound routing, and audit recording.

`ProjectionStore`, `OutboundStore`, `BindingProvisioningStore`,
`OperationsStore`, and `LeaseStore` are target capabilities. They are introduced
when their owning workflow is extracted, not all at once. Existing consumers may
temporarily retain `BindingStorePort`, but new workflow constructors must not
accept it.

The capability interfaces describe operations, not raw repositories. Atomic
methods such as `acceptPrompt` and claim/update transitions remain intact so the
refactor cannot accidentally split a transaction across modules.

## Scheduling and convergence

### Ordinary prompts

After `acceptPrompt` commits, ingress emits `prompt-ready`. The workflow
coalesces by binding, starts at most one drain for that binding, and repeatedly
calls `claimNextDispatchablePrompt`. SQLite remains responsible for FIFO and
eligibility. A wake-up does not name the prompt to dispatch.

### Steering

After steering acceptance commits, ingress emits `steering-ready` with the
parent prompt ID. The workflow verifies the currently supervised turn, then
claims ready steering from SQLite. Duplicate wake-ups cannot duplicate delivery
because the claim transition is atomic. Exact `/stop` retains its current rule:
if the parent is no longer working it fails and never falls back to FIFO; normal
steering may be requeued as a turn.

### Answer-card readiness

An ordinary prompt cannot dispatch until its initial Answer card is ready. The
publisher durably records successful CardKit creation, then emits
`prompt-ready`. The workflow rechecks the prompt and its delivery checkpoint via
the claim operation. A publisher retry therefore wakes the queue immediately,
while a lost wake-up is recovered later.

### Detached observation

On startup, running prompts are durably marked detached. The workflow scans
them and emits or directly enqueues coalesced `detached-observer-ready` work. It
observes the existing TraeX process and never calls `runPrompt` for that job. A
failed or interrupted observer leaves the prompt detached for a later
reconciliation cycle.

### Reconciliation

`SessionReconciler` remains the single Herdr convergence path. After updating
durable binding/runtime state, it emits `binding-runtime-changed` and, where a
queue may have become eligible, `prompt-ready`. The prompt workflow decides what
can run. Reconciliation does not call worker internals.

Periodic reconciliation also performs a bounded scan of active bindings with
queued work and detached prompts. This is the correctness backstop for missing
process-local wake-ups. It must not perform prompt delivery itself.

## Failure and race handling

- Duplicate wake-up: coalesced or reduced to an empty atomic claim.
- Wake-up before another wake-up: current SQLite state determines the outcome.
- Wake-up lost after commit: startup or periodic reconciliation emits another.
- Worker crashes before dispatch checkpoint: existing claim/recovery semantics
  determine whether the prompt can return to the queue.
- Worker fails after dispatch may have occurred: mark the observer detached and
  never replay automatically.
- Answer-card delivery fails: outbox retry owns retry timing; prompt execution
  cannot bypass the card-readiness gate.
- Binding becomes inactive during work: worker stops, preserves uncertain work,
  and lets lifecycle/reconciliation converge the remainder.
- Shutdown begins: reject new scheduling, stop subscriptions, wait for workers,
  then abort observers after the grace period and persist detached notices.

## Startup and shutdown order

Startup ordering for the migrated slice is:

1. Acquire the instance lease and activate the SQLite write fence.
2. Start projection and outbound delivery components.
3. Construct and subscribe `PromptExecutionWorkflow` to wake-ups.
4. Recover running prompts to detached state.
5. Establish Herdr baselines and reconcile.
6. Recover inbound and provisioning work.
7. Scan durable prompt work and wake eligible workers.
8. Start Lark ingress and activate external Herdr event hints.

Shutdown stops ingress and external hints first, then reconciliation, workflow
wake-up intake, prompt workers/observers, projections, publisher, lease, and
store. The exact component ordering remains owned by `BridgeRuntimeShutdown`.

## Migration sequence

### Slice 1: prompt workflow and wake-up bus

- Add `WorkflowWakeupBus` and its typed, coalesced signals.
- Add `PromptExecutionStore` and `PromptExecutionWorkflow`.
- Move ordinary workers, steering workers, detached observation,
  `TurnSupervisor`, and prompt shutdown logic from `SyncCoordinator`.
- Replace publisher callbacks and reconciler scheduling callbacks with wake-ups.
- Retain existing SQLite schema and atomic methods.
- Preserve current public `SyncCoordinator` constructor where practical through
  composition, limiting test churn.

### Slice 2: binding provisioning workflow

Extract create, attach, replace, reset, discovered-pane provisioning, and
checkpoint recovery behind `BindingProvisioningStore`. It publishes durable
binding changes and workflow wake-ups but does not execute prompts.

### Slice 3: session operations workflow

Extract close, resume, rename, model operations, lists, failures, and dead-letter
operator actions behind `OperationsStore`.

### Slice 4: inbound router and outbound delivery workflow

Reduce `SyncCoordinator` to ingress normalization and command routing, or rename
it to `InboundRouter`. Move Lark outbox draining, retries, and dead-letter
delivery behind `OutboundStore` and `OutboundDeliveryWorkflow`.

### Slice 5: remove the broad store port

Once every consumer has a capability interface, delete `BindingStorePort`. Keep
`SqliteBindingStore` as the concrete implementation until database scale or
ownership provides a reason to split it.

## Testing strategy

The first slice requires focused unit tests for wake-up coalescing and workflow
lifecycle, plus integration tests using temporary SQLite databases. Required
cases are:

- multiple `prompt-ready` events still run one FIFO worker per binding;
- independent bindings can progress concurrently;
- a lost initial wake-up is recovered by a durable scan;
- Answer-card success after an outbox retry wakes the queued prompt;
- duplicate steering wake-ups deliver each claimed steering prompt once;
- `/stop` never falls back to an ordinary prompt;
- a post-dispatch failure becomes detached and is not replayed;
- startup observes detached work without submitting it again;
- reconciliation wakes newly eligible durable work;
- shutdown persists detached observation before completing.

Before handoff, run affected Vitest files, `npm run typecheck`, `npm test`, and
`npm run build`. A real-user smoke test is optional because this refactor must
not require sending Lark messages.

## Acceptance criteria

- `SyncCoordinator` contains no ordinary-turn drain, steering drain, detached
  observer, worker maps, or `TurnSupervisor`.
- `PromptExecutionWorkflow` depends on `PromptExecutionStore`, not
  `BindingStorePort`.
- Prompt-producing paths commit SQLite state before publishing wake-ups.
- Publisher and reconciler do not call prompt worker scheduling methods.
- Losing every wake-up still converges through startup and periodic scans.
- Existing user-visible card behavior and prompt safety invariants remain
  unchanged.
- The full test suite, typecheck, and build succeed.

## Deferred decisions

- A durable cross-process wake-up outbox is deferred until there is more than
  one application process or an external worker.
- Explicit `answer_pages` storage remains a separate delivery-model change.
- Persisted outbox lane identity remains a separate schema evolution.
- Splitting the concrete SQLite store is deferred until capability interfaces
  reveal stable ownership boundaries.
