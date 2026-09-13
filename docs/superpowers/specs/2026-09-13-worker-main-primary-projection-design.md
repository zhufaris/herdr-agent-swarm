# Worker main-card projection reuse

**Date:** 2026-09-13  
**Status:** proposed, approved architecture direction; awaiting written-spec review

## Problem

A Worker Session thread has two different visible responsibilities:

- its main card represents the long-lived Worker pane/session; and
- each accepted Worker request needs a task card that can stream that request's
  progress and final result.

Today the Worker main card has a parallel projection/reservation path, while a
new Worker turn can remain `running` without a task-card delivery target. In
the observed case, its stale persisted native session was a terminal identifier
rather than Herdr's native TraeX session UUID, so exact transcript observation
could not establish a trusted `runtime_turn_id`. No task-card creation intent
was reserved either.

## Decision

Worker main cards will use the same **pane-session main-card lifecycle** as
Primary main cards: durable invalidation, deterministic projection reduction,
idempotent placement reservation, durable outbox enqueue, delivery checkpoint,
and restart recovery. The two roles retain role-specific input selection and
rendering, but not independently implemented delivery/recovery state machines.

Worker Task Cards remain a separate, per-turn aggregate. They are created when
the Worker Session workflow durably accepts a task, then receive ordered stream
content and terminal updates only for that task. They are not a replacement for
the Worker pane's main card.

## Alternatives considered

1. **Share a pane-session main-card projection mechanism (selected).** Extract
   the common invalidation-to-reservation/outbox lifecycle, parameterized by a
   role-specific selector, renderer, placement target, and identity fence. This
   gives Primary and Worker sessions equivalent recovery behavior while keeping
   their content independent.
2. Keep the existing Worker-specific main-card flow and repair only task-card
   creation. This is a smaller change, but it preserves two subtly different
   recovery paths and does not meet the requested reuse boundary.
3. Use one Worker card for both session status and task streaming. This reduces
   visible cards but makes frozen/history semantics and concurrent task history
   ambiguous, and removes the durable per-turn presentation aggregate.

## Architecture

### Shared main-card mechanism

Introduce a pane-session projection seam beneath `SqliteCardContextStore`:

- Primary and Worker session invalidations both load a fenced session source,
  reduce it against the prior view and requested dependency revision, and pass
  the resulting view to the same reservation/outbox lifecycle.
- The shared lifecycle owns only durability mechanics: stale generation checks,
  no-op/current detection, create-versus-update idempotency keys, outbox intent
  persistence, delivery checkpoints, and recovery from pending invalidations.
- Primary retains `TopicViewState`, `selectPrimaryWorkerSummaries`, and the
  Primary renderer/placement policy. Worker retains `WorkerMainView`,
  `selectWorkerMainView`, Worker thread-entry readiness, and the Worker
  renderer/placement policy.
- Existing `worker_main_views` and the Worker-session identifier stay in place
  for migration safety. This is lifecycle reuse, not an unsafe schema merge of
  unlike view shapes.

The `CardContextRebuilder` remains the single durable rebuild and outbox wake
path. No coordinator may patch a Lark main card directly.

### Worker Task Cards

When `acceptInstanceTurnWithCard` commits a newly accepted Worker Session task,
the same transaction must persist its `WorkerTurnCardView` and reserve the
idempotent create intent needed to establish that task's CardKit target. The
create intent precedes all content/finish updates in the task-card lane.

The task-card projection then follows the existing Worker-turn stream contract:

1. acceptance creates a durable task-card target intent;
2. exact transcript observation claims the matching native TraeX turn and
   persists ordered progress/output reductions;
3. outbox delivery creates, streams, and finishes only the card for that turn;
4. retrying delivery never resubmits the TraeX prompt.

Old `worker-turn` invalidations that refer to historical immutable cards remain
safe to converge as stale. New Worker Session turns use the explicit current
task-card create path rather than reviving arbitrary legacy invalidations.

### Native-session reconciliation

Exact transcript observation requires a current Herdr native TraeX session
identity, not a terminal identifier. Runtime reconciliation must detect a
current native-session UUID for the same reconciled Worker pane and update/attach
the fenced runtime reference through the instance-store transition. It must not
blindly overwrite session state:

- require the same Worker instance, generation, pane identity, and supported
  agent kind;
- reject absent or non-native session identities;
- preserve generation/fencing behavior in the store transition; and
- invalidate/restart observation only after the durable runtime reference is
  coherent.

If identity is still unavailable after reconciliation, the task remains safely
running/detached for later observation; it is never automatically replayed.

## Failure and recovery behavior

SQLite remains the authority for the accepted Worker turn, view state, card
target, and outbound intent. Lark is repaired exclusively by the outbox. A
process restart scans pending main-card invalidations and undelivered task-card
outbox intents, preserving the original idempotency keys. A delivered prompt
with uncertain observation remains detached; recovery observes the exact session
again rather than dispatching another prompt.

## Test plan

- Extend main-card/card-context integration coverage to show Primary and Worker
  sessions using the same lifecycle outcomes: reserve, current, stale, and
  recovered outbox delivery.
- Extend Worker-task integration coverage: accepted Worker Session work creates
  one durable task-card create intent; progress and finish are ordered after it;
  a duplicate/retry does not create a second target or re-dispatch the prompt.
- Add runtime-reconciler coverage for replacing a stale terminal identifier with
  the matching pane's native TraeX UUID, and for rejecting a mismatched pane or
  generation.
- Extend `worker-turn-observer` coverage to prove the refreshed native session
  can claim the exact turn and project trusted output.
- Run affected Vitest files, `npm run typecheck`, and `npm run build`; run the
  full suite because this crosses durable workflow, projection, and recovery
  boundaries.

## Non-goals

- Changing Lark from a projection into a workflow authority.
- Replaying any task after it may have reached TraeX.
- Merging Worker Task Cards into a Worker main card.
- Retrofitting historical immutable task cards with new streaming behavior.
