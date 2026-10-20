# Answer Card and Completion Notification Convergence

## Problem Statement

Primary Prompt `835be9f5-ef35-4e11-bd2b-bee706b2cf89` exposed two related
delivery defects in the newly shipped next-input notification flow.

First, SQLite contained a completed Run Card at view version 17 and a final
Answer payload containing `✅ 任务完成`, while Feishu continued to show the old
Answer Card. The corresponding `card_update` row was marked `delivered`, but it
had no CardKit sequence. Gateway translation therefore selected the legacy
message-patch operation for a CardKit entity created by the streaming API. A
successful transport response was incorrectly treated as convergence of the
actual CardKit surface.

Second, the independently delivered next-input card contained no mention. Its
log recorded `mention: "omitted"` because the historical Binding had no
`creatorOpenId`, even though the completed Prompt had a valid Feishu actor.
The notification was also allowed to appear before the final Answer surface
had converged.

The desired behavior is uniform for Primary Answer Cards and Worker Task
Cards: every mutation of a CardKit surface uses its persisted monotonic
sequence, and a successful-completion notification becomes deliverable only
after the corresponding final card is checkpointed. The notification names
the current request actor when possible and includes a bounded preview of the
last visible assistant message.

## Solution

Give each Primary Answer or Worker Task page one authoritative persisted
CardKit sequence shared by stream content, stream finish, timeline/full-card
replacement, and final static replacement. Every `card_update` for such a
page carries the allocated `cardSequence`; Gateway translation uses the
CardKit entity-update operation whenever that sequence is present. Legacy
non-CardKit message cards without a sequence continue to use message patch.

Replace direct next-input outbox reservation during terminal completion with
a durable completion-notification obligation. The completion transaction
records the obligation, while the successful final Answer/Task Card delivery
checkpoint releases it. Release atomically rechecks successor work and either
suppresses the obligation or enqueues the existing idempotent notification.
Startup convergence retries eligible unreleased obligations after repairing
their final card projection.

The notification uses one compact layout. Its header identifies a completed
Primary or Worker, its first body line mentions the current completed request's
Feishu human actor, and the last visible assistant message follows directly as
an at-most-2,000-character preview after the existing redaction and Lark
Markdown normalization. A compact Agent/Pane identity closes the card; Worker
cards retain the existing Worker Main navigation action. Request text, Prompt
ID, generation, section headings, tool calls, tool results, reasoning, and
commentary are omitted.

The mention target falls back to the Binding creator when the request actor is
not eligible. A notification without a valid mention target is not sent; its
obligation records the recoverable `missing_mention_target` state instead.

## User Stories

### SCN-1: Primary completion converges before notification

When a current-generation Primary Prompt completes successfully, Swarm
persists its terminal projection and notification obligation. It updates the
final Answer through CardKit with the next page sequence. Only after that
delivery is checkpointed, and only when no same-generation successor Prompt is
nonterminal, Swarm posts one next-input card under the Binding root.

### SCN-2: Worker completion uses the same contract

When a current Worker Session Turn completes successfully, its Worker Task
Card uses the same sequenced CardKit mutation and checkpoint rule. The Worker
next-input notification is released through the exact current parent Binding
route only after the final Worker card is checkpointed and no same-generation
successor Turn exists.

### SCN-3: The current request actor is notified

A Primary notification mentions the completed Prompt's valid Feishu actor. A
Worker notification mentions the completed Turn's valid Feishu human actor.
If that identity is absent or unsuitable for Feishu mention, the current
Binding creator is used when valid. If neither is valid, Swarm sends no card
and retains a recoverable `missing_mention_target` obligation. Every delivered
completion notification therefore contains a real mention. Full Open IDs are
not logged.

### SCN-4: The notification carries the last assistant message

The completion notification places a bounded preview of the final visible
assistant message directly after its mention line. It is not the whole
accumulated Answer and excludes tool, commentary, protocol, and reasoning
content. The preview is limited to 2,000 characters and uses the existing
redaction and Markdown-normalization rules. If no visible assistant message
exists, the preview is omitted without leaving an empty section.

The Primary layout is a `✅ Primary 已完成` header, mention line, optional
assistant preview, and compact `Primary name · Pane identity` footer. The
Worker layout substitutes `✅ Worker 已完成`, uses `Worker name · Pane identity`,
and retains the Worker Main navigation action. Neither layout repeats the
request text, Prompt ID, generation, FIFO explanation, or named content
sections.

### SCN-5: Accepted successor work suppresses a stale prompt

Successor eligibility is checked when the final card checkpoint attempts to
release the obligation. If same-owner, same-generation work has already been
accepted, the obligation becomes suppressed and no waiting notification is
sent. If release commits first, a later accepted request does not retract the
already-correct notification.

