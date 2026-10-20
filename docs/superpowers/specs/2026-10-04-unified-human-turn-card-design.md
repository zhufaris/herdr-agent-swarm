# Unified Human Turn Card Design

## Status

Superseded on 2026-10-04 by
`docs/spec-coder/specs/2026-10-04-canonical-human-turn-card.md`. This document
is retained as implementation history for the earlier Pending-first direction
and is not current behavioral authority.

## Intent

Make the Feishu experience as simple as cc-connect's visible conversation
model without adopting cc-connect's process-local queue, optimistic acceptance,
timestamp ordering, or non-idempotent delivery boundaries.

The user-visible rule is:

> One canonical Human Message owns one Turn Card.

The superseding design removes the admission-time pending card: the first
visible Turn Card is created in `working` state from canonical Human evidence.

The same rule applies to Primary, Worker, steering, and direct-Herdr Human
Messages. Core JSONL remains the only authority for final conversation order.

## Relationship to earlier designs

This design supersedes the presentation model in:

- `2026-09-28-human-message-and-answer-cards-design.md`, which treated the
  visible request and Answer as separate surfaces; and
- `2026-10-01-human-message-answer-segmentation-design.md`, which scoped Human
  boundaries inside legacy Prompt/Worker aggregates.

Their durable-delivery, frozen-page, canonical-order, redaction, and no-replay
requirements remain valid. Their Prompt-owned aggregate model does not.

## Evidence from cc-connect

cc-connect v1.5.0 presents one session conversation with durable `user` and
`assistant` history while treating thinking, tools, permissions, and streaming
cards as live projections. When a queued input starts, it resets the prior
turn's card/stream state so new output cannot overwrite the previous response.

That simplicity is useful, but its acceptance and ordering model is not:

- its busy-session FIFO and media batching are process-local;
- Feishu callback acknowledgement precedes Core acceptance and Agent delivery;
- the Web UI optimistically displays the Human input before acknowledgement;
- its create-time watermark does not establish a durable total order; and
- Agent delivery and Feishu retry do not carry an end-to-end idempotency token.

The fixed-revision evidence is recorded in
`docs/research/2026-10-04-cc-connect-input-message-card-model.md`.

## Design principles

1. Keep the visible model small: Input Intent, Conversation Segment, Card Page.
2. Keep authority boundaries strict: SQLite owns workflow intent, Core JSONL
   owns conversation order, and Feishu owns only delivered projections.
3. Reuse one physical first-page card across `pending -> working -> terminal`.
4. Treat a Human Message as a semantic segment boundary, never as a local sort
   key or execution gate.
5. Use one segment/card contract for Primary, Worker, steering, and direct
   Herdr input. Identity labels may differ; lifecycle semantics do not.
6. Preserve durable outbox, stable idempotency, strict CardKit element sequence,
   frozen pages, and no automatic replay after possible Agent effect.
7. Give exactly one store operation ownership of initial page-zero creation:
   segment, page, create effect, and the page-to-effect link commit together.
8. Treat the Feishu message ID as the required mutation target for an ordinary
   Turn Card. A CardKit surface ID is optional transport evidence, not a
   prerequisite for checkpointing an ordinary card reply.

## Domain model

### Input Intent

An Input Intent is the immutable, durable record of a Feishu-originated Agent
Input. It retains the existing frozen route, body, `submission_id`, receipt
state, and possible-effect semantics.

Admission creates both the Input Intent and a pending Conversation Segment in
one SQLite transaction. It also reserves the first Turn Card create intent.
The user therefore sees a durable pending projection without creating a second
presentation aggregate.

### Conversation Segment

A Conversation Segment is the sole card aggregate for one canonical Human
Message and all following Core events up to, but excluding, the next canonical
Human Message in the same exact producer session.

Its identity contains:

- a stable `segment_id` generated at durable admission or canonical discovery;
- exact producer/session fence, including owner generation and native session;
- optional `submission_id` for a Feishu-originated input;
- canonical Human event identity once observed;
- the Human request text after existing normalization and redaction;
- canonical start and optional end cursor;
- lifecycle state and projection version.

The producer/session fence and canonical Human event identity are the final
ownership proof. `submission_id` correlates a pending segment to that event but
never orders segments.

### Card Page

A Card Page is one physical Feishu CardKit message for a Conversation Segment.
Page zero is created while a Feishu input is pending and remains the same
physical card after canonical adoption. Additional pages are continuation
cards created only for CardKit/content limits or frozen-page late delivery.

Every page owns immutable segment/page identity, message/card targets, element
ID, CardKit sequence, delivery checkpoint, and frozen state. No component may
update a page by looking up the latest card for a session.

