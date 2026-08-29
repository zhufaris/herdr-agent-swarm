# Instance Turn Recovery and Restart Safety Design

## Goal

Make multi-agent instance turns survive Bridge shutdown and restart without
duplicating a prompt, silently abandoning FIFO work, or allowing routine
operator actions to destroy the only observable runtime. Extend the existing
restart and status protections to include the instance worker path.

## Scope

This change covers instance-turn dispatch checkpoints, startup recovery,
detached observation, scheduler failure fencing, active-turn stop protection,
generation isolation, and instance-worker diagnostics. It does not add remote
approval, force-stop controls, steer or interrupt recovery, provisioning
recovery, Primary-tool long polling, or Store capability splitting. Those
remain follow-up work from the architecture review.

The existing rule remains authoritative: after a prompt may have reached an
agent, the Bridge never automatically sends it again.

## Architecture

Add an `InstanceTurnSupervisor` beside `InstanceWorkScheduler` and
`InstanceRuntimeReconciler`. The scheduler owns dispatch of work known not to
have started. The supervisor owns durable recovery classification, observation
of work that may already have started, and operational diagnostics. The runtime
reconciler continues to establish authoritative pane identity and observed
instance state. SQLite remains the single transaction owner.

`InstanceWorkScheduler` and `InstanceTurnSupervisor` expose one combined
instance-worker diagnostic surface to `/status`, shutdown, and the plugin
restart preflight. Neither component infers lifecycle state from a Lark card.

## Durable dispatch boundary

The turn state machine distinguishes three dispatch facts:

- `claimed`: the row was reserved, but no external dispatch call began. Startup
  recovery may atomically return it to `queued`.
- `dispatching`: the Bridge entered the external driver call, but has no proof
  that the prompt reached the agent. It must never be automatically replayed.
- `running`: the driver observed the existing Herdr dispatch callback, proving
  that the prompt crossed the dispatch boundary. It may be observed to
  completion but never replayed.

`AgentRuntimeDriver.submit` accepts a dispatch callback. TraeX and the shared
terminal driver invoke it from the existing `runManagedPrompt` or `runPrompt`
dispatch callback. The scheduler uses it to transition `dispatching` to
`running`. The callback is idempotent and generation-fenced.

If an exception occurs before the scheduler enters the driver call, the turn is
failed with a bounded error. If the driver call throws after it begins, the turn
becomes `dispatch-uncertain`, regardless of whether the callback fired. This is
conservative because a third-party or future driver may throw after performing
an external effect. A normal driver receipt retains the existing result mapping.

Every scheduled drain consumes its rejection and records a bounded diagnostic.
No `finally()` derivative is left unhandled.

## Startup recovery and detached observation

After the fenced lease and Store write fence are active, startup recovery runs
before readiness is advertised:

1. Atomically return current-generation `claimed` turns to `queued`.
2. Load current-generation `dispatching`, `running`, `blocked`, and
   `dispatch-uncertain` turns.
3. Reconcile each instance against a fresh, identity-checked Herdr pane.
4. Wake `queued` work only when the verified runtime is idle and no
   current-generation active or uncertain turn exists.
5. Attach one detached observer per recoverable instance turn.

The observer never calls `submit`. It periodically reloads durable instance and
turn state and reads the verified pane state through the bounded Herdr adapter:

- `working` changes a `dispatching` or `dispatch-uncertain` turn to `running`;
- `blocked` changes it to `blocked`;
- `idle` or `done` completes a previously durable `running` or `blocked` turn;
- `idle` or `done` cannot prove that a merely `dispatching` or
  `dispatch-uncertain` turn ran, so that turn remains `dispatch-uncertain`;
- a missing or identity-mismatched pane leaves the turn
  `dispatch-uncertain` and detaches the runtime;
- an observation error retains recoverable state and is retried by periodic
  reconciliation with bounded backoff.

Completion records a lifecycle event and wakes the next FIFO turn. Because
instance turns currently carry no user-visible answer body, recovery persists a
bounded observation result rather than reconstructing terminal scrollback.

## Stop and generation fencing

Normal instance stop is rejected while the current generation has a turn in
`claimed`, `dispatching`, `running`, `blocked`, or `dispatch-uncertain`. The
operator must wait for completion or use the existing interrupt action and then
wait for durable convergence. P0 deliberately adds no force-stop action.

The Store atomically verifies that no current-generation active or uncertain
turn exists and marks the instance as no longer accepting claims before pane
release. The runtime reference is retained during that external effect. If pane
release succeeds, a generation-fenced transition clears the runtime and records
`stopped`. If release fails, the workflow restores the prior running intent and
records a bounded error instead of reporting a successful stop.

Active-turn and pending-turn queries are generation-scoped. An uncertain turn
from a detached older generation remains immutable audit evidence but does not
block safe work in a later verified generation. Queued turns moved during a
runtime detach continue to follow the existing generation migration rule.

## Diagnostics and restart preflight

The instance worker snapshot contains only bounded operational metadata:

- lifecycle state: `idle`, `running`, or `stopping`;
- active dispatch workers and detached observers;
- queued, active, and uncertain durable turn counts;
- last recovery scan time and outcome;
- last bounded failure time and message.

`/status` publishes this as `instanceWorker`. Active dispatch workers, detached
observers, or active/uncertain durable turns make operational status degraded.
They do not independently fail `/ready` after startup recovery has completed,
because an observed long-running agent is a valid service state.

The plugin restart preflight rejects an unforced restart when `instanceWorker`
reports active dispatch workers, detached observers, or active/uncertain turns.
The existing `--force` escape hatch remains available. If `/status` is
unreachable or belongs to another service, the existing fail-open behavior is
unchanged.

## Shutdown

Shutdown stops accepting new instance wakes, waits within the shared shutdown
deadline, and then detaches remaining dispatch workers or observers without
replaying their prompts. Durable `running` and `blocked` states remain available
for startup observation; an in-call dispatch without a final receipt is fenced
as `dispatch-uncertain`.

## Failure handling

- Store failures before external dispatch fail the worker and preserve a
  recoverable durable row.
- Any failure after external dispatch may have begun is persisted as uncertain.
- Observer failures are isolated per instance and do not abort recovery for
  other projects or instances.
- Stale generation updates are ignored and reported in diagnostics; they never
  mutate a newer runtime.
- Recovery and stop transitions use SQLite transactions for multi-row and
  lifecycle-sensitive changes.
- Prompt text, credentials, terminal contents, and tool payloads do not appear
  in diagnostics or restart errors.

## Testing

Focused Store and integration tests cover:

- `claimed` recovery to `queued` before any dispatch;
- `dispatching`, `running`, `blocked`, and uncertain restart recovery without a
  second `submit` call;
- recovery completion only after durable dispatch proof and observed idle/done;
- idle ambiguous dispatch remaining uncertain;
- missing and identity-mismatched panes retaining no-replay state;
- driver and Store exceptions being consumed without unhandled rejection;
- stop rejection for every active or uncertain current-generation state;
- old-generation uncertain turns not blocking a new verified generation;
- instance-worker `/status` diagnostics and degraded status;
- restart rejection for active instance work and `--force` bypass.

Before handoff, run the focused instance messaging, runtime reconciliation,
control, Store, health, lifecycle, and shutdown tests, followed by `npm test`,
`npm run typecheck`, and `npm run build`. Do not stage or modify unrelated
Lark/Answer work already present in the worktree.
