# Fresh Authoritative Human Review Card

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Human Review currently adds a trusted mention and choice buttons by updating an
existing Answer or Turn Card. Production E2E proved that the controls can be
rendered and clicked, but Feishu does not emit a new mention notification for a
card update. A separate text mention does notify, but the user explicitly
rejected the redundant standalone `需要你的选择` message.

A live Gate 0 experiment created a new CardKit message whose initial payload
contained the native requester mention. The user confirmed that this fresh card
did produce the Feishu mention notification. The selected design therefore
needs one new Human Review card containing the mention and choices together,
without a second text reminder.

The existing callback payload also copies owner, generation and provider
message identity into client-controlled values. A fresh card has no provider
message ID until delivery ACK, so the new design must persist interaction
identity before delivery and bind provider identity only from durable ACK
evidence.

## Solution

Introduce a dedicated Completion Review presentation lifecycle. A valid
terminal Human Review choice creates one deterministic provisional Action Set
and one immutable fresh-card Delivery Intent in the same SQLite transaction.
The new Human Review card's initial payload contains the sanitized final-answer
context, native requester mention, question, ordered business buttons and
system-owned Ignore action. The old mutable Answer or Turn Card becomes history
and no standalone text reminder is reserved.

The callback value contains only `actionSetId` and `optionId`. The Gateway event
envelope supplies the actual source message and actor. Delivery ACK atomically
binds the new card's provider message/card identity and changes the Action Set
from `presenting` to `active`. Only an active set accepts a decision. Owner,
generation, route, actor, source message and option membership are loaded from
durable state rather than trusted from callback values.

Existing inline Action Sets remain actionable through a compatibility mode.
New choices use fresh cards. Possible-effect card creation is never replayed as
a new card, and no provider state is inferred from visible Feishu output.

Approach selection and Gate 1 were auto-selected under explicit autonomous
authority after comparing: deterministic fresh-card Action Sets, Feishu-only
detached CardKit surfaces, and existing-card notification side effects. The
fresh-card Action Set model is the unique grounded recommendation because it
provides native mention notification, provider-neutral interaction identity,
durable replay safety and one visible interaction surface.

## User Stories

### SCN-1: A terminal choice creates one fresh review card

When a current Primary Segment, Primary Prompt or Worker Turn completes with a
valid Human Review specification and a trusted Feishu actor, Swarm reserves one
new Human Review card. Its initial payload contains sanitized answer context,
the actor mention, the question, one to four business buttons and Ignore.

### SCN-2: A fresh review card triggers the native mention notification

The mention is present in the card's first externally visible delivery, not a
later update. Feishu therefore emits the native mention notification proven by
Gate 0. Swarm sends no separate mention text or reminder card.

### SCN-3: Delivery ACK activates the exact interaction surface

Before ACK, the Action Set is not actionable. The exact fresh-card ACK binds
the provider message ID and optional card/surface ID and activates the set in
the same SQLite settlement transaction.

### SCN-4: A valid callback becomes one Agent Input

An authorized actor clicking a business option on the exact active card
creates one deterministic Submission Intent or Worker follow-up with the
server-owned option message. Ignore is consumed locally and creates no Agent
Input.

### SCN-5: Client callback identity is minimal and untrusted

The callback carries only `actionSetId` and `optionId`. Swarm rejects an event
whose source message, actor, chat, owner generation, route or option does not
match durable state. Extra legacy fields never override server-owned facts.

### SCN-6: A callback before ACK fails closed

If the card is visible but its ACK has not committed, the callback produces a
bounded not-ready response and no decision. It does not activate the set from
client or provider payload. A later click after ACK follows SCN-4.

### SCN-7: Duplicate callbacks converge exactly once at the durable boundary

Repeating the same option returns the already-recorded result. A conflicting
later option is rejected. At most one resulting Input or follow-up exists.

### SCN-8: Restart recovers a presenting Action Set

If the linked outbox row remains pending, the Delivery Ring resumes the same
idempotent delivery. If the exact linked row is durably delivered, startup
reconciliation binds its stored receipt and activates the set without another
external delivery.

### SCN-9: Uncertain creation never produces a replacement card

After any possible provider effect, timeout or uncertain receipt, Swarm keeps
the Action Set presenting and preserves the linked delivery evidence. It does
not reserve a second fresh card automatically.

### SCN-10: Supersession preserves remote-effect evidence

A newer Human turn or owner generation supersedes the review. An unclaimed,
never-attempted create may be dismissed atomically. Claimed, attempted,
checkpointed, delivered or uncertain rows remain immutable history, while the
Action Set no longer accepts decisions.

### SCN-11: Legacy inline cards remain actionable

Already-delivered inline Action Sets retain their provider identity and current
callback compatibility. Migration must not strand their buttons or rewrite
their historical outbox effects.

### SCN-12: Choice-free completion remains unchanged