For an ordinary `card_reply`, `message_id` is the durable update target and
`card_id` may remain null. `card_id` is required only for an operation whose
Feishu transport contract actually addresses a CardKit streaming surface.
Domain ports must model that distinction instead of requiring a synthetic
surface ID from every delivery receipt.

## Lifecycle

```text
Feishu admission
  -> pending
       exact canonical human_message.submission_id
  -> working
       canonical terminal result
  -> completed | failed | cancelled

pending/working
  -> needs_human
       only when exact ownership or delivery target cannot be proven
```

`prepared` Core receipt does not move the card to `working`. Only ingestion of
the exact canonical Human Message does so.

Direct-Herdr input has no Input Intent or pending phase. Its canonical Human
Message creates a Conversation Segment directly in `working` state.

An exact-turn steering Human Message follows the same rule. It creates a new
segment when it appears in canonical Core JSONL even if the native Agent still
considers it part of one long-running turn.

## Canonical segmentation

The projector consumes Core events in the array and cursor order supplied by
Core. It never sorts by Feishu receipt, occurrence time, submission ID, event
ID, hash, SQLite row order, outbox order, or card sequence.

For each canonical Human Message:

1. close the current open segment immediately before the Human event;
2. freeze its active page;
3. adopt the matching pending segment by exact `submission_id`, or create a
   working segment for a direct/unmatched canonical Human Message;
4. bind the canonical Human event identity and start cursor;
5. reserve the working snapshot for page zero; and
6. route subsequent canonical events to that segment until the next Human
   boundary.

These changes are one SQLite transaction. Duplicate ingestion of the same
canonical event returns the existing segment and emits no duplicate CardKit
effect.

Several consecutive Human Messages create several segments, including when no
Assistant event occurs between them. Empty segments remain visible as accepted
or working Human requests instead of being coalesced.

## Card composition

The first page uses the same normal Answer-style card in every state.

### Header

- compact Space and stable Pane identity;
- lifecycle badge: Pending, Working, Completed, Failed, or Needs attention;
- Human Message text, bounded only by CardKit safety limits and rendered as the
  stable request context rather than a one-line-only subtitle;
- optional source marker only when operationally useful, such as direct Herdr
  or steering.

### Body

Events are rendered in canonical order with these policies:

- Assistant text is visible content.
- Thinking shows a visible summary/title and preserves the sanitized full text
  in a collapsed section.
- Tool call and result share one stateful step where identity permits; running,
  completed, and failed states remain visible.
- Waiting for command, permission, or question is an explicit blocked/waiting
  row even when no Assistant text exists.
- Goal and Task List remain structured projections.
- System/protocol details remain hidden unless they are a user-actionable error,
  recovery warning, or projection gap.
- The Human boundary is represented by the card header and is not duplicated
  as an Answer timeline body item.

Primary and Worker use the same composition. Worker-specific identity and task
metadata are header fields, not a separate card lifecycle.

## Pagination and immutability

Human segmentation and content pagination are independent:

- a canonical Human Message creates a new Conversation Segment and page zero;
- the validated 9,000-character/CardKit limit creates a continuation page in
  the same segment;
- an arbitrary event or turn-count threshold does not create a semantic
  boundary; and
- continuation pages repeat compact request context and page number.

Frozen pages are never patched. If recovery discovers an event whose canonical
cursor belongs to a frozen page or closed segment, the event remains owned by
that segment and is rendered through a late-result/correction continuation.
It must not be moved into the newest Human segment.

## Durable identity and delivery

Pending adoption records this durable relation:

```text
submission_id -> canonical_human_event_id -> segment_id -> page_id
```

Recommended outbox idempotency key families are:

```text
segment:<segment_id>:page:<page_index>:create
segment:<segment_id>:page:<page_index>:snapshot:<view_version>
segment:<segment_id>:page:<page_index>:finalize:<view_version>
```

Exact key encoding may use existing helpers, but it must include immutable
segment/page identity. Reusing an idempotency key with different target or
payload is a fail-closed invariant violation, not a reason to update whichever
card is newest.

CardKit sequence orders updates only within one page element. It does not order
conversation events or determine segment ownership.

## Post-deployment initial-card repair

Production observation found that the first implementation had two owners for
page-zero creation. `SqliteSubmissionIntentStore` enqueued a pending
`card_reply`, while later Turn Card convergence could reserve another create
because the page did not durably point at the first reply. The real Feishu
ordinary reply receipt contains a `messageId` but no CardKit `surfaceId`; the
delivery callback consequently withheld the page checkpoint. One segment could
therefore deliver two physical cards and remain permanently in `creating`.

