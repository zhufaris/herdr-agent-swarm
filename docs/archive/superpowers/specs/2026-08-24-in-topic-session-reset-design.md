# In-topic Session Reset Design

## Goal

Add `/new [title]` as a reset command for an already active Lark topic. It
starts a fresh Herdr pane and TraeX session for the same configured project,
while the user continues in the same Lark topic. It is deliberately different
from `/herdr new`, which creates a project-selection flow and a new Lark topic.

The reset may be requested while the prior session is working, blocked, or has
queued prompts. The bridge must not remotely stop that TraeX process or replay
any of its work. Once reset begins, the topic follows only the new session.

## User experience

In an active project topic, a user sends:

```text
/new
/new investigate flaky login test
```

The bridge immediately records that the old session has been detached from the
topic, then provisions a fresh pane in the same project and attaches that new
binding to the existing topic. Bare `/new` uses `新会话` as the pane-task title;
the optional title replaces it. The resulting Herdr pane title continues to use
the existing project/Space formatting.

The response makes the effect explicit: the former pane remains running in
Herdr, but its later output will no longer appear in this Lark topic. Ordinary
messages after successful provisioning become prompts for the new pane.

`/new` is rejected with an actionable card when the message is not in an active
attached topic binding. It does not create a project selector, infer a project
from an unbound topic, or accept a target pane/workspace from the user.

## Durable handoff and failure semantics

The topic can have only one current binding. The existing `bindings.topic_id`
unique constraint remains the invariant. Reset therefore uses a durable
handoff transaction before calling Herdr:

1. Verify the existing active binding has a configured `projectId`.
2. Mark all not-yet-started ordinary and steering prompts on the old binding
   cancelled with the reason that the topic started a new session. Emit their
   durable cancellation projections before suppressing old delivery.
3. Mark an in-flight prompt as observation-detached when one is known. The
   coordinator aborts only its local waiter; it never sends a stop command to
   Herdr or TraeX.
4. Move the current topic/root identifiers from the old binding into immutable
   retired-topic audit fields, clear the current identifiers, and archive the
   old binding immediately. This is not the ordinary `/herdr close` draining
   transition: it must not wait for the old turn to finish.
5. Suppress pending outbound work owned by the old binding, retaining the rows
   and audit history but preventing old terminal/card updates from arriving
   after the handoff.
6. Create a new `provisioning` binding for the same project, chat, topic ID,
   and root message ID in the same transaction. Its pane fields are initially
   empty and its generation starts at one because it is a distinct session.

The transaction commits either the complete ownership transfer or none of it.
It also records a reset audit event containing the actor, old binding ID, and
new binding ID. No external Herdr call occurs inside the SQLite transaction.

After that commit, provisioning follows the existing checkpointed creation
sequence except that it creates no Lark topic: `selected -> pane_created ->
runtime_started -> thread_created -> activated`, with `thread_created` meaning
the already-owned topic was associated with the new binding. The active topic
card is replaced using the new binding's view.

If pane creation or TraeX startup fails after the handoff, the new binding
becomes `failed`; the old binding remains archived and detached. The bridge
does not restore its topic identifiers, because the external creation call may
have succeeded despite an uncertain response. A durable failure card explains
that the old session is still available in Herdr and tells the user to retry
`/herdr attach <space> <pane>` to attach a surviving new pane; it does not
automatically retry `/new`, because the original create call may have succeeded.
Startup recovery must never automatically create another pane for a reset
binding left at `selected`; it uses the same inspect-and-attach rule as other
uncertain provisioning.

## Isolation from the previous session

Reset is a Lark-routing boundary, not a process termination feature:

- The old Herdr pane and TraeX process keep running.
- The old binding is excluded from reconciliation, detached-turn observation,
  queue dispatch, and future topic-card delivery.
- A locally active observer is aborted and its prompt is recorded as detached,
  so no final result is inferred or replayed. Its abort path must not publish a
  later run-card update once the binding is retired.
- Pending old outbox rows are marked suppressed/dismissed atomically with the
  handoff. Already-delivered cards remain visible as immutable history.
- The old binding preserves its pane, terminal identity, project, prompts, run
  cards, lifecycle events, and retired Lark identifiers for audit and Herdr
  investigation.

`/herdr close` keeps its current draining behavior. `/new` is the only path
that immediately detaches a working binding while leaving its process alive.

## Components

- `src/domain/commands.ts` parses only the top-level `/new [title]` command;
  `/herdr new` remains unchanged.
- `src/domain/types.ts` adds the `reset` command and retired Lark-scope fields
  on `Binding`.
- `src/domain/ports.ts` exposes one store operation for the atomic handoff and
  a targeted turn-observer abort operation. The coordinator does not assemble
  multi-row reset mutations itself.
- `src/store/sqlite-store.ts` adds additive columns/indexes and implements the
  fenced transaction that archives/releases the old binding, cancels pending
  work, suppresses its outbox rows, and creates the replacement binding.
- `src/coordinator/turn-supervisor.ts` supports aborting one active observer.
- `src/coordinator/sync-coordinator.ts` validates and invokes the handoff,
  provisions the replacement against the existing topic, and emits a reset
  lifecycle/status card. It guards all old-observer completion paths against
  publishing after retirement.
- `src/cards/run-card.ts` and `docs/feishu-group-usage.md` describe `/new` and
  distinguish it from `/herdr new`.

No remote stop/approval API, cross-project reset, topic creation, or prompt
transfer is introduced.

## Verification

Focused automated coverage will prove:

1. parsing accepts `/new` and `/new title` but preserves `/herdr new`;
2. unbound, archived, provisioning, and missing-project bindings reject reset;
3. an idle reset atomically archives/releases the old scope and activates a new
   binding using the same topic/root IDs and project;
4. a working or blocked reset aborts only the local observer, leaves the fake
   Herdr pane running, cancels queued/steering prompts, and creates no second
   dispatch to the old pane;
5. delayed old output or completion produces no post-reset Lark delivery;
6. pending old outbox rows are suppressed while delivered history remains;
7. pane-create/start failures leave the old binding retired and the new one
   failed with a recoverable, non-replaying user notice;
8. duplicate Lark event delivery is idempotent; and
9. reset creation never calls `lark.createTopic`.

After the focused tests, run `npm run typecheck`, `npm run build`, and the full
`npm test` suite because the change spans command routing, persistence,
reconciliation, and delivery.
