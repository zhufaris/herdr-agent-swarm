# Card dismissal deletes the visible Feishu message

## Problem Statement

Current user-facing `dismiss` and `ignore` actions settle their local business
state but leave the original Feishu CardKit message visible, or replace it with
an acknowledgement update. This makes an explicitly dismissed card remain part
of the active visual surface. The requested behavior is to remove that original
message completely while retaining an auditable, durable record only in SQLite.

The service already has a fenced `message_delete` outbound kind and a durable
outbox. Existing uses cover legacy input-card retirement and Orchestrator
clear; they do not provide one shared user-initiated dismissal operation across
all card action families.

## Solution

Introduce a durable Card Dismissal operation for every user-initiated business
`dismiss` or `ignore` action. A validated action atomically consumes its
business decision, records a SQLite audit row, and enqueues a deterministic
`message_delete` effect for the exact source card message. The existing
outbox, Delivery Ring, Lark adapter, retry, and recovery paths perform and
settle the external deletion.

The visible card disappears only after Lark confirms deletion, or reports that
the exact message is already absent. SQLite retains the business action,
Card Dismissal audit, outbox item, and provider settlement evidence; no
business projection or delivery history is physically deleted.

## User Stories

### SCN-1: Authorized user dismisses a business card

An authorized user clicks a valid Human Review Ignore, Primary completion
Ignore, Worker completion Ignore, dead-letter dismiss, or any existing
equivalent user-initiated dismiss action. The service validates the action's
chat, target message, owner, generation, and authorization. In one SQLite
transaction it applies the existing business dismissal and records a unique
Card Dismissal plus a `message_delete` intent for that exact message. After a
confirmed provider acknowledgement, the source Feishu card is absent and only
SQLite history remains.

### SCN-2: Duplicate or concurrent callbacks

Repeated delivery of one action or concurrent clicks for the same source card
must converge on the same Card Dismissal and delete intent. The visible effect
is invoked at most once per deterministic outbox identity; a later callback
does not delete an unrelated or replacement card.

### SCN-3: Stale or unauthorized callback

A callback with a wrong chat, owner, generation, card message ID, or actor
fails through the existing action validation. It creates neither a Card
Dismissal audit row nor a `message_delete` intent.

### SCN-4: Failed or uncertain deletion

Once the SQLite transaction commits, transient provider failure follows the
normal outbox retry path. A timeout or uncertain effect is not recorded as a
successful visible deletion. A terminal delivery failure retains the source
card and its durable recovery evidence for human handling; the service never
posts a replacement "dismissed" acknowledgement card.

### SCN-5: Message is already absent

The provider's exact already-absent result is terminal success. The Card
Dismissal records that outcome without attempting to recreate or update the
card.

## Implementation Decisions

### Domain Model

The affected bounded context is **Card Delivery and User Actions**. A
**Card Dismissal** is a durable audit/effect record for one authorized request
to remove one exact Feishu message. It is distinct from:

- the underlying completion action or dead-letter decision, which owns the
  business semantics of Ignore/Dismiss;
- an `OutboundReply`, which owns external delivery/retry mechanics; and
- the CardKit message, which is only visible output and not workflow truth.

**INV-1 — persist before effect:** the business dismissal, Card Dismissal
record, and `message_delete` outbox intent commit atomically before Lark is
called. No coordinator or card workflow directly deletes a Lark message.

**INV-2 — exact authorized target:** only a currently valid action can request
deletion. The target is the exact action card message ID; title, binding
recency, and other heuristic lookup are forbidden.

**INV-3 — history remains durable:** visible deletion never deletes business
projections, prior outbound rows, recovery evidence, or Card Dismissal audit.

**INV-4 — no false success:** only `deleted` or `already_absent` settles the
visible deletion as complete. Uncertain and failure outcomes remain durable
work/recovery evidence.

**INV-5 — duplicate safety:** the Card Dismissal's deterministic identity is
unique per exact card message and dismissal semantics. It is the idempotency
owner across action retries and concurrent callbacks.