**ARCH-R1 — Single initial-card owner.** The repair makes
`ConversationSegmentStore` the single deep owner of admission:

1. in the existing Input Intent transaction, create the pending segment;
2. create page zero in `creating`;
3. reserve exactly one `card_reply` create effect with immutable segment/page
   identity; and
4. write that effect ID to `pending_reply_id` before committing.

`SqliteSubmissionIntentStore` supplies the intent and presentation inputs but
does not enqueue a second initial reply. A duplicate source delivery returns
the existing segment/page/effect relation. Turn Card convergence sees the
linked create effect and may reserve only a later snapshot after the create is
checkpointed; it cannot emit another create merely because `message_id` is not
yet populated.

The normal delivered-create checkpoint is:

```text
delivered card_reply(messageId, optional surfaceId)
  + exact page.pending_reply_id
  + exact immutable segment/page projection target
  -> page.message_id = messageId
  -> page.card_id = surfaceId when present, otherwise null
  -> page.state = active (or the state required by the latest reserved view)
  -> clear/advance pending delivery state
```

**INV-R1 — Exact create linkage.** The relation is accepted only when the
outbox row, projection key, segment ID, page index, and pending reply ID all
agree. A message-only receipt is sufficient for an ordinary Turn Card.
Streaming operations continue to require the surface target demanded by their
transport contract.

### Stable repair scenarios

- **SCN-R1 — Atomic admission:** A new Feishu input atomically produces one segment, one page-zero row, one
  create outbox row, and one `pending_reply_id` link.
- **SCN-R2 — Message-only checkpoint:** A real ordinary Feishu reply receipt containing only `messageId` checkpoints
  the linked page and subsequent snapshots update that same physical message.
- **SCN-R3 — Pre-ack adoption:** Canonical Human adoption before create acknowledgement changes the desired
  view but does not create another reply; the latest view follows the create
  checkpoint on the same message.
- **SCN-R4 — Undelivered restart:** Restart with an undelivered linked create retries the same outbox effect and
  never creates a replacement effect.
- **SCN-R5 — Delivered restart:** Restart with a delivered linked create and no page checkpoint adopts the
  unique `delivered_message_id`; it also preserves `card_id_checkpoint` when
  one exists.
- **SCN-R6 — Ambiguous recovery:** Restart with missing, conflicting, or ambiguous linkage fails closed, opens
  a projection gap with segment/page/effect evidence, and does not guess from
  the latest card or emit another create.
- **SCN-R7 — Historical external cards:** Existing duplicate external Feishu cards are not deleted or rewritten;
  reliable ownership of the unintended physical card is not available.

These scenarios do not change canonical ordering, pending-to-working evidence,
input replay policy, pagination, or frozen-page behavior.

## Recovery and error handling

- A restart reconstructs segments and pages from SQLite, never from card text.
- If Input Intent and pending segment committed but card creation did not, the
  outbox retries only card creation.
- If Core submission may have happened, receipt and canonical recovery continue
  without replaying the body.
- If canonical Human evidence arrives before page-zero creation is acknowledged,
  the delivery checkpoint sends the latest working snapshot after creation.
- If a linked create effect is already delivered after restart but its page is
  still `creating`, recovery adopts that effect's unique
  `delivered_message_id`. An optional surface checkpoint is retained when
  present but is not fabricated when absent.
- If the delivered effect cannot be proven to be the page's unique linked
  create, recovery opens a projection gap and emits no replacement create.
- Missing or ambiguous exact ownership leaves the segment pending or
  `needs_human`; it never attaches to a nearby or latest card.
- A delivery target mismatch quarantines only that page effect and opens
  operator-visible recovery evidence. It does not block later independent
  Human segments.
- One producer's projection failure is isolated from other sessions.

## Migration

Migration is forward-only and does not rewrite historical Feishu messages.

1. Introduce the unified Conversation Segment/Page schema and projection
   revision alongside existing historical Run/Worker card tables.
2. New Feishu admissions create unified pending segments.
3. Existing pending Input Cards with exact current identity may be adopted into
   unified segments without creating a new physical card.
4. Newly observed direct Human Messages create unified working segments.
5. Existing completed/frozen legacy pages remain historical and immutable.
6. Retain legacy tables and readers while unresolved recovery evidence exists;
   remove runtime write paths only after status proves no actionable legacy
   work depends on them.

No migration submits Agent Input, changes canonical cursors, or repairs SQLite
from visible Lark state.

