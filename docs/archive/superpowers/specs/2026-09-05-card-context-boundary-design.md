# Card Context Boundary Design

**Date:** 2026-09-05
**Status:** Approved design

## Summary

Card updates are a durable context-projection boundary, not a rendering-time
join. Herdr Agent Swarm will maintain four independently versioned card
aggregates:

1. the Primary Main Card for one Primary session;
2. the Primary Answer Card for one Primary turn;
3. a new Worker Main Card for one Worker session generation; and
4. the existing Worker Task Card for one Worker turn.

Each card owns a bounded context and receives a complete persisted view. A
renderer remains pure: it cannot query SQLite, Herdr, Lark, another view, or
another card payload. Domain transitions persist direct projections and durable
context invalidations before best-effort wake-ups. Independent outbox lanes
then converge each card to its latest durable version without replaying Agent
work.

## Goals

- Give operators one persistent overview card for every Worker session.
- Make card content ownership explicit across Primary, Answer, Worker, and task
  scopes.
- Show bounded Worker summaries in the Primary Main Card and the originating
  Primary Answer Card without copying Worker output.
- Preserve exact-turn ownership, Answer pagination, frozen-page behavior,
  durable outbox delivery, and no-replay recovery.
- Coalesce high-frequency aggregate updates while keeping lifecycle boundaries
  such as blocked, terminal, and terminated promptly visible.
- Make card reconstruction deterministic after process restart.

## Non-goals

- Embedding Worker request or result bodies in aggregate cards.
- Turning Lark cards into workflow authority.
- Reading Herdr or Lark while rendering a card.
- Replacing the existing per-task Worker Task Card.
- Patching a frozen Answer page after Primary Answer finalization.
- Inferring delegation from timestamps, names, or concurrent activity.
- Replaying a Primary prompt, Worker task, steer, or interrupt because card
  delivery or rebuilding failed.

## Selected Architecture

The selected design uses independent persisted context projections plus a
durable invalidation queue. It rejects two alternatives:

- **Direct event fan-out:** every Worker event updates all cards inline. This
  duplicates selection, transaction, and version policy across handlers and
  amplifies high-frequency output.
- **Renderer-time joins:** every renderer queries bindings, prompts, Workers,
  and turns. This makes the same view version render differently over time and
  prevents deterministic outbox retry and startup recovery.

The selected flow is:

```text
Domain transition
       |
       v
Durable projection transaction
       |
       +--> direct task projection
       +--> Worker Main projection or invalidation
       +--> Primary Main invalidation
       `--> mutable Primary Answer invalidation
                    |
                    v
             best-effort wake-up
                    |
                    v
          CardContextRebuilder workers
                    |
                    v
          independent latest-version lanes
```

## Context Ownership

```text
Primary Session
|
+-- PrimaryMainView
|   +-- Primary identity and runtime
|   +-- active Primary turn summary
|   +-- Primary queue summary
|   `-- bounded WorkerSummary[]
|
+-- Primary Turn
|   `-- PrimaryAnswerView
|       +-- request
|       +-- Primary progress and answer
|       `-- WorkerActivitySummary[] for this turn
|
`-- Worker Session Generation
    |
    +-- WorkerMainView
    |   +-- Worker identity and runtime
    |   +-- owning Primary identity
    |   +-- active task summary
    |   +-- queued task summary
    |   `-- five most recent terminal tasks
    |
    `-- Worker Turn
        `-- WorkerTaskView
            +-- task request
            +-- exact runtime-turn identity
            +-- live progress
            +-- streamed result
            `-- terminal outcome
```

### Shared reference contract

Cross-card relationships use stable references, not copied content:

```ts
interface CardTargetRef {
  aggregateKind:
    | "primary-session"
    | "primary-turn"
    | "worker-session"
    | "worker-turn";
  aggregateId: string;
  generation: number;
  messageId: string | null;
}
```

`messageId=null` means that the target card has not reached its delivery
checkpoint. The source card may show the target state but must hide the link.
When delivery records the target message ID, it invalidates dependent views so
their next snapshot can add the link. A card never constructs an unconfirmed
Lark URL.

## Card Contracts

### Primary Main Card

The Primary Main Card owns the whole Primary session overview.

```text
+-- Project / Primary --------------------------------+
| Project | Space | Pane | Model | Context usage      |
| Primary state | Active turn | Queue depth           |
+-- Workers ------------------------------------------+
| reviewer  Working  Review auth flow        Q: 1     |
| tester    Blocked  Run integration tests   Q: 0     |
| docs      Idle     No active task          Q: 0     |
+-----------------------------------------------------+
| Session controls                                    |
+-----------------------------------------------------+
```

Each Worker row contains only its name, state, current task title, ordinary
queue count, and Worker Main Card reference. It never contains Worker task
text, detailed progress, result text, or error stacks.

Only Workers owned by the exact current Primary binding and parent pane may be
selected. Rows sort by `blocked`, `working`, `queued`, `idle`, then stable
creation identity. The card shows at most eight active Workers; overflow is a
count plus a directory entry. A terminated Worker leaves the active list.

### Primary Answer Card

The Primary Answer Card owns one Primary turn and shows bounded delegation
activity for tasks directly created by that turn.

```text
+-- Primary Turn -------------------------------------+
| Request                                             |
| Primary plan and progress                           |
+-- Delegated Worker Activity -----------------------+
| reviewer  Completed  Review auth flow       [open] |
| tester    Working    Run integration        [open] |
+-- Primary Answer ----------------------------------+
| Primary-produced streamed answer                    |
+-----------------------------------------------------+
```

Delegation ownership comes only from the durable parent relation:

```text
Primary Prompt ID
       |
       `--> WorkerTurn.actor.parentPromptId
```

