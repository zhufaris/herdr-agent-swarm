# `/swarm awake` Card Redelivery

## Problem Statement

`/swarm awake` currently has one recovery path: find a detached Primary Prompt,
scan its Herdr transcript, and project any later complete turns that can be
proved safe. When there is no detached Prompt, or the transcript contains no
safe complete later turn, the command reports that no recovery occurred and
does not refresh the cards already persisted by Swarm.

This leaves an operator without a safe repair when SQLite contains the current
Primary Main Card and Answer Card projections but Lark is stale or missed an
update. Replaying the TraeX Prompt is forbidden because the original Prompt may
already have crossed the Agent boundary. Treating ordinary convergence as
forced delivery would also mix operator intent into normal projection and could
create duplicate cards.

## Solution

Keep transcript recovery as the first behavior of `/swarm awake`. When it
recovers one or more complete turns, use the existing projection path and do
not schedule an additional card redelivery. When recovery reports either no
detached Prompt or no safe complete later turn, invoke a dedicated durable
Primary card-redelivery capability.

The redelivery capability atomically fences the current binding generation and
reserves fresh outbox snapshots for:

- the current Primary Main Card; and
- the latest mutable or finished Answer page of the current active Prompt, or,
  when there is no active Prompt, the most recent visible Answer page for the
  binding.

The operation never submits Prompt text, writes terminal input, changes Prompt
execution state, releases a detached blocker, or edits frozen historical Answer
pages. Lark delivery remains asynchronous, so command feedback says that
redelivery was scheduled rather than claiming that it was delivered.

## User Stories

- **SCN-1 — Recovery remains first:** Given a detached Prompt with one or more
  safely recoverable complete later turns, `/swarm awake` recovers those turns
  through the existing path and does not additionally redeliver old cards.
- **SCN-2 — No detached Prompt:** Given an active Primary binding without a
  detached Prompt, `/swarm awake` schedules a fresh Main Card snapshot and the
  selected latest Answer Card snapshot without sending an Agent Prompt.
- **SCN-3 — No safe later turn:** Given a detached Prompt whose transcript has
  no safe complete later turn, `/swarm awake` leaves that Prompt detached and
  schedules card redelivery without fabricating a recovery outcome.
- **SCN-4 — Active Answer selection:** When an active ordinary Prompt exists,
  only its latest eligible visible Answer page is redelivered. Older pages and
  Answers belonging to other Prompts are unchanged.
- **SCN-5 — Historical Answer selection:** When no active ordinary Prompt
  exists, the most recent eligible visible Answer page for the binding is
  redelivered. If no eligible Answer exists, Main-only redelivery is valid.
- **SCN-6 — Multi-page safety:** For a multi-page Answer, only the latest active
  or finished page is eligible. Frozen historical pages and a not-yet-visible
  creating page are never patched or replaced by this operation.
- **SCN-7 — Durable idempotency:** Retrying the same Command Intent reserves no
  duplicate external effects. A later user-issued `/swarm awake` command may
  reserve a new higher snapshot revision for the same visible card targets.
- **SCN-8 — Fail closed:** Busy recovery, inactive bindings, changed binding
  generations, stale projection/page identity, and missing visible targets do
  not mutate execution truth or send unsafe external effects.
- **SCN-9 — Delivery recovery:** Main and Answer delivery may succeed
  independently. Existing outbox retry, quarantine, and expired-target
  replacement behavior converges either failed delivery without repeating the
  `/swarm awake` operation or replaying a Prompt.

## Implementation Decisions

### Domain Model

Delivery Operations owns a new consumer-facing `PrimaryCardRedelivery` port.
Command handling asks this port to redeliver cards for one frozen Primary
binding generation and one durable Command Intent. Prompt Execution remains the
authority for transcript recovery and Prompt lifecycle; Conversation Projection
remains the authority for the card content being snapshotted.

