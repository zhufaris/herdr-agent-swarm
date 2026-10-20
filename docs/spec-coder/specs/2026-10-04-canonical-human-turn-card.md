# Canonical Human Turn Card

## Problem Statement

The current unified Human Turn Card path creates a pending Conversation
Segment, page zero, and visible Feishu card when a Feishu Submission Intent is
admitted. It later adopts the exact Core JSONL `human_message` and updates that
same card from Pending to Working.

That presentation model couples three independently durable lifecycles:

- Agent Input admission and effect certainty;
- canonical Core JSONL conversation projection; and
- Feishu card creation and delivery acknowledgement.

Production evidence showed that an ordinary Feishu `card_reply` receipt may
contain a message ID without a CardKit surface ID. The first repair made that
receipt usable, linked page-zero admission to one create effect, and added
restart adoption for a delivered create. A subsequent review of the complete
callback/convergence loop found two broader defects:

1. a delivered checkpoint can immediately converge the same projection
   version, reattach an already delivered reply as `pending_reply_id`, and wait
   forever for a callback that will not recur; and
2. recovery understands the delivered-but-not-checkpointed window for initial
   creation only, while snapshot and finalize effects can be stranded by the
   same crash window.

The pending card is also redundant user feedback: the original Feishu Human
Message is already visible. A Turn Card should mean that Core has canonically
accepted the Human Message into the conversation, not merely that Swarm has
recorded a Submission Intent.

## Solution

Adopt a canonical-only Turn Card model:

> A Conversation Segment and its first Turn Card page are created only when
> the exact Core JSONL Human Message is projected. Agent Input admission never
> creates a Turn Card.

Feishu admission continues to durably create one immutable Submission Intent
before attempting Core delivery. Submission receipt and possible-effect states
remain internal workflow and operational facts. When the exact canonical
Human Message appears, Conversation Projection atomically:

1. correlates it to the Submission Intent when a valid `submission_id` exists;
2. closes and freezes the preceding open segment in Core lane order;
3. creates or idempotently resolves the Human Message's Conversation Segment;
4. creates page zero in Working state;
5. reserves exactly one ordinary `card_reply` create effect and links the page
   to that exact reply; and
6. settles the relevant projection cursor/checkpoint in the same transaction.

Direct-Herdr, Primary, Worker, and exact-turn steering Human Messages use this
same projection action. The new first visible card is Working, later updates
accumulate canonical Assistant, Thinking, Tool, Goal, Task List, waiting, and
terminal facts, and the same physical card becomes the terminal Answer unless
content pagination requires continuation pages.

Ordinary Turn Cards require a Feishu message ID as their mutation target. A
CardKit surface ID remains optional and is required only by a transport
operation that genuinely addresses a streaming surface.

The change preserves existing pending-first rows and already delivered Feishu
cards as historical/recovery data. It stops new pending-card writes; it does
not delete external cards, rewrite production SQLite manually, change Core
cursors, or replay Agent Input.

## User Stories

### SCN-C1 — Admission without canonical evidence

As a Feishu user, when my authorized text is durably admitted but its Core
Human Message has not yet appeared, the original Feishu message remains
visible and no Turn Card is created. The Submission Intent remains available
for receipt querying, effect-certainty recovery, readiness, and diagnostics.

### SCN-C2 — Canonical Human creates the first card

As a Feishu user, when Core JSONL emits the exact session-fenced Human Message,
I receive one Working Turn Card. The Human Message, segment, page zero, create
effect, exact reply link, and projection settlement are committed atomically.

### SCN-C3 — Duplicate and concurrent projection

As an operator, when live ingestion, recovery, or competing projector handles
observe the same canonical Human Message, exactly one segment, page zero, and
create effect survive. A duplicate returns the existing projection and emits
no new external effect.

### SCN-C4 — Create delivery crash recovery

As an operator, if Feishu creates page zero and the service exits before its
page checkpoint commits, restart adopts the uniquely linked delivered message
ID, retains an optional surface ID when present, and does not create a
replacement card.

### SCN-C5 — Update and finalize crash recovery

As an operator, if an ordinary snapshot or finalization reaches Feishu before
its page checkpoint commits, restart reconciles the exact linked reply and
advances the page without waiting for a callback that cannot recur.

### SCN-C6 — Monotonic convergence

As an operator, when a callback wakes convergence without a newer view version
or cursor, the workflow returns `noop`. It never reattaches a delivered reply,
regresses page state, or creates an infinite delivery/convergence loop.