Historical cleanup of legacy `conversation-turn` outbox rows, integrity debt,
dead letters, and already duplicated external cards is outside this immediate
repair. Any such cleanup requires a separate forward migration with its own
ownership proof and operational review; this repair does not mutate production
SQLite directly.

## Component boundaries

- Conversation projector: detects canonical Human boundaries and reduces
  segment-owned event ranges.
- Segment store: atomically admits/adopts/closes segments and reserves page
  delivery intent.
- Turn Card renderer: pure rendering shared by Primary and Worker.
- Card convergence workflow: converges segment/page snapshots without knowing
  whether the source was Feishu, direct Herdr, Primary, or Worker.
- Outbox dispatcher: remains transport-only and validates immutable targets,
  idempotency, and CardKit sequence.
- Existing Input Card, Primary Answer, and Worker Task card paths become
  compatibility adapters during migration, not independent lifecycle owners.

The implementation should deepen these shared boundaries rather than add a
fourth card workflow.

## Rejected alternatives

### Separate Input Card and Answer Card

Rejected because it doubles visible cards and requires a handoff between two
durable aggregates. The user already expects the pending card to become the
working answer surface.

### One mutable card for the whole session

Rejected because new Human input would overwrite prior replies, recovery could
target the wrong card, and frozen-page history would be lost.

### Local timestamp/FIFO segmentation

Rejected because adapter concurrency, retries, equal timestamps, and restart
recovery cannot produce the exact order already supplied by Core JSONL.

### Fixed turn-count card rotation

Rejected as a semantic boundary. Event count may be an operational safety cap,
but only content/CardKit limits should normally create continuation pages.

## Verification

Implementation must prove:

- Feishu admission atomically creates one pending segment and one page-zero
  create intent, with the page linked to that exact effect;
- admission and later convergence cannot independently reserve two page-zero
  create effects;
- the real ordinary gateway receipt contract (`messageId` without a required
  surface ID) checkpoints the linked page;
- restart adopts the unique message ID from an already delivered linked create
  without sending another reply;
- missing or conflicting create linkage fails closed with a projection gap;
- exact canonical correlation updates the same physical card to working;
- no canonical evidence means the card remains pending;
- direct-Herdr, Primary, Worker, and steering Human Messages use identical
  segmentation behavior;
- multiple consecutive Human Messages create separate ordered cards;
- Assistant, full collapsed Thinking, Tool lifecycle, and waiting-for-command
  render on the correct segment;
- duplicate live/recovery events are idempotent;
- target or idempotency mismatch fails closed without blocking later segments;
- content continuation does not create a Human boundary;
- frozen pages are not patched and late facts remain with their canonical
  segment;
- restart at admission, Core attempt, canonical adoption, card create, update,
  and finalize boundaries converges without replaying Agent Input;
- historical cards remain unchanged; and
- redaction, configured-chat admission, route fences, and high-risk local-only
  approval boundaries remain intact.

The delivery gate is focused store/projector/card/outbox coverage followed by
`npm run typecheck`, `npm run architecture:check`, `npm test`, `npm run build`,
and `git diff --check`.

Repair tests must use the production-shaped gateway receipt rather than a fake
that invents a surface ID. They must cover atomic admission rollback,
message-only delivery checkpoint, pre-ack canonical adoption, delivered-create
restart adoption, duplicate callback idempotency, and ambiguous-link recovery.

## Repair workspace and baseline evidence

The repair is isolated in the clean registered worktree
`/tmp/herdr-agent-swarm-unified-human-turn-card` on
`feat/unified-human-turn-card`, starting at
`01584cbc3eb4b5deac2a777b62e77e8ed905710c`.

Before this specification amendment:

- the five focused seams passed with 28 tests:
  `agent-input-workflow`, `human-turn-card.integration`,
  `turn-card-outbound-callback`, `turn-card-workflow`, and
  `feishu-gateway-plugin`;
- `npm run typecheck` passed;
- `npm run architecture:check` passed across 494 source files; and
- `npm run build` passed with build identity
  `sha256:d8447a6d7aacc6fab4437376fa510102302b95e709dcddcedf54a9eaf234c2a3`.

This baseline also demonstrates why the repair needs a production-shaped
receipt regression: the prior callback fake returned both message and surface
references and therefore did not exercise the actual ordinary reply contract.

## Success criteria

- A user sees exactly one first-page card per Human Message.
- A Feishu card visibly moves from Pending to Working only after canonical Core
  evidence and then accumulates all response events for that Human segment.
- Primary, Worker, steering, and direct-Herdr views follow one rule.
- No presentation choice creates input ordering, blocks later input, or causes
  Agent replay.
- Restart and ambiguous delivery converge through durable state rather than
  card inspection or operator SQL repair.
