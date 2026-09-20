# Worker Session Single-Card Design

## Status

Implemented. This document replaces the visible one-card-per-
turn Worker presentation with one continuously updated card per Worker session.
Turn history, FIFO scheduling, exact-turn ownership, and durable recovery remain
unchanged authorities.

## Goal

A Worker should occupy one stable card in a Lark topic for the lifetime of one
`workerSessionGeneration`. New tasks update that card instead of creating a new
message for every turn. The card must still make the current task understandable
and safely interactive without allowing a stale callback to steer, stop, or
continue a different turn.

The stable Worker card becomes both the session summary and the live current-
task surface. SQLite remains the history and workflow authority; the card is only
a bounded projection.

## User-Visible Model

One Worker-session card contains these regions:

1. Worker identity, owner, workspace, branch, model, runtime state, and session
   generation.
2. Current task request, lifecycle state, elapsed time, current status, recent
   progress, and bounded live output.
3. Exact-current-turn actions: `补充当前任务` and `停止当前任务` only when legal.
4. FIFO depth and next task summary.
5. A bounded recent-task list with terminal state and short result summary.
6. `发起新任务`, which always creates an independent FIFO turn.

When a new turn becomes current, the same Lark message is updated in place. A
completed result remains visible until the next task starts. Once another task
becomes current, older results remain durable and auditable but do not create or
retain a separate live Task Card in the topic.

Large output is kept in durable per-turn pages. The stable card displays a
bounded current window or terminal summary; it does not emit continuation card
messages. An explicit history-detail surface may be added later, but the initial
migration must preserve the stored data needed for it.

## Authority and Aggregate Boundaries

The existing `WorkerMainView` is promoted into the sole visible Worker-session
projection. Its aggregate identity remains:

```text
workerId + workerSessionGeneration
```

Its delivery lane remains stable:

```text
worker-main:<workerId>:<workerSessionGeneration>
```

The view gains a bounded current-turn projection: exact `turnId`, instance and
session generations, request, phase, status, recent progress, result-capture
state, answer window or result summary, timestamps, and the fields required to
render legal actions. These are projections of durable turn facts, not a second
turn authority.

`instance_turns`, transcript ownership, lifecycle events, and durable Worker-turn
records continue to own task history and exact execution identity. Existing
Worker-turn page rows may be retained as non-visible historical output segments
during migration. They no longer imply a Lark message must exist. New code must
not derive the current turn by parsing the Worker card or by following an old
Task Card link.

## Lifecycle and Data Flow

### Session creation

Worker creation reserves one Worker Main Card create intent. Delivery records its
stable `messageId` and `cardId`. No task is required for the card to exist.

### Turn acceptance and queueing

Accepting a Worker turn transactionally persists the turn, queue position, audit
facts, and the Worker Main View dependency revision. It does not reserve
`worker-turn:create:<turnId>:0` or any other new Lark message. If the turn is only
queued, the card updates queue information while retaining the current task.

### Active turn

When FIFO claim or reconciliation establishes the current turn, the Main View
copies that turn's projection into its current-task region. Transcript
observations update the durable turn projection first and then advance the Main
View dependency revision. A session-keyed convergence workflow renders and
reserves an ordered update on the stable Worker lane. Process-local wake-ups may
coalesce; durable view versions guarantee eventual convergence.

The output window uses the same bounded parsing, redaction, and canonical source
offset rules as the existing Worker Task Card. Coalescing may skip intermediate
visual frames but must not lose durable turn output or reorder a terminal update
behind a newer current turn.

### Terminal turn and handoff

Completion, failure, cancellation, or dispatch uncertainty is first persisted on
the exact turn. The same transaction, or a transactionally coupled projection
transition, updates the Main View terminal snapshot and recent-task summary. The
terminal card update must be ordered before the card switches to the next claimed
turn. The scheduler may continue independently; card delivery lag must never
delay or duplicate TraeX dispatch.

### Session replacement or termination

A new `workerSessionGeneration` creates a new stable card and permanently fences
the old one. Termination freezes the old card. Historical callbacks against it
are rejected even if an instance with the same display name exists later.

## Exact-Turn Interaction Fences

Current-turn actions embedded in the stable card carry:

- `turnId`;
- `instanceId` and runtime generation;
- `workerSessionGeneration`;
- `sourceCardMessageId`;
- the action kind.

Callback handling reloads the binding, instance, Worker Main View, and exact turn.
It allows a turn-specific action only when all existing ownership checks pass and
the view's current `turnId` still equals the payload `turnId`. It then applies the
state-to-intent rule to freshly loaded state. A stale button must return an
informative rejection such as `任务已结束或 Worker 卡片已切换` and must never be
reinterpreted for the newer turn.

`补充当前任务` remains exact-turn steering for running or blocked work.
`停止当前任务` remains an identity-fenced exact-turn stop. `发起新任务` remains an
independent FIFO submission and does not carry a current `turnId`. High-risk
approval remains local to Herdr.

