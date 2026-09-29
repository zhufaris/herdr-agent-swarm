# Primary Execution and Observation Design

## Goal

Deepen the Primary Prompt execution seam without changing queue order, dispatch
fences, transcript ownership, lifecycle projection, shutdown behavior, or the
no-replay guarantee. `PromptRunWorkflow` should remain the small application
interface used by startup, commands, health, and shutdown, while live dispatch
and detached observation become independently understandable modules behind it.

This pass does not change SQLite schema, Agent adapter contracts, Prompt states,
Card rendering, retry intervals, or user-visible messages.

## Current problem

`PromptRunWorkflow` currently coordinates lifecycle and scheduling, but it also
implements the per-binding claim/preflight loop and the complete detached-turn
observation loop. Callers see a reasonable interface, yet maintainers must read
the workflow, `PromptTurnExecutor`, `TranscriptObserver`, `PromptSafetyScanner`,
and `PromptRunRegistry` together to determine who owns a turn and whether it can
be replayed.

The existing lower-level modules are useful and remain in place:

- `PromptTurnExecutor` owns one claimed live execution attempt.
- `TranscriptObserver` owns exact transcript acquisition, ownership, bounded
  output, and publication.
- `PromptSafetyScanner` owns periodic durable discovery and stale pre-dispatch
  claim recovery.
- `PromptRunRegistry` owns process-local single-worker and active-turn handles.

The missing seams are the orchestration above live execution and detached
observation.

## Considered approaches

### A. Extract dispatcher and detached observer modules (chosen)

Introduce `PrimaryPromptDispatcher` for one binding's durable FIFO and
`DetachedPromptObserver` for an already-dispatched Prompt. Keep
`PromptRunWorkflow` as the lifecycle facade and owner of the shared registry.
This removes the two largest algorithms while retaining one process-local
ownership authority.

### B. Replace the whole workflow with one explicit state machine

A state machine could unify live and detached phases, but it would require a
larger behavioral rewrite across dispatch, observation, safety scanning, and
shutdown. It adds migration risk without a new product requirement.

### C. Extract private helper functions only

Pure helpers would shorten the file but leave dependency knowledge, lifecycle
ownership, and recovery decisions in `PromptRunWorkflow`. The deletion test
would simply move lines rather than deepen the interface.

Approach A provides the best locality with the least semantic change.

## Authority and invariants

- SQLite owns Prompt state, FIFO order, dispatch evidence, transcript identity,
  terminal state, and recovery eligibility.
- `PromptRunRegistry` remains the only process-local authority for active
  binding workers and attached abort controllers. It is never recovery truth.
- A binding has at most one Primary worker and one ordinary active turn.
- Before submission, the dispatcher must re-read the live Herdr pane and verify
  binding generation, pane, workspace, native session, and dispatchable runtime
  state.
- Work without durable dispatch evidence may be released to FIFO. Work that may
  have reached an Agent must become detached or terminal; it is never replayed.
- Detached output is accepted only for the persisted exact transcript turn and
  start time. A newer external turn is handed to the existing external-turn
  observer rather than attributed to the Prompt.
- Lifecycle publication and Card convergence continue from committed SQLite
  state. EventBus notifications never become authority.

## Chosen modules and interfaces

### `PromptRunWorkflow`

The existing public interface remains compatible:

```ts
interface PromptRunWorkflowPort extends PrimaryRuntimeStatePort {
  prepareRecovery(): void;
  start(): void;
  requestSafetyScan(): void;
  snapshot(): PromptWorkerDiagnostics;
  awake(bindingId: string): Promise<PromptAwakeResult>;
  skipDetached(...): DetachedPromptSkipResult;
  stop(context?: ShutdownContext): Promise<void>;
}
```

Its implementation owns composition of the internal modules, scheduler
subscription, safety scanner, shared registry, explicit operator commands, and
ordered shutdown. It does not claim Prompt rows, inspect live panes, execute an
Agent turn, or run the detached polling loop directly.

### `PrimaryPromptDispatcher`

The dispatcher exposes one behavior to the facade:

```ts
interface PrimaryPromptDispatcherPort {
  drain(bindingId: string): Promise<void>;
}
```