An explicit `intent:none`, invalid/missing choice, ordinary completion or
legacy final-request-only flow creates no Completion Review card and keeps its
current presentation behavior.

### SCN-13: Unsupported routes fail closed without speculative cards

Missing actor identity, stale owner fences, unsupported Gateway interactions,
or unavailable delivery scope creates no active Action Set and no speculative
provider message. Durable diagnostics retain the reason.

## Implementation Decisions

### INV-1: Completion Review identity is deterministic

The Action Set ID is derived from `(ownerKind, ownerId, ownerGeneration)` under
a versioned `completion-review:v3` namespace. The immutable choice
specification is unique for the same owner tuple and must match on replay.

### INV-2: The lifecycle protects provider identity

New Action Sets transition only through:

```text
provisional -> presenting -> active -> consumed
             \-> unavailable
             \-> superseded
presenting/active -> superseded
```

`provisional` has no linked delivery. `presenting` has exactly one linked fresh
card Delivery Intent but no authoritative provider message identity. `active`
has an ACK-bound message identity. Only `active` accepts a new decision.

### INV-3: Choice specification and owner facts are immutable

Question, ordered options, default, trusted actor, owner tuple, Binding/Worker
parent fences and choice specification identity cannot change after
reservation. Replays with conflicting values fail closed.

### INV-4: Persist before every external effect

The provisional Action Set, presentation link and immutable Delivery Intent
are committed together before Feishu is called. Ring refill uses the same
outbox identity and frozen Presentation Snapshot.

### INV-5: ACK is the only activation authority

The exact linked reply ID and delivery receipt bind `presentationMessageId`
and optional `presentationCardId` while changing `presenting -> active` in one
SQLite transaction. A conflicting identity rolls back settlement and opens a
durable projection gap.

### INV-6: Callback facts come from the envelope and SQLite

The client value contains only Action Set and option identity. Source message,
Gateway/chat, actor, owner, generation, route and option message are resolved
from the authenticated Gateway event and current durable Action Set. No
callback-supplied owner or provider identity is authoritative.

### INV-7: Decision and resulting work are atomic

Consuming a business option and recording its deterministic Submission Intent
or Worker follow-up is one transaction. Ignore consumption is one local
transaction. Duplicate and conflicting outcomes are explicit.

### INV-8: External exactly-once is never inferred

Provider idempotency and the linked outbox constrain retries, but uncertain
effects remain uncertain. Swarm never claims external exactly-once delivery and
never creates a replacement after a possible fresh-card effect.

### INV-9: The fresh card is the sole new interaction surface

New Answer/Turn cards contain no Completion Review buttons. The dedicated fresh
card contains the sanitized final context, mention and controls in its initial
payload. No standalone mention text or secondary reminder card is created.

### INV-10: Frozen conversation pages stay frozen

The fresh review card is a distinct Completion Review projection and Delivery
Subject. It does not replace or patch an immutable Answer Page and is not used
as conversation-order authority.

### INV-11: Legacy inline compatibility is explicit

Migration classifies existing Action Sets as `legacy-inline` with their current
message/card identity. Legacy callback shapes remain parseable, but durable
state still wins over client fields. New rows use `fresh-card` presentation.

### ARCH-1: Completion Interaction owns the Action Set lifecycle

A deep Completion Review module owns deterministic identity, lifecycle,
reservation, ACK activation, decision, supersession and recovery. Primary
Segment, Primary Prompt and Worker Turn modules contribute owner facts and
resulting-work transactions without reimplementing presentation policy.

### ARCH-2: Conversation Projection owns the frozen review view

Conversation Projection supplies sanitized final-answer context and immutable
choice presentation data. It does not own Gateway receipts or infer notification
state from Feishu cards.

### ARCH-3: Delivery and Operations owns effect execution

Delivery and Operations owns the fresh-card Delivery Intent, Prepared Delivery,
scope ordering, retries, checkpoints, ACK and uncertain-effect evidence. ACK
settlement calls the Completion Review activation seam inside the same SQLite
transaction.

### ARCH-4: Gateway conversion remains provider-specific

The domain representation contains a semantic mention target and actions, not
Feishu `<at>` markup or CardKit nodes. The Feishu Gateway materializes native
mention and buttons. Gateways without rich interactions reject the required
capability before reservation or apply an explicitly specified future
degradation; none is introduced here.

### ARCH-5: Provider message identity leaves callback payloads

The Completion Review renderer emits only `actionSetId` and `optionId` as
command data. Gateway ingress supplies `sourceMessage`; application coordination
passes that authenticated envelope fact to the domain decision.

### Persistence and migration

The next ordered migration rebuilds `completion_action_sets` to support:

- deterministic IDs for new rows;
- `presentation_kind` of `legacy-inline` or `fresh-card`;
- lifecycle states `provisional`, `presenting`, `active`, `consumed`,
  `superseded`, and `unavailable`;