### SCN-C7 — Rejection and uncertain submission

As a Feishu user, a definite pre-effect rejection produces at most one bounded
operation result associated with the source message. A submission that may
have crossed the Core/PTY boundary remains uncertain and query-only; it does
not create a speculative Turn Card and is never automatically replayed.

### SCN-C8 — Uniform origins and Human boundaries

As a Feishu user, Primary, Worker, steering, and direct-Herdr Human Messages
all create the same type of Turn Card from canonical evidence. Each Human
Message starts a distinct ordered segment, including consecutive Human
Messages with no intervening Assistant output.

### SCN-C9 — Pagination and late facts

As a Feishu user, content beyond the validated 9,000-character page limit
continues in the same segment. A later Human Message is the only semantic
segment boundary. Frozen pages are never patched; late facts remain with their
canonical segment through a correction continuation.

## Implementation Decisions

### Domain Model

This change affects three existing bounded contexts.

| Context | Authority and responsibility |
| --- | --- |
| Agent Input | Owns immutable Submission Intent, exact route, submission receipt, effect certainty, and no-replay semantics. It no longer owns an Input Card or Conversation Segment lifecycle. |
| Conversation Projection | Owns canonical Human boundaries, Conversation Segments, Card Pages, projection versions/cursors, and visible Turn Card lifecycle. Core JSONL order is authoritative. |
| Delivery and Operations | Owns immutable delivery intent, exact reply linkage, retries, delivery receipts, dead letters, recovery, and operational evidence. Delivery state never changes Agent Input or canonical conversation truth. |

The existing `Submission Intent` term retains its meaning. The legacy `Input
Card` term becomes compatibility-only: no new Submission Intent creates one.
The canonical visible aggregate is `Conversation Segment`, rooted at one Core
Human Message. A `Card Page` is its physical Feishu projection, not execution
state.

No new glossary value object or domain service is required. Segment/page
identity and canonical lane position already exist and are the relevant value
semantics. This specification changes ownership and valid transitions rather
than adding a parallel model.

#### Invariants

- **INV-C1 — Canonical order:** Core JSONL lane sequence and item ordinal are
  the only final conversation-order authority. Feishu time, event ID, hash,
  SQLite row order, submission ID, outbox order, CardKit sequence, and
  transcript timestamps never order segments.
- **INV-C2 — No speculative card:** before a canonical Human Message exists,
  no new Conversation Segment, Card Page, or Turn Card delivery intent exists
  for that input.
- **INV-C3 — Atomic first projection:** canonical Human binding, segment, page
  zero, create reply, page-to-reply link, and projection settlement commit or
  roll back together.
- **INV-C4 — Exact identity:** a page accepts a reply only when reply ID,
  projection key, Gateway, kind, segment/page identity, and target agree.
  Ordinary replies require `messageId`; `cardId` is optional.
- **INV-C5 — Monotonic view:** a page snapshot/finalization is reservable only
  when the desired view version or cursor advances beyond its acknowledged
  state. Equal or older state is `noop`.
- **INV-C6 — One recovery rule:** create, snapshot, and finalize all reconcile
  through exact linked reply evidence; missing or conflicting identity fails
  closed and opens a projection gap without emitting replacement work.
- **INV-C7 — No replay after possible effect:** uncertain or possibly delivered
  Agent Input is query-only and never automatically resubmitted.
- **INV-C8 — Independent progress:** one uncertain input, projection gap, or
  page recovery does not block later independent Human Messages.
- **INV-C9 — Frozen history:** frozen pages and historical external cards are
  never patched, deleted, or reassigned to a newer segment.

Conversation Segment and Card Page remain the atomic projection aggregate
because canonical adoption, page-zero creation, delivery intent, and exact
reply linkage must be consistent together. Submission Intent stays a separate
Agent Input aggregate: canonical projection may correlate it but must not
mutate its effect-certainty rules based on Feishu delivery.

### Architecture

#### Agent Input module

The Agent Input admission interface persists one immutable Submission Intent
and returns duplicate/conflict outcomes. Its normal admission path takes no
presentation reservation and creates no Segment/Page/outbox row. Existing
legacy readers remain available only for migration and recovery of historical
pending-first data.

#### Canonical Human projection module

