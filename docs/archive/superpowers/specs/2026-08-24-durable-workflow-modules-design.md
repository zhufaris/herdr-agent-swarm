# Durable Workflow Modules Architecture

## Status

Approved implementation direction. This specification turns the target in
`docs/architecture.md` into an incremental migration contract. It supersedes
the remaining-slices section of the earlier workflow-worker design; the prompt
execution extraction described there is already implemented.

## Reader and outcome

This document is for an engineer implementing or reviewing the coordinator
migration. After reading it, they should be able to extract one workflow, define
its smallest useful persistence interface, and verify that durability, recovery,
and user-visible behavior have not changed.

## Context

The `ext` branch already has two important seams:

- `PromptExecutionWorkflow` owns FIFO prompt execution, steering, detached
  observation, and prompt-specific shutdown;
- `WorkflowWakeupBus` provides coalesced, process-local scheduling hints; and
- `PromptExecutionStore` limits prompt execution to the persistence operations
  it needs.

`SyncCoordinator` still owns inbound draining, command routing, binding
provisioning, session operations, and several presentation concerns. Most other
modules still depend on the broad `BindingStorePort`. `BridgeEventBus` also
combines lifecycle publication with inbound-message notification. Finally, most
prompt lifecycle projections are updated after the durable state transition, so
a crash can leave a stale card view even though the prompt state is correct.

## Goals

- Establish deep application modules with small, capability-oriented interfaces.
- Leave `InboundRouter` responsible only for durable ingress and command routing.
- Make Herdr reconciliation, provisioning, operations, projection, and outbound
  delivery independently testable through their interfaces.
- Separate lifecycle publication, ingress notification, and prompt scheduling.
- Preserve SQLite as the durable workflow authority and Herdr as runtime truth.
- Make every user-visible lifecycle projection transactional or reconstructible.
- Persist the Lark outbox lane key used for ordered delivery and expose lane
  backlog diagnostics.
- Preserve all current commands, CardKit output, recovery rules, and safety
  invariants throughout the migration.

## Non-goals

- Replacing SQLite, Herdr, Lark, systemd, or the plugin operator surface.
- Introducing an external broker or a durable wake-up event stream.
- Splitting the concrete SQLite store into multiple database owners.
- Replaying a prompt after dispatch may have reached TraeX.
- Adding remote approval, pane kill, or new Lark commands.
- Adding an `answer_pages` table without a concrete page-level recovery need.
- Rewriting pure CardKit renderers or changing visible card copy.

## Architectural rules

### Authority

SQLite owns workflow intent and checkpoints. Herdr owns pane and agent runtime
facts. Lark owns only delivered presentation. A module may reconcile SQLite from
Herdr observation, but it must never reconstruct workflow state from a Lark card.

### Dependency direction

Domain contracts do not import coordinators, adapters, SQLite, or Lark SDK
types. Application workflows depend on domain ports. Adapters and the SQLite
store implement those ports. `main` remains the composition root and owns
startup and shutdown order.

### Durable-before-wake

Every prompt-work producer commits SQLite before invoking `PromptWorkScheduler`.
Wake-ups contain identity only, may be lost or duplicated, and are never proof
that work exists. A worker always reloads SQLite and atomically claims work.
Startup and periodic reconciliation remain the convergence backstop.

### Atomic transitions

Capability ports are not table repositories. They expose workflow-sized atomic
operations. Narrowing an interface must not turn one SQLite transaction into a
read-modify-write sequence spread across modules.

## Target modules and interfaces

### InboundRouter

`InboundRouter` accepts normalized Lark messages and card actions, durably
records messages before processing, parses commands, and delegates to the
appropriate workflow. It does not create panes, execute prompts, reconcile
Herdr, render operation cards, or drain the Lark outbox.

Its external interface is:

```ts
interface InboundRouterPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleMessage(message: IncomingLarkMessage): Promise<void>;
  handleCardAction(action: IncomingLarkCardAction): Promise<void>;
}
```

Inbound notification is a separate `InboundWorkNotifier` interface. It cannot
share the lifecycle event contract even if both adapters use `EventEmitter`.

### PromptRunWorkflow and PromptWorkScheduler

The implemented `PromptExecutionWorkflow` becomes `PromptRunWorkflow`;
`PromptExecutionStore` becomes `PromptRunStore`. The rename happens together so
the code and architecture use one vocabulary. No behavior changes in this slice.