- nullable `presentation_reply_id`, `presentation_message_id`, and
  `presentation_card_id` before ACK;
- a positive presentation generation;
- a unique partial index for linked presentation replies;
- current owner/state lookup indexes.

During the expand phase, existing available rows remain `available`
`legacy-inline` records so the uncut owner stores and already-delivered buttons
retain their exact behavior. Fresh-card rows use the new lifecycle states.
After all three owner paths have cut over, the contract phase may map remaining
legacy `available` rows to `active` only if compatibility tests prove those
historical callbacks remain actionable. Terminal rows retain their outcomes and
identities. Reconstitution restores persisted identity and state without
rerunning current eligibility or emitting delivery.

`completion_notification_obligations` remains for final-request compatibility
and historical evidence, but no new choice flow reserves its standalone text
notification branch.

### Behavior and failure modes

- Missing trusted mention identity creates `unavailable`, not a card.
- Reservation conflicts roll back Action Set and outbox together.
- Lost process-local wakeups are recovered from SQLite.
- ACK identity conflicts roll back and open a gap.
- Pre-ACK callbacks are non-mutating and retryable by the user.
- Permanent rejected creation remains failed evidence and unavailable for
  decision; uncertain creation remains presenting and is not replaced.
- Supersession never deletes or rewrites possible remote effects.
- Retention keeps linked presentation evidence while the Action Set requires it.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-6, SCN-7, SCN-8, SCN-9, SCN-10, SCN-11, SCN-12, SCN-13, INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9, INV-10, INV-11, ARCH-1, ARCH-2, ARCH-3, ARCH-4, ARCH-5

- Domain tests prove deterministic identity, valid lifecycle transitions,
  minimal callback commands and rejection of conflicting replay.
- Migration tests cover current-schema creation, legacy-inline backfill,
  consumed/superseded preservation, foreign keys, indexes and fast reopen.
- Store integration tests cover atomic provisional Action Set plus outbox
  reservation, rollback, post-commit handoff, ACK activation, duplicate ACK,
  identity conflict and cold restart adoption.
- Primary Segment, Primary Prompt and Worker Turn integration tests each prove
  fresh-card creation, native mention in the initial view, no inline controls,
  no standalone text reminder, business choice, Ignore, actor/message/generation
  rejection and one resulting work item.
- Delivery tests cover pending retry, rejected failure, uncertain no-replacement,
  supersession before and after possible effect, Ring refill and retention
  references.
- Gateway tests prove provider-neutral mention/action input and Feishu native
  materialization without Feishu syntax in domain values.
- Card-action tests prove new minimal payloads, legacy compatibility and that
  authenticated envelope message identity is authoritative.
- A configured live Gate 0 already proved that a fresh Feishu card carrying the
  native mention emits a notification. Final delivery repeats the fresh-card
  button/callback E2E without using production SQLite as input authority.
- Full Vitest, typecheck, build, architecture check, docs audit and artifact
  delivery check are required before installation.

## Out of Scope

- Feishu `urgentApp`, phone or SMS urgency effects.
- Restoring standalone `需要你的选择` text reminders.
- CardKit detached-surface identity as a required provider-neutral contract.
- Remote deletion or rewriting of historical inline cards and reminders.
- Remote approval of native tools or arbitrary terminal input.
- Changes to Core conversation ordering, Agent Input replay policy, Delivery
  Ledger, Ring durability authority or unrelated latency optimization.

## Further Notes

Workspace mode: reuse the existing isolated worktree in place. The work is
serial because migration, Action Set lifecycle, delivery settlement and owner
stores overlap. Branch: `worktree-unified-delivery-ingress`. Starting revision:
`6d40781be80f389e5734580e8ae0cb4e871cb4b2`. Initial changes: none.

Observed environment: Node `v24.14.1`, npm `11.11.0`, Python `3.12.13`, Git
`2.39.5`, locked dependencies installed. The immediately preceding delivery
baseline passed 300 Vitest files / 4,597 tests, typecheck and build. Planning
captures fresh reusable baseline records below.

Fresh verification captures for request
`fresh-human-review-card-20261011-active`:

- `cde8aa0c7b9d45f6a270cef408752156`: `npm test`, exit 0, 300 files /
  4,597 tests passed;
- `a2a8d4a12651433c8340a5bc7e060373`: `npm run typecheck`, exit 0;
- `a16f64529f054968b8196479bb72fedc`: `npm run build`, exit 0, build
  `sha256:f11ef015060d0aa398b23178ad9d399c0aa48a66c87c2c34e8afb6980ba10b3e`.

The complete capture JSON was observed by main in this uninterrupted request;
the active artifact path itself was excluded from each workspace fingerprint.

Gate 0 evidence: fresh Feishu card message
`om_x100b6386929e48a4c47bd5679051600` contained the native requester mention;
the user confirmed receiving the mention notification.

Gate 2: auto-selected under explicit autonomous authority after structural and
decision coverage checks pass.