### SCN-6: Delivery and restart recovery remain one-shot

A transient CardKit failure leaves the obligation waiting while normal outbox
retry or card recovery continues. A permanent failure or unresolved projection
gap does not release the notification. After a replacement final card is
successfully checkpointed, release may proceed. Duplicate provider responses,
observer replay, process restart, and repeated startup convergence produce at
most one notification.

### SCN-7: Non-success terminal outcomes remain separate

Aborted, failed, cancelled, interrupted, uncertain, stale-identity, and Human
Review blocked outcomes do not create a next-input obligation. Existing Human
Review requested/resolved behavior is unchanged.

## Implementation Decisions

### Domain Model

The affected bounded contexts are **Prompt Execution**, **Worker Runtime**,
**Conversation Projection**, and **Delivery and Operations**.

- Prompt Execution and Worker Runtime own terminal success and the actor who
  submitted the exact request.
- Conversation Projection owns Answer/Task page identity, desired visible
  content, CardKit sequence allocation, and the completion-notification
  obligation.
- Delivery and Operations owns ordered external delivery, provider receipts,
  retries, quarantine, checkpoints, and restart-visible recovery evidence.
- Feishu remains a presentation system and never becomes workflow authority.

A **completion-notification obligation** is durable evidence that a live,
successful Prompt or Turn may need a next-input notification after its final
card converges. It is not itself an outbound effect. It has one owner kind and
owner identity, the relevant generations, and a state of
`waiting_for_answer`, `missing_mention_target`, `released`, or `suppressed`.
A uniqueness constraint on the exact owner/generation/completion identity
prevents duplicates.

The **request actor** is the actor attached to the completed Prompt or Worker
Turn. Only a Feishu-originated Primary actor or a Worker `human` actor on the
Feishu channel is eligible as the preferred mention. This provenance check
prevents synthetic values such as internal or Herdr-originated actor labels
from being treated as Feishu identities.

#### Invariants

- **INV-1 — One sequence owner:** each mutable Primary Answer or Worker Task
  page owns one persisted CardKit sequence used by every operation that
  mutates that CardKit entity.
- **INV-2 — Monotonic mutation:** stream content, finish, full replacement,
  and final replacement receive distinct increasing sequences in the same
  transaction that reserves their outbox intents.
- **INV-3 — Card before notification:** no completion notification outbox
  intent exists before the successful local checkpoint of the current final
  Answer or Worker Task Card.
- **INV-4 — One completion, at most one notification:** an obligation and its
  stable notification idempotency key prevent duplicate effects across retry,
  replay, and restart.
- **INV-5 — Current need for input:** release rechecks nonterminal successor
  work for the same owner and generation; accepted successor work suppresses
  the obligation.
- **INV-6 — Mandatory safe identity:** the exact request's Feishu human actor
  is the preferred mention and a valid Binding creator is the fallback. A
  notification cannot be enqueued without one of them.
- **INV-7 — Bounded visible preview:** notification content includes only the
  last visible assistant message, capped at 2,000 characters after redaction
  and normalization.
- **INV-8 — Semantic completion:** only successful terminal completion creates
  an obligation; other terminal and Human Review states remain distinct.

SQLite transactions owning page sequence allocation, terminal transition,
obligation creation, and obligation release enforce the applicable invariants.
The Gateway adapter enforces provider conversion but does not decide workflow
eligibility.

### Architecture

The existing Primary and Worker terminal-transition modules will create the
obligation in the same transaction as terminal state and projection updates.
They will no longer enqueue the notification card directly.

The existing Answer-page and Worker-card projection modules will allocate a
provider sequence for every CardKit mutation and persist it in
`outbound_replies.card_sequence`. For a terminal streaming page, stream finish
and final full replacement receive two distinct increasing sequences. Pending
snapshot coalescing must preserve a sequence that remains greater than the
last externally checkpointed sequence.

`prepareOutboundGatewayIntent` will express a sequenced `surface.replace`
whenever a `card_update` has `cardSequence`, independent of `targetRole`.
The Feishu Gateway then uses `updateCardKit`; only a genuinely legacy update
without a CardKit sequence uses `updateCard`/message patch. Internal portable
views remain independent of the Feishu SDK, and the concrete adapter remains
assembled at the existing Gateway seam.

After SQLite accepts a final Answer/Task delivery checkpoint, the existing
checkpoint-driven convergence path invokes obligation release. Release is a
single SQLite transaction that validates the current owner, generation,
terminal page, final delivered projection, routing, and absence of successor
work; it then either marks the obligation suppressed or marks it released and
enqueues the notification outbox intent. The existing outbox is still the
only external-effect mechanism.

