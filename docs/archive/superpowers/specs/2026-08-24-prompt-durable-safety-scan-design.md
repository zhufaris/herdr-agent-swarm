# Prompt Durable Safety Scan

## Status

Approved design direction. This change moves durable prompt-queue convergence
from Herdr runtime reconciliation into the prompt workflow that owns dispatch
and detached observation.

## Reader and outcome

This document is for maintainers changing prompt scheduling, recovery, or Herdr
reconciliation. After reading it, they should understand how queued and detached
prompt work converges after a lost process-local wake without treating a wake as
durable state or replaying an uncertain TraeX request.

## Problem

`PromptRunWorkflow.start()` scans durable prompt state once, but later lost
`PromptWorkScheduler` hints are repaired only because
`HerdrRuntimeReconciler` periodically performs a Herdr snapshot and then wakes
every active binding and detached prompt. The reconciler also calls
`convergePromptBacklog()`, even though cancelling prompts attached to terminal
bindings is a SQLite-only decision.

This couples prompt-queue liveness to an external runtime scan. A slow or failed
Herdr snapshot can delay work whose eligibility is already fully represented in
SQLite, and the runtime reconciler must know prompt scheduling details outside
its module.

## Decision

`PromptRunWorkflow` will own a startup scan and a periodic safety scan over
durable prompt work. The scan publishes identity-only hints through the existing
`PromptWorkScheduler`; workers still reload SQLite and atomically claim work.
The scan is a convergence backstop, not a second queue and not proof that a
prompt is dispatchable.

`HerdrRuntimeReconciler` remains responsible for pane existence, terminal
identity, agent state, runtime-output observation, and state-change-triggered
wakes. It will no longer perform the blanket end-of-reconciliation prompt scan
or SQLite-only backlog convergence.

## Deep persistence seam

The prompt workflow will use one workflow-sized store operation instead of
assembling durable work from broad table-oriented reads:

```ts
interface DurablePromptWorkScan {
  cancelled: number;
  hints: PromptWorkHint[];
}

scanDurablePromptWork(): DurablePromptWorkScan;
```

The SQLite implementation performs one transaction that:

1. cancels queued prompts whose binding can no longer dispatch and updates their
   run-card projections, preserving the current `convergePromptBacklog` behavior;
2. selects active bindings that have queued ordinary turns and no running
   prompt;
3. selects queued steering prompts whose parent is still the active running
   turn; and
4. selects running ordinary prompts with detached observation.

It returns only scheduler identities: kind, binding ID, and where required parent
or prompt ID. It does not return prompt bodies, card state, errors, pane output,
or Lark identifiers. Duplicate hints are removed before returning. Hints are
ordered by recovery priority: detached observers first, then steering for their
active parent, then ordinary queued turns. This prevents an ordinary no-op
worker from occupying the per-binding worker slot before uncertain work is
reattached.

The operation does not claim a prompt. Existing claim methods remain the only
dispatch authority, including the initial Answer Card delivery checkpoint and
one-ordinary-turn-per-binding rules.

## Scan lifecycle

`PromptRunWorkflow.start()` subscribes to the scheduler first, performs an
immediate durable scan, then installs one unreferenced periodic timer. The default
safety interval is five seconds and is an internal runtime constant for this
change; tests may inject a shorter interval. The SQLite operation is synchronous
and bounded, so JavaScript event-loop execution prevents concurrent scan reentry;
no additional scan queue or coalescing state is introduced.

Each successful scan publishes all returned hints after the SQLite transaction
commits. A failed scan emits one structured error and waits for the next safety
tick or explicit request. It does not stop an already running turn and does not
change readiness.

`stop()` prevents new scans, cancels the timer, and unsubscribes from scheduler
hints before applying the existing worker shutdown rules. A wake or timer
callback after stopping is ignored.

The workflow exposes synchronous `requestSafetyScan()` for startup, tests, and
explicit recovery tooling. Ordinary producers continue to call
`PromptWorkScheduler.wake` after durable state changes; they do not synchronously
invoke a scan.

## Interaction with Herdr reconciliation

Runtime changes still need immediate targeted wakes. For example, when a pane
moves from blocked to idle, `HerdrRuntimeReconciler` emits
`binding-runtime-changed` or `prompt-ready` after persisting the observation.
The safety scan does not replace that low-latency path.

The reconciler removes only these prompt-backlog responsibilities:

- `convergePromptBacklog()` at the start of each runtime scan;
- waking every active binding at the end of each runtime scan; and
- enumerating every detached prompt at the end of each runtime scan.

Its capability port therefore drops the corresponding SQLite methods when they
have no remaining runtime use. Targeted runtime-change wakes and queue-depth
reads used for lifecycle projection remain.

## Diagnostics

`PromptRunWorkflow.snapshot()` exposes bounded process-local diagnostics through
`/status`:

```ts
interface PromptWorkerDiagnostics {
  state: "idle" | "running" | "stopping";
  activeTurnWorkers: number;
  activeSteeringWorkers: number;
  lastScanAt: string | null;
  lastScanOutcome: "idle" | "work_found" | "failed" | null;
  lastDiscovered: { turns: number; steering: number; detached: number; cancelled: number };
  lastScanFailureAt: string | null;
}
```

Counts describe only the most recently completed scan and reset on restart. No
identifiers or failure text are included. Structured logs contain the bounded
error for a failed scan. `/status` isolates snapshot failure in the same way as
other diagnostics; `/ready` remains unchanged.
`idle` means the workflow has been constructed but has not started; after
`start()` it reports `running` until shutdown begins.

## Safety invariants

- A scheduler hint is never evidence that work exists or is eligible.
- The worker atomically claims durable work before dispatch.
- Initial Answer Card delivery continues to gate an ordinary prompt claim.
- At most one ordinary turn runs per binding.
- A running prompt with `detached` observation is observed, never replayed.
- A running steering prompt is never replayed after restart; existing recovery
  continues to fail uncertain steering and convert only never-started steering.
- Herdr remains authoritative for pane, process, terminal, and agent state.
- Safety scans contain no network or Herdr calls.

## Alternatives considered

### Keep recovery in Herdr reconciliation

This is the smallest code footprint, but prompt liveness remains coupled to a
more expensive external snapshot and the reconciler retains unrelated queue
knowledge. Rejected.

### Add diagnostics without changing ownership

This would reveal stale prompt work but would not repair it independently. It
does not address the reliability gap. Rejected.

### Introduce a generic durable-worker framework

A common framework could host prompt and outbox loops, but their claim, retry,
shutdown, and safety semantics differ. With only two workers, the shared
interface would expose more mechanism than leverage. Rejected for now.

## Non-goals

- Adding a new queue, event-sourcing log, broker, or database table.
- Polling Herdr or Lark from the safety scan.
- Changing prompt FIFO, steering, retry, Answer Card, or uncertain-dispatch
  behavior.
- Persisting process-local scheduler or worker diagnostics.
- Adding an operator command or changing Lark card content.
- Restarting or deploying the managed service.

## Verification

Tests must prove that startup and periodic scans recover queued turns, queued
steering, and detached observers after a missing wake; terminal-binding backlog
is cancelled without a Herdr snapshot; duplicate scans cannot duplicate prompt
dispatch; scan failure is logged and retried later; shutdown cancels future
scans; runtime reconciliation no longer performs blanket prompt scans; status
output is sanitized; and readiness is unchanged.

Focused store, prompt workflow, reconciler, scheduler, health, concurrency,
steering, and shutdown tests run before the complete suite, TypeScript
typecheck, production build, and diff validation.
