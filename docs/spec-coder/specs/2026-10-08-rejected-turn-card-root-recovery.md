# Recover a rejected Turn Card root create with a new delivery identity

## Problem Statement

The Delivery Ring correctly blocks a lane when its head is an immutable
Turn Card page-zero create that Feishu has permanently rejected. The blocked
head has no created message/card target, so later CardKit updates, choices, and
mentions cannot safely pass it.

The current automatic Turn Card dead-letter recovery only selects a failed
reply joined through `conversation_segment_pages.pending_reply_id`; it reopens
the same reply identity for one retry. A rejected page-zero create that lacks
that page-row link is therefore left as an unresolved, quarantined lane head.
The observed `turn-card:segment:3e799a13-03a2-4bbc-8117-9d58063dcbdc:page:0:create`
is such a case: permanent/rejected, no visible card target, and no eligible
page join.

## Solution

Introduce a fenced recovery for an exact, current, confirmed-rejected Turn
Card page-zero create. It does not let later lane work bypass a missing target.
Instead it atomically dismisses the old failed delivery, resolves/releases its
quarantine evidence, rebuilds the current authoritative page-zero snapshot,
and reserves a new create reply with a new delivery/idempotency identity. Later
choices, mentions, and updates remain blocked until that new create is
acknowledged.

## User Stories

### SCN-1: Confirmed rejected root create is rebuilt

When a page-zero Turn Card create is permanently rejected or proven
not-started, has no delivered message/card target, and its projection identity
matches the current canonical segment, recovery creates one successor delivery
from the current snapshot. The old reply is dismissed and its lane quarantine
is released atomically before the successor can be claimed.

### SCN-2: New create acknowledgement unblocks dependent output

Only after the successor create receives an exact Feishu acknowledgement may
the usual Delivery Ring deliver choices, mention notifications, and later card
updates that rely on the card target.

### SCN-3: Uncertain or mismatched root create remains quarantined

An uncertain external effect, a delivered/checkpointed target, wrong segment
identity, changed generation/scope, absent current snapshot, or malformed
page-zero metadata receives no automatic dismissal or replacement. Its
quarantine remains visible for human recovery.

### SCN-4: Recovery is duplicate-safe

Repeated safety scans, restarts, and concurrent recovery attempts converge on
one successor. They do not create multiple replacement cards or release a
quarantine before a transaction has durably reserved its successor.

## Implementation Decisions

### Domain Model

The affected context is **Delivery Recovery**. A **Rejected Turn Card Root**
is an immutable page-zero creation effect with no established Feishu target.
It is not a successful page and cannot be treated as a generic replaceable
snapshot.

**INV-1 — no bypass of a missing target:** later lane entries must not pass a
failed root create. They are eligible only after a successor root create is
durably reserved and acknowledged in the ordinary way.

**INV-2 — confirmed effect boundary:** only `rejected` or `not-started`
effects are candidates. `uncertain` is never automatically dismissed,
retried-with-new-identity, or superseded.

**INV-3 — one atomic handoff:** in a single SQLite transaction, the old reply
is dismissed, its recovery/quarantine is recorded as replaced, and the new
authoritative page-zero create is reserved. Failure rolls all three back.

**INV-4 — current projection only:** a replacement is derived from the
current canonical conversation segment/page, under its exact owner generation
and delivery scope. A stale, ambiguous, or missing projection remains blocked.

**INV-5 — one successor:** a deterministic recovery identity and uniqueness
constraint converge repeated scans and restarts on the same replacement.

The existing `delivery_recoveries` row remains the historical link between
failed and replacement replies. No arbitrary replay engine or alternate
message target lookup is introduced.

### Architecture

`SqliteOutboxRecoveryStore` owns candidate discovery and transactionally
performs the replacement handoff. It obtains the current canonical Turn Card
snapshot through the existing Turn Card projection/rebuild seam and reserves
the successor through the existing prepared-delivery/outbox interface.

The Delivery Ring remains unchanged as the ordering owner: it observes the
old reply terminalized and its quarantine released, then schedules the new
root create. The Lark adapter remains unchanged. Acknowledgement of the new
create remains the sole source of a usable message/card target.

### Behavior & Failure Modes

Candidate selection requires all of: `projection_key` parses as a Turn Card
page zero; `kind=card_reply`; no delivered/checkpointed message/card target;
dead-letter state; rejected/not-started effect certainty; exact current
segment/page identity; active exact delivery owner/scope; and a reconstructable
authoritative snapshot.

The old reply changes to `dismissed` with a specific recovery reason. Its
`delivery_recoveries` row becomes `replacement_pending` and records the new
reply ID; the active lane quarantine is released only in that transaction.
If any proof or reservation fails, nothing is dismissed or released.

The successor uses a new reply ID/idempotency key containing a recovery
generation. It remains a page-zero create in the same primary-pane Delivery
Ring. Existing acknowledgement code settles its page target, after which
normal dependent delivery proceeds. If the successor fails, ordinary failure
classification applies; it is not recursively replaced without new explicit
policy evidence.

### Compatibility & Migration

This changes only future safety/recovery scans and does not rewrite historical
rows eagerly. Existing joined Turn Card recovery may retain its one-time
same-identity retry behavior where its page record proves that path; the new
path specifically covers missing-page-root candidates. Existing automatic
quarantine behavior for uncertain and non-Turn-Card effects is unchanged.

## Testing Decisions

- Create a rejected missing-page page-zero root with an authoritative current
  segment and prove one scan dismisses it, links one successor, and releases
  its quarantine.
- Prove the successor has a new identity, current snapshot payload, exact
  owner/scope, and blocks later work until its acknowledgement.
- Prove duplicate scans/reopen converge to one successor.
- Prove uncertain, delivered/checkpointed, non-page-zero, stale generation,
  malformed projection, and absent/currently-unreconstructable snapshot rows
  remain blocked with no successor.
- Preserve existing Turn Card retry, answer/worker recovery, and Delivery Ring
  ordering tests. Run focused Vitest, typecheck, build, architecture check, and
  full test suite before delivery.

## Out of Scope

- Retrying or replacing uncertain effects.
- Skipping later card work ahead of an unacknowledged root create.
- Changing Lark adapter error classification.
- Repairing arbitrary immutable notifications or non-Turn-Card failed creates.
- Deleting the original business projection or delivery history.

## Further Notes

- Workspace: in-place and serial; shared recovery/store/outbox paths preclude
  parallel mutation with the existing Card Dismissal tickets.
- Gate 1 design approval: 2026-10-08. Gate 2 specification approval:
  2026-10-08.