Conversation Projection owns one deep action equivalent to
`projectCanonicalHuman`. Its interface accepts normalized canonical event
identity, exact producer/session/generation fence, canonical lane position,
optional valid Submission Intent correlation, request text, root/Gateway
route, and the projection settlement input. It returns one of:

- `created`, with the canonical segment/page identity;
- `duplicate`, with the same existing identity;
- `conflict`, with durable projection-gap evidence; or
- `ignored`, only for an explicitly retained historical compatibility case.

The implementation hides SQLite table shape, unique-conflict resolution,
outbox reservation, and exact reply linking behind this interface. Callers do
not separately create the segment and enqueue the first card.

#### Turn Card convergence module

The convergence interface operates only on an existing canonical segment/page.
It first reconciles any exact `pending_reply_id`, regardless of whether the
reply is create, snapshot, or finalize. It then compares desired and
acknowledged version/cursor and returns `waiting`, `noop`, `reserved`,
`finished`, or `gap`. It cannot create a segment for a Feishu admission.

#### Delivery adapter

The outbound executor converts the Gateway receipt into internal delivery
evidence and invokes the Turn Card checkpoint interface with exact `replyId`,
`messageId`, and nullable `cardId`. Feishu SDK types do not cross into the
Conversation Projection domain port. The dispatcher remains transport-only;
it does not infer canonical ownership or choose the latest card.

#### Source dependency direction

```text
Gateway ingress -> Agent Input application -> Agent Input domain/store ports
Core inbox/projector -> Conversation Projection domain/store ports
Turn Card workflow -> Conversation Projection + Delivery ports
Feishu adapter -> internally owned Gateway delivery interfaces
composition root -> concrete SQLite and Feishu adapters
```

Domain and coordinator modules do not import concrete Feishu SDK or SQLite row
types. The composition root continues to assemble concrete dependencies.

### Behavior & Failure Modes

#### Admission

Admission atomically records only the Submission Intent. Duplicate source
identity with identical immutable content returns the existing intent;
conflicting reuse fails closed. `recorded` work remains independently eligible
for Core submission.

#### Canonical adoption

The first exact canonical Human Message is the sole creation trigger. Matching
uses the existing session/generation fence and exact `submission_id` when
present. Submission identity correlates ownership but never orders messages.
An unmatched direct-Herdr Human Message creates the same Working segment from
canonical evidence without inventing a Submission Intent.

#### Delivery and checkpointing

The initial `card_reply` uses an immutable segment/page projection key and
stable idempotency identity. A message-only receipt is sufficient for an
ordinary Turn Card. Checkpoint commits the delivered target and acknowledged
version/cursor, clears the exact pending reply, and wakes convergence.

A wake with no newer desired state is `noop`. A wake with a newer state
reserves exactly one next reply. Reusing an idempotency key with different
payload or target is an invariant violation and opens a gap.

#### Generic pending-reply recovery

On live convergence and startup recovery, the page examines its exact linked
reply before reserving new work:

- undelivered/retryable work remains `waiting` for the same reply;
- a uniquely linked delivered reply is adopted and checkpointed;
- a retryable dead letter follows the existing bounded recovery policy without
  being mislabeled as an identity conflict;
- uncertain effect remains fail-closed and operator-visible;
- missing, malformed, or conflicting linkage opens a projection gap and emits
  no replacement effect.

The same decision applies to create, snapshot, and finalize replies. Recovery
never searches for the newest card or reconstructs workflow truth from card
text.

#### Submission failure

A definite rejection proven before external effect may produce one bounded
operation-result projection tied to the source message. `attempting`,
`prepared`, `observed`, and `uncertain` continue their existing receipt-query
semantics. Lack of canonical evidence is reported through readiness/status and
recovery diagnostics, not a speculative Pending Turn Card.

### Compatibility & Migration

This is a forward-only write-path migration.

1. Stop creating pending Conversation Segments, Input Cards, page zero, and
   Turn Card create effects during new Submission Intent admission.
2. Route all new canonical Human Messages through the canonical projection
   action, including Primary, Worker, steering, and direct-Herdr origins.
3. Retain legacy pending-first tables/readers and their bounded recovery while
   historical actionable rows remain.
4. Do not adopt, delete, or rewrite already duplicated external Feishu cards
   without separate ownership proof and operational authorization.
5. Update current architecture, domain-context, operator, and user-facing docs
   so `Input Card` is clearly compatibility-only and new Turn Cards start at
   Working.

