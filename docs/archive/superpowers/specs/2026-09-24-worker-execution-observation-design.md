# Worker Execution and Observation Design

## Goal

Deepen the Worker turn execution seam without changing Worker FIFO order, Agent
driver receipts, exact transcript ownership, no-replay recovery, card projection,
human-review notification, or shutdown behavior. The dispatch module should be
named and located as application workflow policy rather than as event
infrastructure, and it should depend on a consumer-shaped durable store.

This pass does not change SQLite schema, Worker states, Agent adapter contracts,
polling intervals, Card content, notification routes, or user commands.

## Current shape and problem

Worker execution is already divided into three meaningful modules:

- `InstanceWorkScheduler` owns per-instance wake coalescing, durable FIFO claim,
  one live dispatch, transcript-watch handoff, uncertain delivery, and shutdown.
- `WorkerTurnObserver` owns exact transcript identity, bounded output, terminal
  projection, live watch, and restart recovery.
- `InstanceTurnSupervisor` owns periodic and Pane-targeted recovery discovery,
  fresh Herdr validation, conservative state convergence, and retry diagnostics.

The algorithms are separated, but the principal dispatch workflow is misplaced
under `src/events/` and named as if it were a best-effort event scheduler. It is
actually the durable Worker execution policy: it claims SQLite work, crosses the
Agent submission boundary, decides which receipts are retryable or uncertain,
and fences shutdown. It also depends on the broad intersection
`InstanceLifecycleStore & InstanceTurnStore`, which makes its actual durable
capabilities harder to see.

## Considered approaches

### A. Promote the existing dispatcher to a coordinator deep module (chosen)

Rename and move `InstanceWorkScheduler` to `WorkerTurnDispatcher` in
`src/coordinator/`. Keep its public lifecycle interface small: `wake`, `drain`,
`snapshot`, and `stop`. Add `WorkerTurnDispatchStore` containing only the
capabilities the dispatcher uses. Keep `WorkerTurnObserver` and
`InstanceTurnSupervisor` as separate modules behind the existing observation
interface.

This corrects dependency direction and vocabulary while preserving the proven
execution algorithm. The deletion test is meaningful: removing the dispatcher
would spread FIFO, watch, receipt, no-replay, and shutdown policy back into
composition or messaging.

### B. Split a single-attempt executor from the scheduler

An executor could hide `driver.submit`, but its caller would still need to
coordinate watch creation, flush/stop/detach, runtime-turn identity, receipt
classification, projection transitions, loop continuation, and shutdown abort.
That internal protocol would be larger than the single `drain(instanceId)` seam
and would create a shallow module without an independent caller.

### C. Keep the implementation and document it only

This has the lowest edit cost, but leaves durable workflow policy in the events
layer and retains an implementation-shaped store dependency. It does not satisfy
the repository's dependency vocabulary or make the authority boundary clearer.

Approach A provides the highest leverage with the smallest behavioral change.

## Authority and invariants

- SQLite owns Worker turn state, FIFO order, instance generation, dispatch state,
  runtime turn identity, terminal state, projection state, and recovery
  eligibility.
- Process-local active/drain/watch sets prevent duplicate local work but never
  become recovery authority.
- One Worker instance dispatches at most one ordinary turn at a time. Later
  ordinary turns remain FIFO queued. Exact steering stays in
  `TurnControlWorkflow` and is outside this dispatcher.
- A confirmed Agent submission is not task completion. Structured Agent turns
  remain under exact transcript observation.
- A turn with a persisted runtime turn ID is observed or recovered; it is never
  submitted again. Delivery uncertainty remains `dispatch-uncertain`.
- Shutdown may abort the local waiter only after recording the uncertain durable
  state. Detached transcript watches are stopped without replay.
- Worker Task Card changes and human-review notification intent remain atomic
  with the existing durable turn transitions.

## Chosen modules and interfaces

### `WorkerTurnDispatcher`

The renamed module exposes the existing lifecycle behavior:

```ts
interface WorkerTurnDispatcherPort {
  wake(instanceId: string): void;
  drain(instanceId: string): Promise<void>;
  snapshot(): WorkerDispatchDiagnostics;
  stop(context?: ShutdownContext): Promise<void>;
}
```