It is never inferred from time overlap, Worker name, or activity state. Follow-
ups with the same parent Primary prompt remain in the same activity group. Each
Worker is a bounded row showing name, latest task status, task count, and the
latest relevant Task Card reference. Worker output is never copied into the
Answer View; the Primary remains responsible for synthesis.

The streamed Answer content and Worker summary are independent elements. A
Worker-summary refresh must not rewrite answer text, sequence, page start, or
canonical source offsets. While the active Answer page is mutable, Worker
activity may refresh. Primary Answer finalization persists the final summary
and freezes it with the page. Late Worker changes never patch a frozen Answer
page.

```text
Primary Answer active
        |
        +--> Worker summary may refresh
        |
        v
Primary Answer finalized
        |
        +--> freeze answer and Worker summary snapshot
        |
        `--> late Worker updates
                +--> Worker Task Card
                +--> Worker Main Card
                `--> Primary Main Card
```

### Worker Main Card

The Worker Main Card is a new aggregate for one Worker session generation.

```text
+-- Worker: reviewer ---------------------------------+
| Owner: Primary / pane-42                            |
| Session generation: 3 | Runtime: working            |
| Workspace | Branch | Model                          |
+-- Current Task -------------------------------------+
| Review authentication flow             Working      |
| Started 02:14 ago                          [open]   |
+-- Queue --------------------------------------------+
| 2 queued | next: Verify refresh-token recovery      |
+-- Recent Tasks -------------------------------------+
| Completed  Review API boundary       01:22  [open] |
| Failed     Run browser smoke         00:38  [open] |
| Completed  Inspect migrations        03:10  [open] |
+-----------------------------------------------------+
```

It contains Worker identity/runtime, owning Primary identity, one active task,
queue count and next task title, and the five most recent terminal tasks. Task
summaries contain title, state, duration, and Task Card reference only. They do
not contain task bodies, results, reasoning, or terminal content.

The card is bound to `(workerId, workerSessionGeneration)`, not a pane or runtime
generation:

```text
created
   |
   v
active <------ runtime restart / reattach / pane replacement
   |
   +------> blocked
   +------> idle
   `------> terminated ----> frozen forever

same-name recreation -----> new Worker session generation and card
```

Runtime replacement continues to update the same card. Worker termination
produces one final snapshot and rejects all later updates for that session
generation. Recreating a same-name Worker cannot reuse or unfreeze the old
card.

### Worker Task Card

The existing one-task-per-card aggregate remains authoritative for a Worker
turn. It continues to own request text, exact runtime-turn identity, structured
progress, streamed result, and terminal outcome. It gains references back to
the Worker Main Card and, when applicable, the originating Primary Answer Card.
It never contains sibling tasks or Worker history. Existing stream ordering,
page continuation, and freeze semantics remain unchanged.

## Worker Session Identity

The implementation must distinguish session lifetime from runtime identity:

```text
Worker session identity       Worker runtime identity
-----------------------       -----------------------
workerId                      paneId
workerSessionGeneration       runtimeGeneration
parent binding and pane       nativeSessionId
creation and termination      current process/runtime
```

Creating a new Worker session advances `workerSessionGeneration`. Restart,
reattach, pane replacement, and native Agent session renewal alter runtime
identity without changing the Worker Main Card key. The exact parent binding,
parent pane, and session generation fence every aggregate update.

## Durable Update Protocol

Business state and refresh intent commit together. Payload rebuilding may occur
afterward, but a crash cannot lose the need to refresh a dependent card.

```text
Worker runtime / task event
            |
            v