No new aggregate root, generic policy engine, or repository layer is needed:
the existing SQLite store transaction is the consistency boundary, while the
existing Outbound Reply aggregate remains the external-effect owner.

### Architecture

The Card Action workflows remain application coordinators. After their current
authorization and semantic action succeeds, they call a small Store-owned
Card Dismissal capability rather than Lark directly.

The SQLite Store owns construction of the audit row and the associated
`message_delete` Outbound Reply in the same transaction. Its interface accepts
the validated action context and exact source message identity; it returns the
settled/duplicate result needed by the caller. It does not accept arbitrary
message IDs from unvalidated callers.

The existing outbox publisher owns adapter invocation. The Lark adapter keeps
its existing `deleteMessage` result conversion, where `deleted` and
`already_absent` are both terminal acknowledgements. The message-delete
settlement hook updates the matching Card Dismissal audit outcome atomically
with the outbound acknowledgement transition.

Source dependencies remain inward: card workflows depend on domain Store and
Outbound ports; SQLite implements them; the publisher depends on the Lark
adapter. No coordinator imports the Lark SDK or calls its delete API.

### Behavior & Failure Modes

Each business action uses its established validation and consumption path
first. The Card Dismissal insertion is part of the same transaction wherever
that path currently has a transactional Store operation. If an action family
requires a narrow Store API adjustment to make that atomic, it must not expose
an intermediate "ignored but not delete-requested" success state.

The deterministic Card Dismissal / Outbound Reply key is derived from the
action family, its stable owner or failed-reply identity, and exact source card
message ID. A unique constraint causes repeated callbacks to return the prior
request instead of producing another external effect.

The normal outbox state machine remains authoritative for `pending`, claimed,
retry, delivered, uncertain, and dead-letter transitions. Successful deletion
settles Card Dismissal as `deleted` or `already_absent`; failure records the
same safe error classification used by the outbox. The source card is not
patched into a tombstone and no operation-result card is created for a
successful dismissal.

### Compatibility & Migration

Add a forward-only SQLite migration for Card Dismissal records and required
indexes. It applies only to future user-initiated callbacks; no historical
cards are retrospectively deleted. Existing `message_delete` effects for
legacy input retirement, `/swarm clear`, system supersession, and recovery
retain their semantics and do not create Card Dismissals unless they originate
from this new user-dismissal capability.

## Testing Decisions

- Extend the existing card-action integration seams for Primary and Worker
  Ignore, Human Review Ignore, and dead-letter dismiss. Assert the exact
  original message becomes the `message_delete` target and no acknowledgement
  card update is enqueued on success.
- Exercise SQLite transactions directly to prove action consumption, Card
  Dismissal audit, and deletion intent commit or roll back together.
- Exercise duplicate and stale/unauthorized callbacks to prove the unique
  identity and validation boundary.
- Extend outbox/publisher tests for `deleted`, `already_absent`, retryable
  failure, and terminal/uncertain failure settlement of Card Dismissal.
- Preserve existing legacy-input-retirement and Orchestrator-clear
  message-delete tests. Run affected Vitest files, `npm run typecheck`,
  `npm run build`, and the full `npm test` suite before delivery.

## Out of Scope

- Physical deletion or pruning of SQLite business, delivery, or audit data.
- Deleting ordinary human Feishu messages.
- Deleting a card via title, pane, binding, or any non-exact heuristic.
- Changing automatic supersession, system cleanup, or `/swarm clear` behavior.
- Adding a generic arbitrary-message deletion command.

## Further Notes

- Workspace: repository root, in-place. The
  change is planned serially because it touches shared action, SQLite, and
  outbox seams. No user work overlaps the planned paths.
- Branch: `main`; starting revision:
  `acd05b8aba1db01c01c086075aa3570d3b054e63`.
- Pre-existing untracked paths, preserved untouched:
  `.tmp-build/`,
  `docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`,
  and `handoff.md`.
- Fresh baseline: `npm test` passed before this specification; `npm run
  typecheck` and `npm run build` passed immediately before it was written.
- Gate 1 design approval: 2026-10-08. Gate 2 specification approval:
  2026-10-08.