`WorkflowWakeupBus` remains the in-process adapter, but consumers depend on:

```ts
interface PromptWorkScheduler {
  subscribe(listener: (work: PromptWorkHint) => void | Promise<void>): () => void;
  wake(work: PromptWorkHint): void;
}
```

The interface makes the best-effort contract explicit. It has no `await idle`,
acknowledgement, retry, or payload-bearing command method.

### BindingProvisioningWorkflow

This workflow owns create, project selection, discovered-pane binding, attach,
replace, reset, and interrupted-provisioning recovery. It validates project,
workspace, cwd, pane identity, and terminal identity before a binding changes.
It requests atomic transitions through `BindingProvisioningStore` and publishes
lifecycle outcomes after commit. It never runs an accepted prompt.

The module hides checkpoints and recovery branches behind a small interface:

```ts
interface BindingProvisioningWorkflowPort {
  selectProject(command: NewSessionCommand): Promise<void>;
  completeSelection(action: ProjectSelectionAction): Promise<void>;
  attach(command: AttachCommand): Promise<void>;
  reset(command: ResetCommand): Promise<void>;
  discover(pane: HerdrPane, project: ProjectConfig): Promise<Binding>;
  recover(): Promise<void>;
}
```

### OperationsWorkflow

This workflow owns close confirmation and recovery, archive/resume, rename,
model selection, space/session/failure views, and dead-letter retry or dismissal.
It depends on `OperationsStore`, Herdr operation capabilities, an outbound-intent
port, and pure renderers. It cannot dispatch ordinary prompts.

Operations that can affect a live pane revalidate the current Herdr observation
immediately before the effect. High-risk TraeX approval remains unavailable.

### HerdrRuntimeReconciler

The implemented `SessionReconciler` becomes `HerdrRuntimeReconciler`. It is the
only module that converges periodic and plugin-triggered Herdr observations. It
requests atomic binding transitions, publishes lifecycle outcomes, and wakes
prompt work. It cannot call prompt-worker internals or deliver Lark cards.

### LifecycleEventPublisher and ConversationViewProjector

`LifecycleEventPublisher` distributes lifecycle outcomes only. It has no inbound
message channel. `ConversationViewProjector` deterministically reduces lifecycle
outcomes into topic/run-card read models and records Lark delivery intent.

For every user-visible lifecycle transition, one of these conditions must hold:

1. aggregate state, projection, and outbox intent are committed atomically; or
2. the projection can be rebuilt deterministically from durable aggregate state.

The implementation will use a transactional projection checkpoint for finite
state changes and aggregate reconstruction for transient output snapshots. The
existing `lifecycle_events` table remains an audit aid and is not advertised as
a complete event-sourcing log.

### LarkOutboxDispatcher

The implemented publisher becomes `LarkOutboxDispatcher`. It owns only durable
outbox delivery, retry scheduling, dead letters, and delivery checkpoints.
Callers use an `OutboundIntentPort`; only the dispatcher uses `OutboxStore`.

Each outbox row persists a `lane_key` when inserted. Delivery order is strictly
serial within a lane and concurrent across lanes. Existing rows are migrated
idempotently using the same deterministic lane calculation used today. Status
reports total ready, retrying, and dead-letter rows plus blocked-lane count and
oldest lane-head age; they never include payloads.

### LeaseStore

The instance lease depends only on `LeaseStore`. Fencing stays implemented by
the same SQLite connection and applies to every state-changing capability.
Interface extraction must not weaken the existing write fence.

## Capability store map

| Port | Consumer | Responsibility |
| --- | --- | --- |
| `InboundStore` | `InboundRouter` | record, claim, accept, release, and recover inbound work; identify bridge messages |
| `PromptAcceptanceStore` | prompt acceptance command handler | queue-depth check and atomic prompt/card/outbox acceptance |
| `PromptRunStore` | `PromptRunWorkflow` | FIFO claims, steering claims, dispatch checkpoints, detached observation, prompt completion |
| `BindingProvisioningStore` | `BindingProvisioningWorkflow` | project-selection and binding provisioning checkpoints and atomic transitions |
| `OperationsStore` | `OperationsWorkflow` | operational queries, close requests, binding operations, audit, dead-letter actions |
| `RuntimeReconciliationStore` | `HerdrRuntimeReconciler` | bindings/runtime reads and atomic convergence transitions |
| `ProjectionStore` | `ConversationViewProjector` | read-model load/save/rebuild and projection checkpoints |
| `OutboundIntentPort` | application workflows and projector | atomic enqueue of delivery intent without delivery controls |
| `OutboxStore` | `LarkOutboxDispatcher` | lane-head claims, checkpoints, retries, dead letters, diagnostics |
| `LeaseStore` | instance lease | acquire, renew, release, and activate/deactivate fencing |

