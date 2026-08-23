# Session Reconciler Module Design

## Goal

Extract Herdr observation and reconciliation from `SyncCoordinator` into a deep
`SessionReconciler` module. The extraction reduces the coordinator's state and
responsibilities while preserving every externally visible lifecycle, queue,
card, and recovery behavior.

This change follows the query optimization introduced in `9b8ad46`. It is a
structural refactor, not a new reconciliation policy.

## Module seam

Create `src/coordinator/session-reconciler.ts`. Its public interface is:

```ts
interface SessionReconciler {
  captureBaselines(): Promise<void>;
  reconcile(): Promise<void>;
  start(intervalMs: number): void;
  stop(): Promise<void>;
}
```

The interface hides workspace scanning, single-flight coordination, timer
ownership, Pane identity checks, observation snapshots, missing-Pane handling,
and skipped-Pane log suppression. Callers do not manipulate those mechanisms.

Construction accepts existing ports and two narrow collaborators:

- `discoverPane(pane, project)` creates the durable binding and Feishu topic for
  a newly discovered registered Pane, then returns the created binding.
- `scheduleBinding(bindingId)` starts or wakes prompt processing for an active
  binding.

The reconciler also receives the event bus, publisher, project configuration,
and logger because reconciliation directly persists lifecycle observations and
publishes the same events and cards as today. These are implementation
dependencies, not additional public methods.

## Ownership

`SessionReconciler` exclusively owns:

- the reconciliation timer;
- the in-flight reconciliation Promise used for single-flight behavior;
- observed agent state by Pane;
- observed terminal output by Pane;
- skipped-Pane reason signatures;
- workspace Pane scans and pass-local binding maps;
- initial terminal baseline capture;
- changed local-output publication;
- missing-Pane degradation, orphaning, and affected run-card transitions.

`SyncCoordinator` continues to own:

- inbound Lark message serialization and command dispatch;
- provisioning sagas and explicit attach/replace operations;
- prompt and steering workers, active runs, and queue positions;
- startup recovery ordering and graceful shutdown orchestration;
- shared event construction and publication used outside reconciliation.

The reconciler must not own prompt execution or user commands. This keeps the
module deep and prevents it from becoming a second coordinator.

## Startup and shutdown

Startup keeps its existing ordering:

1. Recover interrupted durable state and normalize stored views.
2. Assert configured workspaces.
3. Call `captureBaselines()`.
4. Call `reconcile()` once.
5. Call `start(reconcileIntervalMs)`.
6. Start Lark input, recover provisioning, drain outbox/inbound work, and
   schedule active bindings.

`start()` is idempotent and creates at most one unreferenced timer. Timer ticks
call the same single-flight `reconcile()` method and log failures without
terminating the process.

`stop()` is idempotent, prevents new passes, clears the timer, and awaits the
shared in-flight reconciliation Promise. It does not abort Herdr commands, close
Panes, or manage prompt workers. `SyncCoordinator.stop()` first stops Lark input,
then stops the reconciler as part of its existing graceful wait set, and only
the coordinator may abort active prompt waiters after the shutdown grace period.

## Reconciliation flow

One pass performs the existing sequence:

1. Drain durable outbound work.
2. List Panes once per configured workspace, isolating workspace failures.
3. Load active bindings once and reconcile missing or unavailable Panes.
4. Match discovered TraeX Panes against the pass-local binding-by-Pane map.
5. Skip unregistered, ambiguous, or interrupted-provisioning Panes using the
   existing reason signatures and log suppression.
6. Discover new registered Panes through `discoverPane`, then update the local
   map immediately.
7. Validate terminal identity and publish agent/output changes for existing
   bindings that do not have an active coordinator worker.
8. Refresh skipped-Pane signatures and schedule all currently active bindings
   from a fresh scoped store query.

The module uses `getBinding`, `listBindingsByState`, and
`listRunCardsByPhases`; it must not reintroduce full-list point lookups.

## Coordinator collaboration

The reconciler needs to know whether a binding currently has an active prompt
worker so it does not duplicate terminal observation. Instead of receiving the
coordinator's mutable worker map, construction receives
`isBindingBusy(bindingId): boolean`. This keeps worker representation private.

`scheduleBinding` is fire-and-forget from the reconciler's perspective, matching
the existing `scheduleWorker` behavior. `discoverPane` returns a binding so the
reconciler can update its pass-local map without querying again.

Event creation remains local to the reconciler for events it owns. Both modules
use a shared pure `createBridgeEvent(...)` helper rather than exposing a generic
callback from the coordinator. This avoids a shallow pass-through interface and
keeps event IDs and timestamps consistent.

## Error behavior

- A workspace listing failure degrades only bindings in that workspace, exactly
  as today.
- A failed discovered-Pane creation rejects the current pass and is logged by
  the existing outer reconciliation handler. Durable provisioning checkpoints
  remain the recovery source of truth.
- A terminal read failure follows the existing degradation/orphan threshold.
- A card or event publication failure retains current durable outbox behavior.
- No running or queued prompt is replayed by reconciliation.

## Tests

Add direct `SessionReconciler` tests for:

- overlapping calls sharing one pass;
- timer start/stop idempotence and stop awaiting an in-flight pass;
- one workspace scan per pass;
- pass-local Pane matching and map update after discovery;
- missing-Pane run-card transitions through one scoped query;
- workspace-unavailable degradation;
- terminal identity replacement becoming orphaned;
- unchanged skipped-Pane logs being emitted once;
- local output changes being emitted while idle;
- worker-busy bindings not being observed twice.

Existing integration tests remain as behavior-level coverage through
`SyncCoordinator`. Tests should migrate implementation-specific assertions to
the reconciler test file rather than duplicate them.

Verification requires focused reconciler, lifecycle, discovery, concurrency,
projector, and store tests followed by the complete suite, typecheck, build, and
`git diff --check`. Deployment remains gated on zero running prompts and zero
pending outbox rows.

## Non-goals

- No command-routing extraction.
- No prompt/steering worker extraction.
- No changes to Lark cards, streaming content, parser behavior, queue ordering,
  lifecycle transitions, or provisioning recovery.
- No new cross-process cache or background worker.
- No modification or replay of historical queued prompts or dead letters.
