# Trace-End Next-Input Notification

## Problem Statement

Herdr Agent Swarm currently sends one-time Feishu Human Review notification
cards when a Primary or Worker enters a durable `blocked` episode. A normally
completed turn updates its Answer or Worker Turn card, but it does not send a
mention notification that tells the binding creator that the Agent is now
ready for another request.

The desired behavior is to notify the creator after a real turn completion
only when the same Agent has no already-accepted successor input. A raw
provider `stop reason` is not a stable boundary: Herdr Core already translates
provider transcript semantics into `turn_completed` and
`turn_aborted(reason)`, and completed Core events intentionally do not expose
the provider-specific reason.

## Solution

Use Herdr Core's normalized `turn_completed` fact, as consumed by the existing
Primary and Worker completion paths, to reserve an immutable Feishu
next-input notification card. The terminal state transition, card projection,
successor-input decision, and outbound intent reservation commit in one SQLite
transaction. The existing outbox then delivers or retries the card without
submitting or replaying Agent input.

Suppress the notification when the same current owner and generation already
has queued or active successor work. When the notification is eligible, mention
the persisted creator Open ID if it passes the existing Feishu identifier
validation; otherwise send the same bounded notification card without a
mention and record that omission in structured logs.

This is a Swarm-only change. It does not alter Herdr Core, the normalized Core
event schema, Agent sessions, prompt FIFO behavior, Human Review notifications,
or Feishu's role as a presentation surface.

## User Stories

### SCN-1: Primary completes with no successor input

When a current-generation Primary Prompt reaches a proven `turn_completed`
terminal transition and no successor Prompt is queued or active for the
Binding, Swarm posts one notification card under the Binding's configured
Feishu root. The card mentions the Binding creator when possible and states
that the current task is complete and the Primary is waiting for new input.

### SCN-2: Worker completes with no successor input

When a current Worker Session generation completes a Worker Turn and no
successor Turn is queued or active for that Worker generation, Swarm posts one
notification card through the parent Binding route. The card identifies the
Worker and completed task, mentions the parent Binding creator when possible,
and includes the existing safe Worker Main Card navigation action when that
target is available.

### SCN-3: Accepted successor work suppresses notification

When successor work for the same owner and generation was accepted before the
completion transaction, Swarm does not reserve a next-input notification. The
existing scheduler can claim and dispatch that successor without an
unnecessary user mention. Work for another Binding, Worker, or generation does
not suppress the notification.

### SCN-4: Concurrent new input has a deterministic outcome

SQLite transaction ordering decides the race between completion and new input.
If input acceptance commits first, the completion observes it and suppresses
the notification. If completion commits first, the notification remains a
correct statement about the completion boundary; subsequently accepted input
continues through the normal queue.

### SCN-5: Duplicate and recovery observations remain one-shot

Repeated Core delivery, observer reconnects, detached recovery, projection
repair, and process restart do not reserve a second notification for the same
owner generation and Prompt or Turn. A persisted outbound intent survives
restart and delivery retry without repeating Agent input.

### SCN-6: Non-completion terminal outcomes do not request new input

`turn_aborted(reason)`, failed, cancelled, interrupted, uncertain, and stale
identity outcomes do not produce this notification. They retain their existing
failure, cancellation, or recovery presentation. Existing `blocked` Human
Review requested/resolved cards remain separate; a later real completion can
still create one next-input notification when no successor input exists.

## Implementation Decisions

### Domain Model

The affected context is **Agent Work Coordination**, with the existing
**Feishu Delivery** context as an asynchronous downstream consumer.

- A **terminal completion** is the existing, normalized fact that the exact
  Prompt or Worker Turn completed successfully. Swarm does not reinterpret raw
  provider stop reasons.
- **Successor input** means already-accepted nonterminal work for the same
  owner and generation. For a Primary this is work on the same Binding; for a
  Worker this is work on the same Worker Session generation.