+---------------- SQLite transaction ----------------+
| 1. Update Worker aggregate or turn                  |
| 2. Reduce WorkerTaskView when applicable            |
| 3. Reduce WorkerMainView or mark it stale           |
| 4. Mark exact PrimaryMainView generation stale      |
| 5. Mark exact mutable PrimaryAnswerView stale       |
| 6. Persist dependency revisions                     |
+-------------------------+---------------------------+
                          |
                          v
                 best-effort wake-up
                          |
                          v
                 CardContextRebuilder
                          |
          +---------------+----------------+
          |               |                |
          v               v                v
     Worker Main     Primary Main    Primary Answer
       snapshot        snapshot          snapshot
```

Direct task projection remains in the originating transition because it owns
the exact task aggregate. Aggregate projections may be invalidated and rebuilt
from a transactionally consistent SQLite snapshot. Rebuilders never read Herdr
or Lark; live facts must first enter SQLite through normal reconciliation.

### Durable invalidation

```ts
interface CardContextInvalidation {
  targetKind: "primary-main" | "primary-answer" | "worker-main";
  targetId: string;
  targetGeneration: number;
  reason:
    | "worker-created"
    | "worker-runtime-changed"
    | "worker-turn-accepted"
    | "worker-turn-started"
    | "worker-turn-progressed"
    | "worker-turn-finished"
    | "worker-terminated"
    | "target-card-delivered";
  dependencyRevision: number;
  createdAt: string;
}
```

The store coalesces invalidations by
`(targetKind, targetId, targetGeneration)`, retaining the highest requested
dependency revision. Rebuild completion advances
`projectedDependencyRevision`. Lost, duplicated, or reordered wake-ups are safe
because startup and periodic scanning compare the two revisions.

### Rebuild algorithm

```text
1. Claim one target invalidation.
2. Read a transactionally consistent SQLite snapshot.
3. Select and bound the target context.
4. Compare persisted rendered fields.
5. If unchanged, advance projectedDependencyRevision only.
6. If changed:
     a. save View with viewVersion + 1;
     b. reserve or coalesce the target outbox payload;
     c. advance projectedDependencyRevision.
7. Commit.
8. Wake the outbox dispatcher.
```

Blocked, terminal, terminated, and link-checkpoint changes receive immediate
wake-ups. High-frequency progress may be coalesced, but its durable invalidation
must still be recorded.

## Independent Delivery Lanes

```text
worker-task:<turnId>
worker-main:<workerId>:<workerSessionGeneration>
primary-main:<bindingId>:<bindingGeneration>
primary-answer:<promptId>:<bindingGeneration>
```

The Worker Task lane preserves ordered stream-page semantics. The other three
are replaceable latest-snapshot lanes:

- a newer version replaces an older pending payload;
- a delivering payload is immutable and may finish;
- if the durable view advances during delivery, the latest version is sent
  afterward;
- `deliveredVersion` advances only at a successful delivery checkpoint;
- permanent failure is isolated to one lane; and
- startup convergence recreates missing intent whenever
  `viewVersion > deliveredVersion`.

A card delivery retry cannot submit, steer, interrupt, or otherwise repeat Agent
work.

## Update Policy

```text
Transition                    Task      Worker Main   Primary Main   Answer
-------------------------------------------------------------------------
Worker created                  -         immediate      coalesce       -
Worker runtime changed          -         immediate      coalesce       -
Task accepted                immediate    immediate      coalesce    coalesce
Task started                 immediate    immediate      coalesce    coalesce
Progress or output           immediate    coalesce       coalesce    coalesce
Task blocked                 immediate    immediate      immediate   immediate*
Task completed or failed     immediate    immediate      immediate   immediate*
Worker terminated               -         freeze         immediate   immediate*
Target card delivered           -         relink         relink      relink*

* only while the active Answer page remains mutable
```

“Immediate” means durable projection/outbox reservation followed by a wake-up,
never a synchronous Lark call. “Coalesce” means that only the latest target
version needs delivery.

## Module Boundaries

```text
Domain transitions
        |
        v
+---------------- Card Context Projection ----------------+
| WorkerTaskProjector    existing exact-turn projection   |
| WorkerMainProjector    new Worker-session aggregate     |
| PrimaryMainProjector   extends existing TopicView       |
| PrimaryAnswerProjector extends existing RunCardView     |
+-------------------------+-------------------------------+
                          |
                          v
+---------------- Context Dependency Index ----------------+
| Worker session -> Primary binding                        |
| Worker turn    -> Worker session                          |
| Worker turn    -> parent Primary prompt                   |
| delivered card -> dependent aggregate references         |
+-------------------------+-------------------------------+
                          |
                          v
              durable invalidation and rebuilding
                          |
                          v
                  pure renderer -> outbox