Direct replies to the stable Worker card are deliberately not overloaded in the
initial migration: without a callback payload they cannot prove which visual
card revision the user saw. Users use explicit card actions for current-turn
steer or follow-up and `发起新任务` for unrelated work. Existing explicit `/to`
and `/steer` commands retain their documented semantics.

## Historical Task Cards and Migration

Previously delivered Task Cards cannot be deleted or safely rewritten as part of
this change. They become frozen historical artifacts:

- no new Task Card messages or continuation messages are created after rollout;
- callbacks and contextual replies from old Task Cards fail closed with guidance
  to use the current Worker card;
- old message/card identifiers remain stored for audit and idempotent delivery
  recovery;
- pending pre-rollout Task Card outbox work is classified by migration. Create
  intents that have never reached Lark are cancelled or superseded durably; an
  uncertain or possibly delivered effect is not replayed or guessed;
- Worker-turn rows and output pages remain readable historical records even when
  their `messageId` and `cardId` are null.

An idempotent schema migration adds only the fields or nullable delivery
semantics required by the consolidated projection. It does not rewrite turn
identity, queue order, canonical output, or historical audit records.

## Delivery, Recovery, and Failure Handling

- Persist the turn and Main View intent before reserving any Lark update.
- Serialize create, live update, terminal update, and next-turn switch on the
  stable Worker lane.
- Use view-version compare-and-swap so delayed updates cannot overwrite a newer
  task projection.
- A Lark retry repeats only card delivery. It never repeats a prompt, steer, or
  stop effect.
- If the stable card has not been delivered yet, task execution and history still
  proceed; startup or normal convergence retries the card create/update.
- If a card update dead-letters, retain the durable current turn and quarantine
  only the delivery lane according to existing policy.
- Reconciliation derives the current task from SQLite and exact Herdr/TraeX
  ownership, never from visible card contents.
- Unknown or uncertain prompt settlement retains the existing no-replay rule and
  is shown as dispatch uncertain.

## Implementation Boundaries

The implementation should deepen existing modules rather than let coordinators
render cards directly:

- extend the Worker session projection in `domain/worker-main-view.ts`;
- render the consolidated presentation in `cards/worker-main-card.ts`;
- replace per-turn visible delivery planning with a session-keyed convergence
  workflow;
- keep exact turn storage and output capture behind projection-store ports;
- centralize stable-card action ownership in `worker-card-ownership.ts`;
- migrate SQLite transitions atomically in the existing store capability graph;
- retire visible `WorkerTurnCardWorkflow` and Task Card creation only after all
  producers and recovery paths use the stable card.

The old turn-card domain may remain temporarily as an internal history shape, but
there must be one visible Worker-card writer after migration. The Main Card must
not call the Task Card renderer or treat old card payloads as state.

## Testing and Acceptance

### Domain and rendering

- one session identity keeps one stable card target across several turns;
- queued, preparing, running, blocked, terminal, and uncertain phases render the
  correct content and actions;
- a new current turn replaces the live region while retaining bounded recent
  history;
- output, progress, secrets, and payload size remain bounded;
- a new session generation produces a distinct frozen-old/current-new pair.

### Persistence and delivery

- accepting multiple turns creates no per-turn card-create outbox records;
- all visible Worker updates use the stable session lane and monotonic versions;
- terminal update and next-turn switch are ordered without blocking scheduling;
- restart converges a missing or stale Worker card from durable state;
- duplicate lifecycle events and callbacks do not duplicate prompts or delivery
  intent;
- migration handles pending, delivered, and uncertain legacy Task Card intents
  without replaying an external effect.

### Interaction fencing

- a callback for the displayed active turn can steer or stop only that exact turn;
- a callback carrying the prior turn ID is rejected after the stable card switches;
- stale message, binding, runtime generation, and Worker session generation are
  rejected;
- independent new-task submission remains FIFO and cannot become a steer;
- legacy Task Card callbacks and replies fail closed.

Run focused Worker Main rendering, ownership, card interaction, store, outbox,
concurrency, steering, observer, and reconciliation tests. Then run
`npm run typecheck`, `npm run build`, and the full `npm test` suite because the
change spans workflow, persistence, presentation, and recovery. A real configured
smoke is required only if implementation changes TraeX dispatch or exact-turn
transport rather than projection and delivery alone.

## Rollout

Deploy the schema and dual-read-compatible migration before deleting obsolete
visible-card code paths. On startup, converge one Worker Main View per active
session and suppress never-delivered legacy Task Card creates. Observe outbox
lane health, stable-card version lag, stale-action rejection counts, and duplicate
Worker-card creation. Removal of legacy schema columns can occur only in a later
cleanup after production has no recovery dependency on them.

## Non-goals

- Deleting durable turn history or canonical output.
- Remote approval, arbitrary terminal input, or pane/process kill.
- Cancelling queued turns.
- Automatically retrying failed or uncertain turns.
- Creating a separate card for full historical-output browsing in this phase.
- Changing Primary Main or Answer Card lifecycle.