The redelivery operation carries the Command Intent ID as its durable
idempotency identity. Its result distinguishes scheduled Main/Answer work,
already-scheduled work, no eligible Answer, and stale/unavailable context. The
exact type names may be refined during implementation, but the caller must not
learn SQL, outbox sequence, or card-page selection details.

- **INV-1 — No Prompt replay:** Card redelivery cannot call any Agent submission,
  steering, terminal-input, stop, or pane-control capability.
- **INV-2 — Execution truth is immutable:** Redelivery cannot change Prompt
  lifecycle, observation state, transcript identity, queue position, detached
  recovery attempts, or execution-slot ownership.
- **INV-3 — Generation fence:** The binding must still be active and match the
  Command Intent's frozen binding generation when the reservation transaction
  commits.
- **INV-4 — Persist before delivery:** The durable redelivery operation and all
  newly reserved outbox effects commit atomically before Lark delivery begins.
- **INV-5 — Command idempotency:** One Command Intent creates at most one Main
  redelivery effect and at most one Answer redelivery effect.
- **INV-6 — Fresh snapshot revision:** A new Command Intent can reserve a
  strictly higher snapshot revision even when the rendered payload equals the
  last delivered payload.
- **INV-7 — Latest-page boundary:** Redelivery targets at most one Answer page
  and never targets a frozen historical page.
- **INV-8 — Existing recovery semantics:** Expired Lark targets may use the
  established replacement-card path; redelivery itself never unconditionally
  creates duplicate replacement cards.

### Architecture

- **ARCH-1 — Command orchestration:** `CommandIntentDispatcher` invokes existing
  `PromptRunWorkflow.awake` first. Only `no_detached_prompt` and
  `no_complete_later_turn` outcomes fall back to `PrimaryCardRedelivery`.
  `busy`, inactive, stale, and other unavailable outcomes fail closed.
- **ARCH-2 — Dedicated redelivery seam:** Add a domain-owned
  `PrimaryCardRedelivery` interface rather than adding a `force` option to
  `MainCardWorkflow.converge`, `AnswerPageWorkflow.converge`, or their public
  ports.
- **ARCH-3 — Atomic Projection/Outbox adapter:** A dedicated SQLite operation
  validates binding state/generation plus selected Topic, Run, and Answer-page
  identities, records the Command Intent operation, allocates ordered card
  sequences and higher snapshot revisions, and reserves Main and Answer outbox
  rows in one transaction.
- **ARCH-4 — Render outside transport:** The redelivery workflow renders the
  current Main and selected Answer snapshot through `PrimaryPresentation`.
  SQLite owns persisted selection/fencing and outbox reservation; the Lark
  adapter remains unaware of `/swarm awake`.
- **ARCH-5 — Existing delivery lanes:** Redelivery uses the canonical Main and
  per-Answer-page lanes, CardKit sequence allocation, work classification, and
  recovery metadata so normal ordering, retry, dead-letter, and expired-target
  handling continue to apply.
- **ARCH-6 — Composition:** Outbound runtime composition constructs the
  redelivery implementation and command-control composition receives only the
  consumer port. Prompt runtime does not gain presentation or outbox ownership.

### Behavior and Selection Rules

The command flow is:

```text
/swarm awake
  -> safe detached transcript recovery
     -> recovered turn(s): normal projection only
     -> no detached Prompt: durable card redelivery
     -> no safe complete later turn: keep detached + durable card redelivery
     -> busy/unavailable: no redelivery
```

`/swarm awake` changes from `active-turn` scope to `primary-session` scope so it
can be used when no active Prompt exists. Authorization remains `creator`, the
replay policy remains `reconcilable`, and the Command Intent still freezes the
Primary binding generation, pane, terminal, and native-session context. The
dispatcher validates that frozen Primary context before starting either
recovery or redelivery.