The current uncommitted Pending-first repair is implementation evidence, not
an approved target. Its useful message-only receipt, nullable surface ID,
exact-link validation, and delivered-reply recovery behavior are retained and
generalized. Its admission-time card creation and create-only recovery are
removed or rewritten.

## Testing Decisions

Behavior tests use existing SQLite/application seams rather than inspecting
private helper calls.

| Requirement | Verification seam |
| --- | --- |
| SCN-C1, INV-C2 | Agent Input workflow/store integration proves admission creates one Submission Intent and zero segments/pages/Turn Card outbox rows. |
| SCN-C2, INV-C3 | Core ingestion/projector integration proves canonical Human projection atomically creates segment, page zero, exact create reply/link, and cursor settlement; injected enqueue/settlement failure rolls all of them back. |
| SCN-C3, INV-C1/INV-C4 | Competing store handles and duplicate Core delivery produce one canonical aggregate/effect and reject changed immutable identity. |
| SCN-C4/SCN-C5, INV-C6 | Real SQLite reopen tests cover delivered-but-not-checkpointed create, snapshot, and finalize replies with message-only and optional-surface receipts. |
| SCN-C6, INV-C5 | End-to-end callback -> checkpoint -> converge loops prove equal versions are no-op and newer versions reserve exactly one effect. |
| SCN-C7, INV-C7/INV-C8 | Submission receipt tests prove definite rejection output, uncertain query-only behavior, no replay, and later independent input progress. |
| SCN-C8 | Primary, Worker, steering, and direct-Herdr integration tests all enter the same canonical Segment/Page contract. |
| SCN-C9, INV-C9 | Renderer/page integration proves 9,000-character continuation, Human boundary segmentation, frozen-page protection, and old-segment late continuation. |

Production-shaped Gateway callback tests must omit `surfaceId` for ordinary
`card_reply`. Separate tests retain streaming operations' real surface
requirements.

Architecture verification proves coordinators depend on internally owned
domain ports, concrete Feishu/SQLite dependencies remain in adapters, and the
composition root owns assembly. Documentation tests must reject new claims
that admission creates a pending Turn Card.

Affected verification includes focused Agent Input, Core ingestion,
Conversation Segment, Turn Card workflow, outbound callback/dispatcher,
startup convergence, Worker/steering/direct-Herdr, pagination, and
documentation suites. Delivery requires fresh:

- `npm test`;
- `npm run typecheck`;
- `npm run architecture:check`;
- `npm run build`; and
- `git diff --check`.

## Out of Scope

- Deleting or editing existing external Feishu cards.
- Manual production SQLite repair or dead-letter rewriting.
- Changing Herdr Core JSONL order, cursor semantics, or submission protocol.
- Reintroducing a Swarm-owned ordinary-message FIFO or predecessor gate.
- Remote approval/denial, arbitrary terminal input, or Pane/process kill.
- Replacing the durable outbox or existing CardKit 9,000-character page limit.
- Pane-token thread titles and multi-agent Tool-item card composition.

## Further Notes

The prepared workspace is the registered isolated worktree
`/tmp/herdr-agent-swarm-unified-human-turn-card` on
`feat/unified-human-turn-card`, starting at
`01584cbc3eb4b5deac2a777b62e77e8ed905710c`. Isolation preserves unrelated
user-owned changes in the primary checkout. The worktree contains only
task-owned Pending-first Task 9 repair changes; those changes are expected to
be replaced or retained selectively under this specification.

Dependency preparation was already complete through the locked repository
installation. Fresh planning-boundary evidence on 2026-10-04:

- five focused suites passed: 5 files, 43 tests;
- `npm run typecheck` passed;
- `npm run architecture:check` passed across 494 source files;
- `npm run build` passed with build identity
  `sha256:77c05489af0a4d938663687b1a7e88a41d0946afbc87cb35b7c8e7dd3651d11f`;
- the immediately preceding full suite passed: 272 files, 3,870 tests.

The prior Pending-first design was approved and partially implemented. The
canonical-only design reopened Gate 1 after review evidence invalidated that
architecture and was approved on 2026-10-04. This written specification was
approved at Gate 2 on 2026-10-04 and supersedes the Pending-first behavior in
`docs/superpowers/specs/2026-10-04-unified-human-turn-card-design.md` once Gate
3 authorizes implementation.

No unresolved load-bearing design decision remains. Production rollout and
real Feishu acceptance occur only after Gate 3 implementation authorization,
TDD, delivery review, fresh full verification, installation, and restart
safety checks.