Behind that interface it owns external-turn handoff before claim, FIFO claim,
fresh pane preflight, safe release of an undispatched claim, optional Main Card
model convergence, one `PromptTurnExecutor.execute` call, active-turn registry
attachment/detachment, draining-session archival, and the decision to continue
or stop the binding loop.

It never creates its own worker promise or timer. The facade owns scheduling and
ensures only one `drain(bindingId)` call runs at a time.

### `DetachedPromptObserver`

The observer exposes one behavior:

```ts
interface DetachedPromptObserverPort {
  observe(prompt: PromptJob): Promise<void>;
}
```

It reloads and validates the Prompt and Binding, attaches the exact turn to the
shared registry, opens the persisted transcript boundary through
`TranscriptObserver`, watches fresh Herdr runtime state, handles a superseding
external turn, commits terminal completion or abort, emits lifecycle events, and
conservatively preserves detached state after uncertain observation failure.

The module does not submit Prompt text, claim FIFO work, schedule itself, or
decide whether another worker already owns the binding.

## Data flow

```text
Prompt work hint
  -> PromptRunWorkflow schedules one binding worker
  -> PrimaryPromptDispatcher.drain(bindingId)
  -> external-turn handoff
  -> SQLite claimNextDispatchablePrompt
  -> fresh Herdr pane and identity preflight
  -> PromptTurnExecutor.execute
       -> dispatch checkpoint before/at Agent acceptance
       -> attached TranscriptObserver
       -> terminal commit or detached no-replay result
  -> release registry ownership
  -> continue FIFO only when safe

Detached work hint / explicit awake
  -> PromptRunWorkflow arbitrates registry ownership
  -> DetachedPromptObserver.observe(prompt)
  -> reload exact durable identity
  -> TranscriptObserver.openDetached
  -> fresh Herdr observation loop
  -> settle completed/aborted, hand off superseding turn, or remain detached
```

## Failure and recovery semantics

- Pane lookup failure and identity/runtime mismatch before dispatch release the
  claim only through the existing generation/pane/update fence.
- `not-delivered` Agent results remain eligible for dispatch;
  `delivery-uncertain`, timeout after dispatch, shutdown abort, and observer
  failure remain detached without replay.
- Startup keeps `recoverRunningPrompts()` before scheduler start. The safety
  scanner discovers detached work and stale pre-dispatch claims from SQLite.
- Explicit `awake` may replace the current local observer only after it has
  settled; it never submits Prompt text. Explicit `skipDetached` retains its
  atomic terminal transition and audit behavior.
- Shutdown stops admission of new scheduled work, clears transcript caches and
  safety timers, waits for owned workers within the existing grace/deadline, then
  aborts observers and persists detached notices for possibly running turns.

## Composition and dependency direction

`createPrimaryRuntime` continues to construct only `PromptRunWorkflow`; the
workflow privately constructs the dispatcher and detached observer because there
is one production implementation of each and no caller needs to select between
adapters. Their interfaces exist as test surfaces and internal seams, not as new
composition-root choices.

The dispatcher and detached observer depend only on domain ports, existing
coordinator interfaces, and injected functions. Neither imports composition,
SQLite implementations, Lark adapters, or card renderers.

## Verification

Focused tests must prove through the new interfaces:

1. dispatch FIFO, external-turn handoff ordering, fresh-pane preflight, safe
   release, model convergence, and draining archive behavior;
2. detached exact-turn ownership, completion, explicit abort, superseding-turn
   handoff, observation failure, and no replay;
3. shared registry exclusion between dispatch and detached observation;
4. startup recovery, safety scanning, `awake`, `skipDetached`, and graceful or
   forced shutdown remain behavior-compatible;
5. architecture checks prevent the facade from regaining claim/preflight or
   detached polling implementation and keep the new modules inward-facing.

Run focused Prompt execution, transcript, recovery, concurrency, and architecture
tests, followed by the full suite, typecheck, build, architecture check,
documentation audit, and `git diff --check`.

## Explicit non-goals

- No new database table, durable event log, queue, or in-memory recovery source.
- No change to Prompt acceptance, routing, command syntax, Card content, or
  notification behavior.
- No change to transcript parsing, bounded-output policy, or exact-turn matching.
- No generalized workflow framework or public handler registry.
- No Worker execution refactor in this pass.