- A **next-input notification** is a one-shot immutable presentation effect of
  an eligible terminal completion. It is not an Agent state, a new queue item,
  a Human Review episode, or permission to enter text remotely.
- The authoritative creator identity remains the persisted Binding
  `creatorOpenId`. A Worker uses its exact current parent Binding route rather
  than introducing a second user-identity source.

The one-shot notification has no open/resolved lifecycle, so the existing
outbox idempotency identity is sufficient durable evidence; no new episode
table is introduced.

#### Invariants

- **INV-1 — Exact terminal ownership:** only a completion that passes the
  existing Binding/Worker generation, Pane, Agent Session, runtime Turn, and
  lifecycle fences may reserve a notification.
- **INV-2 — No accepted successor:** a notification is eligible only when no
  nonterminal successor input for the same owner and generation exists in the
  completion transaction.
- **INV-3 — One completion, at most one notification:** duplicate observation,
  recovery, restart, and delivery retry cannot create another logical intent
  for the same owner generation and Prompt or Turn.
- **INV-4 — Intent before delivery:** terminal workflow state and the outbound
  intent commit atomically before Feishu delivery. Delivery failure cannot
  repeat the terminal transition or Agent input.
- **INV-5 — Safe routing and mention:** a Worker notification may use only its
  exact current parent Binding route, and a creator is mentioned only when the
  persisted Open ID passes the existing allowlisted identifier validation.
- **INV-6 — Semantic terminal classification:** only successful completion
  requests new input. Abort, failure, cancellation, uncertainty, and blocked
  review remain distinct outcomes.

The Primary completion transaction enforces INV-1 through INV-4 for Binding
Prompts. The Worker Turn transition transaction enforces the same invariants
for Worker Sessions. The existing route decision and Feishu Open ID validation
enforce INV-5. Herdr Core normalization and the existing completion/abort
branches enforce INV-6.

### Architecture

The existing internal completion-store interfaces are extended with the
minimum presentation dependency and result needed to reserve and report an
eligible notification. Coordinators continue to observe turns and wake
workers; they do not independently check queue depth or send Feishu cards.

Within each existing terminal transaction, the store must:

1. verify and apply the exact terminal transition;
2. update the owning Answer or Worker Turn projection;
3. query nonterminal successor work scoped to the same owner generation;
4. when none exists, render the bounded notification through the injected
   presentation function and enqueue an immutable `card_reply` intent with a
   stable idempotency key;
5. return whether an outbound intent was reserved so the coordinator can wake
   the existing outbound dispatcher.

Primary idempotency is scoped by Binding ID, Binding generation, and Prompt ID.
Worker idempotency is scoped by Worker ID, Worker Session generation, and Turn
ID. The exact string encoding remains an adapter/store detail, but it must be
stable across restart and all recovery entry paths.

The new pure card renderers accept only bounded internal notification inputs.
They reuse secret redaction, Lark Markdown bounding, Pane display identity,
Feishu Open ID validation, and the existing Worker Main navigation callback.
No coordinator imports the Lark SDK, and no domain rule imports a concrete
delivery adapter. Concrete renderers and stores remain assembled in the
composition root through the existing presentation and capability graphs.

All completion entry paths, including attached observation, detached
observation, externally adopted turns, and projected Core recovery, must reach
the same atomic eligibility/reservation seam. A path that can terminalize the
work but bypass the seam would violate INV-3 and INV-4.

### Behavior & Failure Modes

Queue suppression is evaluated from durable rows inside the terminal
transaction rather than from `TurnCompleted.payload.queueDepth`, a prior
runtime snapshot, or a coordinator pre-check. SQLite serialization supplies the
approved conflict ordering in SCN-4.

An invalid or missing creator Open ID does not block the completion or card
projection. Swarm reserves the card without a mention and emits a bounded
structured outcome. A stale Worker parent route or stale terminal identity
prevents notification reservation; existing workflow handling decides whether
the underlying terminal transition is also stale.