One `SqliteBindingStore` may implement all ports. The design optimizes caller
knowledge and transaction locality, not class count.

## Runtime flow

1. Lark ingress normalizes and allowlists an input.
2. `InboundRouter` persists it and emits an inbound-work notification.
3. The router claims the durable input, parses it, and calls one workflow.
4. The workflow commits its aggregate transition and outbound intent.
5. Prompt-producing work invokes `PromptWorkScheduler` after commit.
6. `PromptRunWorkflow` reloads and atomically claims eligible SQLite work.
7. Herdr execution or reconciliation records durable lifecycle results.
8. `ConversationViewProjector` converges read models and outbound intent.
9. `LarkOutboxDispatcher` drains lane heads and checkpoints delivery.
10. Delivery checkpoints may wake prompt work, but never dispatch it directly.

## Startup and shutdown

Startup order is store migration, lease/fence, lifecycle projection, outbox
dispatcher, prompt scheduler/workflow, durable recovery, initial reconciliation,
Lark ingress, then plugin hints. No external input is accepted before recovery
has identified detached prompt observation.

Shutdown stops Lark ingress and plugin hints first. It then stops reconciliation,
inbound work, scheduler intake, prompt workers/observers, projector, dispatcher,
lease heartbeat, and store. If grace expires, uncertain prompt observers are
detached and persisted; they are never replayed.

## Failure semantics

- Lost or duplicate work hints change latency only.
- A crash before durable acceptance leaves no executable prompt.
- A crash after durable acceptance but before wake-up is recovered by scans.
- A crash after possible TraeX dispatch leaves detached observation and forbids
  automatic replay.
- A lifecycle projection failure leaves durable aggregate state intact and is
  repaired by projection convergence before its lane can advance.
- Lark failures retry only outbox rows. They never repeat a workflow command.
- A dead lane blocks only itself; independent lanes continue.
- Lease loss stops ingress and all state-changing workers before store close.

## Migration strategy

The migration is vertical and behavior-preserving. Each slice establishes one
usable seam, migrates its callers, adds focused tests, and removes the old path.
There are no compatibility wrappers after a consumer has moved. The concrete
SQLite store stays shared so cross-row transactions remain local.

Renames are bundled with the slice that establishes the corresponding interface.
This avoids a repository-wide rename that provides no architectural leverage.

## Acceptance criteria

- `SyncCoordinator` no longer exists; `InboundRouter` has no Herdr execution,
  provisioning, operations, projection, or outbox-drain implementation.
- Every application module accepts only its capability ports.
- Lifecycle, inbound, and scheduling interfaces are distinct.
- A prompt cannot dispatch before durable acceptance and Answer-card readiness.
- Lost wake-ups converge through startup or periodic scans.
- User-visible lifecycle state is transactional or reconstructible after crash.
- `lane_key` is persisted and lane diagnostics are available in sanitized status.
- Existing databases migrate idempotently without copying or recreating them.
- Existing command behavior, CardKit rendering, and safety rules do not change.
- Focused tests, the full test suite, typecheck, and build pass.

## Implementation outcome

The migration is implemented. The final completion audit found and closed one
additional composition gap: `InboundRouter` had stopped owning workflow logic
but still instantiated the concrete workflows and contained startup projection
repair. Concrete construction now lives in `main`; `InboundRouter` accepts
workflow/control ports, and `StartupViewConverger` owns deterministic startup
view repair. A structural test protects this dependency direction and also
ensures lifecycle publishers/subscribers remain behind their ports.

## Deferred decisions

- A durable cross-process scheduler is deferred until multiple bridge processes
  or external consumers are required.
- A separate SQLite class or database per capability is deferred until ownership
  or scale requires it.
- Explicit Answer-page entities remain deferred.
- A complete event-sourcing log is not required; reconstructible projections are
  sufficient for recovery.
