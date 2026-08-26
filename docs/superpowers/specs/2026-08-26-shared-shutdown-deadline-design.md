# Shared Shutdown Deadline Design

## Status

Approved for implementation on 2026-08-26.

## Problem

Bridge shutdown currently invokes each component's `stop()` method in sequence.
Some components implement their own grace period, while others can wait without
reference to an overall deadline. The total shutdown duration can therefore
exceed the service manager's stop budget, and a later component may receive no
useful time to persist its final checkpoint or release resources.

Shutdown must remain safe under active TraeX turns. A global timeout cannot turn
an uncertain prompt into retryable work, drop durable Lark delivery intent, or
close SQLite while a component can still write to it.

## Goals

- Bound graceful shutdown with one absolute deadline owned by the composition root.
- Stop new ingress before waiting for active work.
- Give all asynchronous stop paths the same view of remaining time.
- Abort bridge observers at the deadline without stopping or replaying TraeX work.
- Preserve durable queued work and outbound intent for the next process.
- Release the write fence, lease, and database in a deterministic final phase.
- Keep shutdown idempotent when several signals or lease-loss callbacks race.

## Non-goals

- Killing a Herdr Pane or TraeX process.
- Draining every queued Prompt before exit.
- Guaranteeing delivery of every pending Lark outbox row before exit.
- Introducing distributed cancellation across Herdr or Lark.
- Replacing systemd's process-level stop timeout.

## Shutdown context

`BridgeRuntimeShutdown` creates one context when the first shutdown request is
accepted:

```ts
interface ShutdownContext {
  signal: AbortSignal;
  deadlineAt: number;
  remainingMs(): number;
}
```

The deadline is absolute and monotonic within the process. Every component sees
the same context. A second shutdown request returns the existing shutdown promise
and cannot replace or extend the deadline.

The configured budget belongs to the runtime shutdown controller. The initial
implementation uses the existing prompt shutdown grace as its default so the
operational behavior does not acquire a second competing timeout. Configuration
can be exposed separately when operators need to tune it.

## Shutdown phases

Shutdown proceeds in dependency order. The shared deadline applies across all
phases rather than restarting for each component.

### 1. Quiesce ingress

Stop the UDP event inbox, Herdr Socket event subscriber, and Lark inbound
subscription. New messages and wake-up hints must no longer enter the process.
Read-only shutdown diagnostics may continue.

### 2. Quiesce application workflows

Stop periodic reconciliation and cleanup scheduling. Prompt workers stop claiming
new work and wait for current observers while time remains. Pane control and model
selection stop accepting new executions.

When the shared signal aborts, active bridge observers detach. A Prompt that may
already have reached TraeX stays `running` with detached observation metadata and
is never returned to `queued`. Work that was never claimed remains durable and is
eligible after restart.

### 3. Drain projection and delivery

The lifecycle projector finishes already accepted callbacks while time remains.
The Lark outbox dispatcher stops claiming new rows and waits for active requests.
Any undelivered intent stays in SQLite for startup recovery.

### 4. Close external listeners

Close the health server so the old process cannot appear healthy during final
resource release. Readiness must already be false because ingress and workers are
stopping.

### 5. Release durable ownership

After all write-capable components have settled:

1. deactivate the SQLite write fence;
2. release the instance lease;
3. close the SQLite connection.

No component may retain a write-capable background task after this phase starts.
Deadline expiry requests abort and begins the bounded abort-settlement window; it
does not by itself authorize closing SQLite.

## Deadline behavior

The controller arms one timer for the absolute deadline. At expiry it aborts the
shared signal and records one structured `bridge-shutdown-deadline-exceeded` log.

Each asynchronous phase races its stop operation against the remaining deadline.
If a component exceeds the graceful deadline, the controller logs the component
and aborts the shared signal. Write-capable components receive a short, fixed
abort-settlement window before final resource release. If one still does not
settle, the controller must not close SQLite underneath it; shutdown remains
pending and systemd's outer stop timeout becomes the final process-level fence.
A late rejection is observed and logged so it cannot become an unhandled promise
rejection.

Components should respond to the shared signal where doing so changes domain
behavior. Prompt observation is the primary example because abort must persist a
detached/no-replay outcome. Simple bounded close operations may only need the
remaining-time race at the controller.

## Failure handling

- A component exception is isolated and logged; later shutdown phases still run.
- Deadline expiry ends the graceful phase and starts abort settlement. A
  non-cooperative writer is left to systemd's process-level stop timeout rather
  than allowing unsafe resource closure.
- Durable work is not deleted to make shutdown finish faster.
- A failure releasing the lease or closing the database is logged at error level.
- The final completion log includes duration, deadline, whether it expired, and
  the names of failed or timed-out components.

## Interface changes

The runtime defines a small shared `ShutdownContext` interface. Stop methods that
need domain-aware cancellation accept it:

```ts
stop(context: ShutdownContext): Promise<void>
```

The coordinator forwards the same context to owned workflows. This is an
application lifecycle interface, not a general-purpose cancellation token for
normal command execution. Existing prompt-level `AbortController` instances
remain owned by `TurnSupervisor`; the shared shutdown signal tells the workflow
when to abort those observers.

## Observability

Shutdown logs must not contain Prompt bodies or terminal output. The following
events are sufficient:

- `bridge-shutdown-started`: signal, deadline, budget;
- `bridge-shutdown-component-failed`: component and safe error;
- `bridge-shutdown-component-timed-out`: component and elapsed time;
- `bridge-shutdown-deadline-exceeded`: active phase and remaining components;
- `bridge-shutdown-completed`: duration, expired flag, failures, timeouts.

## Test strategy

Unit tests for the runtime shutdown controller cover:

1. normal dependency order with one shared context;
2. concurrent shutdown requests returning the same promise;
3. a component failure not preventing later cleanup;
4. a hanging read-only component being bounded by the global deadline;
5. the deadline not restarting for each component;
6. late component rejection being observed;
7. write fence, lease, and store closing only after write-capable components settle;
8. a non-cooperative writer preventing in-process database closure.

Prompt workflow tests cover:

1. an active observer settling before the deadline;
2. deadline abort detaching a possibly dispatched Prompt;
3. an unclaimed Prompt remaining queued;
4. no TraeX prompt replay after restart.

The full suite, typecheck, build, and a graceful plugin restart remain required
before deployment. Production verification checks the new build identity, ready
state, lease ownership, Lark connectivity, and outbox convergence.

## Alternatives considered

### Independent timeout per component

This requires little refactoring but allows total shutdown time to grow with the
number of components. It also gives late phases an unpredictable budget.

### One top-level `Promise.race`

This bounds elapsed time but does not tell Prompt observers to detach safely. It
can also close SQLite while unresolved tasks still believe writes are allowed.

### Shared deadline and abort signal

This provides one time budget and lets domain-sensitive workers perform safe
cancellation. It is the selected design because it preserves no-replay semantics
while bounding process shutdown.