Outbox insert failure rolls back the terminal transaction. Feishu transport
failure occurs after commit and is retried by the existing outbox. A permanent
delivery failure follows existing dead-letter and lane behavior and never
causes Agent replay.

Existing blocked Human Review requested/resolved notifications are preserved.
Their episode identity and local-approval message remain distinct from the
one-shot next-input notification.

### Compatibility & Migration

No Herdr Core release, public Core schema change, Session replacement, or
configuration change is required. Existing databases need no new business
table because outbound intent idempotency owns one-shot deduplication. Any new
outbox intent uses existing reply kinds, target roles, lane behavior, retry,
retention, and lease fencing.

Historical completed turns are not backfilled. Only terminal completions
committed after the new code is active are eligible.

## Testing Decisions

- Card unit tests verify Primary and Worker wording, safe identity display,
  bounded/redacted task text, valid creator mention, invalid/missing creator
  fallback, and the Worker Main navigation action.
- SQLite/store tests exercise SCN-1 through SCN-6 at the public Primary and
  Worker terminal-transition seams. They assert the terminal row, card
  projection, queue decision, exact outbox count, target route, idempotency key,
  and rollback behavior.
- Concurrency-oriented integration tests commit accepted successor input before
  completion and completion before accepted successor input, demonstrating the
  two approved SCN-4 outcomes rather than only sequential queue checks.
- Recovery tests repeat attached, detached, external-adoption, and projected
  Core completion paths and reopen the SQLite store to prove INV-3 and INV-4.
- Rejection tests cover stale Binding/Worker generation, stale Pane/Session or
  runtime Turn identity, stale Worker parent route, and all non-completion
  terminal outcomes.
- Architecture checks verify that notification renderers remain presentation
  dependencies injected into store/application seams and that no Swarm module
  begins parsing provider stop reasons.

Affected verification includes focused card, SQLite, Primary completion,
Worker completion, recovery, and concurrency tests, followed by
`npm run typecheck`, `npm run build`, `npm run architecture:check`, and the full
`npm test` suite.

## Out of Scope

- Adding or changing Herdr Core events or preserving raw provider stop reasons.
- Sending a notification while already-accepted successor work exists.
- Periodic reminders while an Agent remains idle.
- Retrospective notifications for historical completed turns.
- Remote approval, arbitrary terminal input, or process/Pane control from the
  notification card.
- Removing or redesigning existing blocked Human Review notifications.
- Installing, deploying, restarting, or live-testing the service.
- The separate Feishu in-session model-selection change.

## Further Notes

- Workspace mode: isolated linked worktree, selected because the main checkout
  contains concurrent uncommitted changes that overlap Primary Prompt
  completion and dispatch files.
- Worktree:
  `.trae/worktrees/trace-end-next-input-notification`
- Branch: `feat/trace-end-next-input-notification`
- Starting revision: `55cf73104f072bab4d6bd4bc5724c9bc0d553332`
- Initial changes in the isolated worktree: none.
- Protected main-checkout changes include edits under Primary Prompt dispatch,
  Prompt run/recovery, the Herdr adapter, SQLite Prompt dispatch, and their
  tests, plus unrelated untracked worktrees/specifications.
- Fresh baseline on 2026-10-01: `npm ci` succeeded; `npm run build` succeeded
  with build identity
  `sha256:4627374e258f51b02608dae7b3481f508c4038d9cc44bd26649faf3c45f0286d`;
  `npm run typecheck` passed; `npm run architecture:check` checked 433 source
  files successfully; `npm test` passed 235 files and 3,234 tests.
- `npm ci` reported one existing high-severity dependency advisory. Dependency
  upgrades are outside this change and were not applied.
- Approval state: Gate 1 design and Gate 2 specification approved. No
  unresolved load-bearing design decisions remain.