Within the reservation transaction, active-Prompt selection uses the current
ordinary Prompt for the fenced generation. If one exists, Answer selection is
restricted to that Prompt. Otherwise, selection considers the binding's Run
Cards from newest to oldest. An Answer page is eligible only when it has an
existing visible Lark message target and is `active` or `finished`; `creating`
and `frozen` pages are ineligible. The highest eligible page index is the only
Answer target.

If the Main Card has an existing status message, redelivery reserves an ordered
update. If its canonical target has not yet been created, the operation may
reserve the normal canonical Main creation against the binding root. It does
not create a second Main solely to make redelivery observable. An absent Answer
target produces Main-only scheduling rather than a new Answer page.

The command status reports one of: recovery completed; Main and Answer
redelivery scheduled; Main-only redelivery scheduled because no eligible
Answer exists; the same operation was already scheduled; or a fenced failure.
It must not say `delivered` before the outbox confirms delivery. A detached
Prompt remains explicitly detached in the no-safe-turn feedback.

### Failure Modes and Recovery

Main and Answer effects share one atomic reservation but are delivered on their
existing independent lanes. Partial external success is therefore expected.
The outbox retries only the undelivered effect. A stale or expired Lark target
uses the existing semantic recovery proof and replacement rules; successful
redelivery of one surface does not cause the other surface or the TraeX Prompt
to repeat.

If projection identity changes between rendering and reservation, the store
returns stale and reserves nothing. If the command process stops after the
transaction, the existing outbox resumes both effects. If it stops before the
transaction, the durable reconcilable Command Intent may run again with the
same ID. Duplicate execution observes the recorded operation and reserves no
additional rows.

### Compatibility and Migration

No public HTTP, Lark action, or command syntax changes. Help text and the Feishu
usage guide are updated to describe the recovery-first, redelivery-fallback
behavior and the `primary-session` scope.

The SQLite schema may add a small redelivery-operation record or equivalent
durable uniqueness structure keyed by Command Intent ID. Migration is additive
and does not backfill historical Commands, rewrite card projections, or enqueue
delivery. Existing Main/Answer projection keys, delivery checkpoints, CardKit
sequences, and delivery-recovery evidence remain authoritative.

## Testing Decisions

- **SCN-1/SCN-3, ARCH-1:** extend command and pane-thread integration coverage
  to prove recovered turns suppress fallback while `no_detached_prompt` and
  `no_complete_later_turn` schedule fallback with no Agent submission.
- **SCN-2/SCN-4/SCN-5/SCN-6, INV-3/INV-7:** add focused SQLite/workflow tests
  for active-Prompt selection, latest historical Answer selection, Main-only
  behavior, multi-page selection, and rejection of frozen/creating pages.
- **SCN-7, INV-4/INV-5/INV-6:** prove same-Intent idempotency across reopen,
  atomic Main-plus-Answer reservation, and a higher snapshot revision for a
  later Command Intent with an unchanged payload.
- **SCN-8, INV-1/INV-2:** prove inactive/stale generations and projection races
  reserve nothing and leave Prompt, detached recovery, and queue state byte-for-
  byte unchanged; fakes assert that Agent and pane-control ports are never
  called by redelivery.
- **SCN-9, INV-8, ARCH-5:** cover independent Main/Answer delivery outcomes and
  integration with existing retry/quarantine/expired-target recovery without
  unconditional replacement creation.
- Update architecture-boundary tests for the new domain port and composition
  direction. Update command-definition/help and Feishu usage tests for the new
  scope and description.
- Before delivery, run the focused command, pane-thread, redelivery, projection,
  outbox, and SQLite suites, then `npm run typecheck`, `npm run build`, and the
  full `npm test` suite.

## Out of Scope

- Replaying, resuming, steering, stopping, or otherwise controlling a TraeX
  turn.
- Clearing or skipping a detached Prompt blocker.
- Redelivering Worker Main or Worker Task Cards.
- Rewriting frozen Answer history or all pages of a multi-page Answer.
- Adding a general-purpose forced-convergence flag.
- Changing normal startup convergence, periodic reconciliation, or Lark as a
  workflow source of truth.