```

New focused modules:

```text
src/domain/card-context.ts
src/domain/worker-main-view.ts
src/events/card-context-projector.ts
src/events/card-context-rebuilder.ts
src/cards/worker-main-card.ts
```

Existing boundaries change as follows:

- `topic-view.ts` gains bounded Worker summaries and a Worker dependency
  revision.
- `run-card-view.ts` gains bounded Worker activity, its dependency revision,
  and the point at which Worker context froze.
- `worker-turn-card-view.ts` gains stable navigation references.
- `conversation-view-projector.ts` consumes normalized context changes rather
  than querying Worker tables.
- `sqlite-store.ts` implements transactions and migration, but does not choose
  presentation policy.
- all card renderers remain pure functions over one complete view.

## Persistence

Add the following durable structures:

```text
worker_main_views
  worker_id
  worker_session_generation
  parent_binding_id
  parent_binding_generation
  parent_pane_id
  state_json
  view_version
  delivered_version
  message_id
  card_id
  frozen_at
  created_at
  updated_at

  UNIQUE(worker_id, worker_session_generation)

card_context_invalidations
  target_kind
  target_id
  target_generation
  requested_dependency_revision
  projected_dependency_revision
  reason
  created_at
  updated_at

  UNIQUE(target_kind, target_id, target_generation)
```

Primary Main remains in `topic_views`; Primary Answer remains in
`run_cards_view`; Worker Task remains in `worker_turn_cards`. The design does
not introduce duplicate sources of truth for existing card aggregates.

## Migration and Startup Convergence

```text
Existing database
      |
      +--> add Worker session generation
      +--> create Worker Main views
      +--> create context invalidations
      +--> add bounded summary defaults
      |
      v
Startup convergence
      +--> create initial view for safely identified active Workers
      +--> freeze safely identified terminated legacy Workers
      +--> invalidate exact Primary Main generations
      `--> invalidate active mutable Primary Answers
```

Migration never calls Lark or Agent operations. A legacy Worker without a safe
parent binding, parent pane, or session identity is not automatically attached
to a Primary projection. A frozen Answer is never reopened. Initial card
creation happens through the normal outbox after migration.

## Security and Data Handling

```text
Raw runtime / transcript
          |
          v
bounded parsing and redaction
          |
          v
domain transition
          |
          v
persisted card projection
          |
          v
pure renderer
          |
          v
durable outbox
```

- Raw transcript records, protocol messages, reasoning, terminal scrollback,
  and prompt echoes never enter aggregate views.
- Request text appears only in its owning Primary Answer or Worker Task Card.
- Worker result text appears only in its Worker Task Card.
- Exact generation, parent binding/pane, and turn ownership fence all updates.
- A delayed old-generation event cannot update a replacement card or unfreeze
  a terminated Worker card.
- Delivery errors and diagnostics contain identifiers and versions, not task or
  answer bodies.

## Testing and Acceptance

### Reducers and selectors

- Worker runtime restart keeps the same Worker Main Card.
- Worker termination freezes the exact session generation.
- Stale generation changes are ignored.
- Current task, queue summary, and five-item terminal history are bounded and
  stably ordered.
- Primary Main selects only Workers owned by its exact Primary pane.
- Primary Answer selects only Worker turns with the exact parent prompt ID.
- Aggregate views contain no Worker request or result bodies.
- Duplicate or unchanged rebuilds do not advance view versions.

### Rendering

- Every renderer is deterministic over one view and has no store dependency.
- Missing delivery references hide links without hiding state.
- Delivery checkpoints add links through invalidation and rebuilding.
- Frozen Worker and Answer views expose no live mutation controls.
- Answer Worker-summary updates preserve stream element IDs, page starts,
  sequence, and canonical source offsets.

### Transactions and recovery

- A Worker transition and all required invalidations commit atomically.
- Sibling Primary bindings and unrelated Answers are never invalidated.
- Committed invalidations survive lost wake-ups and process restarts.
- Rebuild and outbox recreation are idempotent.
- No recovery path replays Agent work.
- Permanent failure in one card lane does not block another lane.
- High-frequency progress coalesces aggregate payloads while Task stream order
  remains intact.

### Product flow

```text
Primary turn
  |
  +--> creates Worker
  |     `--> Worker Main Card appears
  |
  +--> submits Worker task
  |     +--> Worker Task Card appears
  |     +--> Worker Main shows current task
  |     +--> Primary Main shows Worker summary
  |     `--> mutable Answer shows delegation summary
  |
  +--> Worker completes
  |     +--> Task Card completes
  |     +--> Worker Main moves task to recent history
  |     +--> Primary Main shows Worker idle
  |     `--> Answer updates only if still mutable
  |
  `--> Worker terminates
        +--> Worker Main freezes
        `--> Primary Main removes it from active Workers
```

Before handoff, run the focused reducer, renderer, SQLite projection, outbox,
Primary/Worker flow, and Answer streaming/recovery tests, followed by
`npm run typecheck`, `npm run build`, and the full Vitest suite.