Startup view convergence first reconstructs missing final card delivery work,
then examines waiting obligations whose final delivery evidence is current.
It calls the same idempotent release operation used by live checkpoints. No
coordinator independently guesses provider state or sends a card directly.

The notification renderer receives a bounded internal DTO containing a required
resolved mention identity, the last visible assistant message, and compact
Agent/Pane plus Worker-navigation metadata. It does not receive request text,
Prompt ID, or generation for display. Actor provenance and assistant-message
selection happen before the Feishu rendering adapter; SDK types do not cross
into domain or projection modules.

### Behavior & Failure Modes

Outbox delivery order remains authoritative within each CardKit page lane.
Provider success is checkpointed only after the sequenced CardKit operation
returns success. A failed final update remains retryable or enters the existing
quarantine/recovery policy; its obligation stays `waiting_for_answer`.

If the service stops after final-card checkpoint but before release, durable
page delivery evidence plus the waiting obligation lets startup convergence
release it. If it stops after the notification outbox insert, the stable
idempotency key prevents another logical notification. If successor acceptance
and obligation release race, SQLite transaction order decides: acceptance
first suppresses the notification; release first produces a notification that
was true at its commit boundary.

The final visible assistant message is selected from the canonical persisted
timeline/result representation. Missing or malformed optional content omits
the preview without blocking terminal projection or notification release.
Missing mention identity does block notification release: the obligation moves
to `missing_mention_target`, remains non-delivered, and may be retried if a
valid authoritative identity later becomes available.

### Compatibility & Migration

The database migration adds the completion-notification obligation storage and
is additive. It does not synthesize obligations for historical completed work,
preventing a notification storm after upgrade. Existing notification outbox
rows and idempotency keys remain valid.

Historical `card_update` rows with immutable prepared Gateway plans are not
rewritten. New or regenerated current Answer/Worker projection intents carry
CardKit sequence data. Existing plain interactive message cards without a
CardKit sequence retain the legacy patch path.

No Herdr Core protocol, Agent session identity, prompt FIFO behavior, remote
approval boundary, or public configuration changes are included.

## Testing Decisions

- Gateway intent and adapter tests prove that sequenced Answer/Worker
  `surface.replace` operations call CardKit entity update, while legacy
  unsequenced cards retain message patch.
- Primary Answer and Worker Task page tests prove unique increasing sequences
  across content, finish, timeline replacement, final fold, coalescing, retry,
  and continuation pages.
- SQLite tests prove terminal completion creates one waiting obligation but no
  notification outbox row before final-card checkpoint.
- Delivery/checkpoint integration tests prove successful final delivery
  atomically releases or suppresses the obligation and produces exactly one
  notification intent.
- Concurrency tests cover successor-before-release and release-before-successor
  outcomes for both Primary and Worker owners.
- Recovery tests cover transient and permanent CardKit failures, replacement
  pages, duplicate receipts, store reopen, and startup convergence.
- Renderer and release tests cover Prompt/Turn actor priority, Binding creator
  fallback, mandatory mention, recoverable `missing_mention_target`, the exact
  compact Primary/Worker layouts, absent assistant content, redaction, Markdown
  normalization, and the 2,000-character limit.
- Architecture verification confirms that workflow policy remains inside the
  projection/store modules, portable Gateway intent stays provider-neutral,
  and only the Feishu adapter imports its SDK.
- Affected tests are followed by `npm run typecheck`, `npm run build`,
  `npm run architecture:check`, and the complete `npm test` suite.

## Out of Scope

- Read-after-write polling of Feishu after a successful CardKit response.
- Retrospective notifications for historical completed Prompts or Turns.
- Periodic reminders while an Agent remains idle.
- Changing Answer pagination limits or canonical answer content.
- Redesigning Human Review notifications.
- Changing Herdr Core events or parsing provider-specific stop reasons.
- Installing, deploying, restarting, or live-testing the service.

## Further Notes

- Workspace mode: in place on `main`. The tracked worktree was clean at
  selection time; existing untracked `.tmp-core-build/`,
  `.tmp-core-worktrees/`, `.trae/`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md` are user-owned and outside this task.
- Branch: `main`.
- Starting revision: `03ba41591b4269ba132cf5a8897f274b0e0bd502`.
- Fresh baseline on 2026-10-01: `npm ci`, `npm run build`,
  `npm run typecheck`, and `npm run architecture:check` passed;
  `npm test` passed 235 files and 3,258 tests. Build identity:
  `sha256:e7dd8e303ef0341908bf3b25c49a88c4669238850c8bc9d88c6113dc084171da`.
- `npm ci` reported two existing high-severity dependency advisories;
  dependency remediation is outside this change.
- Gate 1 design, Gate 2 specification, and Gate 3 ticket-plan implementation
  authorization were approved.