Behind this interface it owns per-instance single flight, durable FIFO claim,
driver lookup, dispatching/running/terminal projections, exact observer-watch
lifecycle, receipt classification, uncertain no-replay transitions, detached
watch cleanup, diagnostics, and shutdown fencing.

The module lives in `src/coordinator/` because these are application workflow
decisions. `wake` is best-effort scheduling, but every execution reloads and
claims SQLite state. The runtime EventBus remains only a hint transport.

### `WorkerTurnDispatchStore`

The new domain port contains only the durable operations used by the dispatcher:

- load the current instance and turn;
- claim the next generation-fenced FIFO turn;
- transition lifecycle, projection, and notification intent atomically;
- update instance lifecycle after a non-structured confirmed turn.

It is a `Pick` over the existing capability graph, so this pass changes neither
schema nor SQLite transactions.

### Existing observation and supervision modules

`WorkerTurnObserver` remains the exact transcript module behind
`WorkerTurnObservationPort.watch/recover`. `InstanceTurnSupervisor` remains the
recovery scheduler and fresh-Pane validator. Neither depends on the concrete
dispatcher. Composition connects their wake callbacks through `RuntimeLink`,
preserving the cycle break without making the link durable authority.

## Data flow

```text
durable Worker turn accepted
  -> WorkerTurnDispatcher.wake(instanceId)
  -> one process-local drain per instance
  -> SQLite claimNextInstanceTurn(instance, generation)
  -> WorkerTurnObserver.watch(turnId) when structured output is supported
  -> AgentDriver.submit
       -> durable running transition on dispatch evidence
       -> exact transcript claims runtime turn identity
  -> flush exact observations
  -> terminal state, detached watch, or dispatch-uncertain no-replay state

restart / Herdr Pane hint
  -> InstanceTurnSupervisor
  -> fresh Pane identity and workspace validation
  -> WorkerTurnObserver.recover(turnId) for an exact persisted turn
  -> settle terminal state or keep observing without submission
```

## Failure and recovery semantics

- Missing Agent drivers fail the claimed turn; they do not silently requeue it.
- A submission exception with an exact persisted runtime turn detaches the watch
  and returns without replay. Without exact identity, it becomes
  `dispatch-uncertain`.
- `confirmed-delivered` completes immediately only for Agent kinds that do not
  expose structured events. Structured turns require exact observation.
- `delivery-uncertain` remains uncertain; `not-delivered` follows the existing
  terminal failure behavior.
- Recovery validates current instance generation, runtime Pane, workspace, cwd,
  and Agent kind before trusting observation. Missing or mismatched runtime
  terminates the Worker session through the existing atomic transition.
- A transcript with no exact terminal lifecycle cannot infer completion from a
  coarse idle Pane state when exact identity exists.

## Composition and dependency direction

`createWorkerRuntime` constructs one `WorkerTurnDispatcher`, connects it to the
observer and supervisor through narrow callbacks, and returns it under the
existing `instanceWork` property for lifecycle-call compatibility. No consumer
imports an events-layer execution implementation.

The dispatcher depends only on domain ports, Agent driver contracts, Worker
presentation functions, the observation port, and runtime shutdown/error helpers.
It does not import composition, concrete SQLite, Gateway, Lark, or Card renderer
modules.

## Verification

Focused tests must preserve:

1. per-instance single flight and FIFO dispatch;
2. dispatch evidence and receipt classification;
3. exact watch flush, detach, and terminal ownership;
4. uncertain no-replay behavior on exceptions and shutdown;
5. non-structured Agent completion behavior;
6. supervisor recovery, Pane mismatch, concurrency, and retry diagnostics;
7. architecture checks for location, naming, narrow store capability, and inward
   dependency direction.

Run the Worker messaging, observer, supervisor, shutdown, composition, and
architecture tests, followed by the full suite, typecheck, build, architecture
check, documentation audit, and `git diff --check`.

## Explicit non-goals

- No Worker state-machine, SQLite schema, Card, notification, command, or timing
  change.
- No shared abstraction between Primary and Worker dispatchers. Their aggregates,
  receipts, and recovery protocols are different.
- No generic workflow framework or second transcript parser.
- No refactor of Worker creation/control, durable outbound delivery, or Herdr
  runtime reconciliation in this pass.
