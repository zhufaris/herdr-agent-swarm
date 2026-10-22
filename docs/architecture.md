# Herdr Agent Swarm Architecture

This document describes the current standalone service. Historical Prompt FIFO designs under `docs/archive/`, `docs/superpowers/`, or completed spec records are not runtime authority.

## Authority boundaries

| Fact | Authority | Consequence |
| --- | --- | --- |
| Pane, terminal, foreground process, Agent session, active Turn | Herdr Core | Re-observe Herdr before a fenced control action; socket events are wake-up hints only. |
| Final conversation event order | Core JSONL for the exact Agent session | Never sort or merge conversation events by Feishu arrival, timestamp, hash, ID, SQLite row order, batch ordinal, or submission receipt. |
| Binding, Submission Intent, projection checkpoint/gap, outbox, audit, lease | SQLite | Persist intent before effects and make multi-row transitions atomic. |
| Visible messages and CardKit cards | Feishu/Lark | Cards are delivery output, never workflow truth. |
| Service process | user systemd | Use `npm run swarm:*`; the application does not own a PID lifecycle. |

High-risk Agent approval remains local to the Herdr Pane. The bridge has no remote approval, denial, arbitrary terminal-input, process-kill, or Pane-kill capability.

## Current request path

```text
configured Lark message or card action
  -> durable inbound record
  -> explicit Swarm/Worker control grammar?
       yes -> durable CommandIntent / scoped control workflow
       no  -> immutable Submission Intent
               -> versioned Herdr Core Agent Input submission
  -> canonical Core JSONL session events
  -> continuous exact-session ingestion into the durable inbox
  -> Conversation Projection checkpoint / gap handling
  -> durable Lark outbox
  -> Primary-Pane or Global Delivery Ring
  -> CardKit delivery
```

Ordinary Primary and Worker text uses the same Agent Input abstraction. It does not create a Prompt Input, Native Input Batch, Prompt Job, queue position, scheduler wake, or Binding execution slot.

## Core invariants

1. Each authorized source message admits at most one immutable Submission Intent for its exact Agent route.
2. Inputs are independently eligible. An earlier running, detached, recovering, or uncertain legacy item never blocks a later input.
3. Persist `attempting` before calling Core. After an attempt may have crossed the external-effect boundary, query the receipt; never submit the body again automatically.
4. Core JSONL is the sole final conversation-order authority. Submission identity is for idempotency and correlation, not sorting.
5. Conversation projection preserves Core order exactly. Live batches, recovery pages, and staged snapshots are never locally re-sorted.
6. A completed exact-recovery snapshot atomically replaces a projection only when it is compatible with existing stable event identities. Ambiguity opens a gap and preserves the old view.
7. Persist projection and delivery intent before Lark delivery. Retrying an outbox item never repeats Agent Input.
8. CardKit stream sequence is ordered within one card element. Frozen Answer pages are never patched.
9. Possible-effect legacy Prompt rows remain evidence/recovery-only. Only rows durably proven never attempted may have been migrated into Agent Input.
10. The service remains fenced by one SQLite instance lease.

## Agent Input and Human Turn Cards

The visible model has three durable objects: an Input Intent (immutable route,
body, receipt and no-replay evidence), a Conversation Segment (one canonical
Human Message boundary plus its ordered Core items), and Card Pages (the
CardKit delivery projection). A Feishu admission creates only the Input Intent.
It does not create a Conversation Segment, Card Page, `input_card_views`,
Primary Answer, or Worker Task row. The original Feishu message is the visible
receipt while Core submission is in flight.

Only ingestion of the exact session-fenced canonical
`human_message.submission_id` creates the Conversation Segment, page zero, and
first `working` Turn Card delivery intent atomically; a `prepared` receipt is
not evidence. Missing or ambiguous ownership creates no speculative card and
never attaches content to a nearby card. Terminal status is `completed`,
`failed`, or `cancelled`.

Primary, Worker, exact-turn steering, and direct-Herdr Human Messages use the
same segment/page lifecycle and renderer. Direct-Herdr has no Input Intent or
pre-card phase: its canonical Human event creates a `working` segment directly.
The owner label and task metadata differ, but lifecycle, status evidence, and
delivery fencing are identical.

Human boundaries and content pagination are independent. A new canonical Human
Message creates a new segment; the configured 9,000-character CardKit limit
creates a continuation page in that segment. Continuation pages repeat compact
request context and page number. Frozen pages are never patched; late facts are
rendered on an old-segment correction continuation.

### Semantic Turn Card rollout

SQLite owns the durable rollout phase, immutable per-page delivery cohort,
shadow evidence, and backup/restore rehearsal evidence. Expansion adds nullable
cohort metadata without enabling semantic writers and assigns all existing
pages to `legacy`. During shadow, convergence derives both legacy and semantic
plans for an eligible legacy page, compares bounded cursor and budget evidence,
records the fingerprints, and reserves only the legacy outbox effect. Shadow
derivation never calls the Gateway or creates a second Delivery.

The guarded cohort transition requires recorded shadow evidence with no
mismatch, no ambiguous actionable Turn Card rows, only supported snapshot,
planner, renderer, and Gateway-profile versions, no unresolved semantic
settlement gap, and no semantic retention blocker. Only pages inserted after
that committed transition receive the `semantic` cohort. Historical and active
legacy pages remain legacy, and a page cohort cannot be changed after
assignment. Frozen pages are never replanned. Consumer retries use the frozen
provider-neutral snapshot and plan already persisted with the outbox row.

Startup refuses only an incoherent rollout phase/cohort assignment or semantic
pages that predate cohort enablement. It does not reject ordinary pending
semantic work: restart recovery must still refill that work from SQLite.
Status exposes bounded phase, cohort, parity, blocker, version, and rehearsal
diagnostics without payload content. Contraction readiness additionally
requires a successful backup/restore rehearsal against isolated database files;
the rehearsal validates quick-check, foreign keys, current schema, semantic
integrity, and matching schema fingerprints before its evidence is recorded.
This guard does not perform contraction, delete legacy history, or add an
operator mutation surface. A provider success observed before local settlement
remains an uncertain effect and cannot be cleared by rollout evidence.

### Frozen route

A Submission Intent freezes:

- ingress source and source message key;
- exact body;
- Binding and generation;
- Pane and terminal identity;
- Agent kind and native session identity;
- caller-generated submission ID.

These fields are immutable. A duplicate with the same source identity and same frozen content converges on the existing intent; conflicting reuse fails closed.

### Receipt states

```text
recorded -> attempting -> prepared -> observed -> terminal
                    \-> uncertain --receipt query only--/
prepared/observed -------------------------------> cancelled
```

- `recorded` is safe to submit.
- `attempting` is persisted before the Core call.
- `prepared` means Core durably accepted the submission.
- `observed` means canonical session evidence has correlated it.
- `terminal` and `cancelled` are settled receipt outcomes.
- `uncertain` may have had an effect and therefore is never automatically resubmitted.

No transition checks a predecessor Submission Intent. Concurrent drainers use per-intent compare-and-swap ownership, not a per-Binding ordinary-turn lock.

### Continuous session ingestion

`CoreSessionIngestionSupervisor` is the sole current-session producer for each
exact Primary or Worker session identity. It runs independently of Prompt and
Turn ownership, consumes bounded Core pages from the committed session-lane
cursor, and wakes the matching durable projector only after inbox commit.
`ExternalTurnObserver` consumes the durable lane for current v2 sessions; it
does not compete for another live Core read.

The producer identity includes owner generation, Pane, terminal, Agent kind,
native session and the Core stream source. Primary and Worker routes are
revalidated before each read, including Worker-session and parent-Binding
fences. Concurrent hints coalesce, and one failing route is isolated from the
other sessions. Transient failures use per-owner bounded exponential backoff;
cursor expiry remains a typed failure and invokes receipt-proven exact-turn
recovery for historical Pending-first Input Card rows. Neither path resubmits
the input body.

For v2 session rings, ordinary retained-window expiry and an epoch transition
are deliberately different checkpoint actions. An ordinary expiry in the same
ring epoch is eligible only when Core returns typed `cursor_expired` evidence
with a `resume_cursor`; SQLite rebases that exact checkpoint to the supplied
cursor and records the expiry gap. An untyped same-epoch `invalid_cursor` never
advances a checkpoint.

Before the first v2 read, the reader compares the durable checkpoint with a
fresh ring-open descriptor. When the stable ring/source, native session, and
Agent kind still match but the epoch differs, it atomically records a
`cursor_epoch_changed` projection gap and replaces the exact fenced checkpoint
with the live epoch, `start` read cursor, and live latest cursor. The reader
reloads that checkpoint before it reads the new retained window. Identity
mismatch, a lost checkpoint race, missing epoch evidence, or a changed ring
fails closed; a generic read error is not reinterpreted as an epoch transition.

One ingestion attempt may make at most one identity-stable epoch-transition
rebase and then at most one typed same-epoch expiry rebase. A second transition
or expiry fails closed for bounded retry from fresh observation. These durable
recovery actions do not replay Agent Input and do not derive canonical truth
from CardKit state: Core events remain the authority, then the durable
projector and outbox advance their own effects.

An active Primary Binding can temporarily have no native session before its
first Agent Input creates one. While no durable Input requires ingestion, this
normal window is reported as `awaiting_session`; it is neither lag nor a
readiness failure. A pending durable Input without an exact route remains
`route_unavailable` and fails Agent Input readiness closed. A Binding that
already has a persisted exact session but whose live route cannot be resolved
is also treated as a route problem, not as awaiting its first session.

Canonical evidence reconciliation for pre-cutover data is bounded and indexed.
It joins historical pending Input Cards to the durable
`human_message.submission_id` ledger; the compatibility-only
`admitLegacyPendingCard` and `admitLegacyPending` writers are not used by live
ingress. New segments are created only by the canonical segment projector.
Missing, incomplete or ambiguous historical evidence leaves the legacy card
pending. Exact-recovery outcomes are recorded per Submission Intent: `indexing`
receives bounded retry, while `not_found`, `ambiguous`, and `unavailable`
remain visible as `needs_human`. These rows are excluded from the next bounded
candidate page, so old unresolved Inputs cannot starve later independent
Inputs.

Legacy Input Card withdrawal is a separate compatibility aggregate. A bounded
startup and periodic scan requires the immutable Submission Intent route, exact
delivered message ID, canonical Human correlation, matching Core turn, and a
terminal Conversation Segment before it atomically records one retirement and
one history-class `message_delete` outbox intent. Delivery acknowledgement is
the ordinary path from `deleting` to `retired`; retryable failures remain
pending, while terminal failures retain their evidence as `failed`. One
startup-only historical correction is evidence fenced to a persisted Feishu
CardKit `message_delete` whose exact retirement route and message ID match, and
whose dead letter records permanent, rejected provider code `230009` (message
already expired). That pre-upgrade row moves from `failed` to
`retired/already_absent` in the same transaction that dismisses its dead letter
and recovery and releases its quarantine. Uncertain effects and all other
provider codes remain failed for human review. The historical `input_card_views`
row is not erased, and the withdrawal path does not mutate Conversation,
Answer, Prompt, Main, or Worker projections.

### First-session submission

Provisioning uses the advertised Core `agentInputSubmissionV3` capability. V3 receipts require an exact native session and expose explicit millisecond timestamps; the older v2 capability remains a Core compatibility surface but is insufficient for Swarm readiness. The exact post-start Pane, terminal, Agent, and session fences are resolved before admission. There is no sessionless `runPrompt` fallback. If capability or identity is unavailable, readiness fails closed and the user gets a visible rejection.

### Trace-end Completion Review

Eligible Swarm-managed TraeX traces receive repository-owned
`herdr-choice-list` context from the `UserPromptSubmit` Hook after the
Pane/owner/generation route passes the private eligibility check. The Agent
includes at most one bounded terminal version-3 decision fence in its original
final answer. The shipped Skill, OpenAI prompt, UserPromptSubmit context, and
Stop Hook agree on the compact v3 shape: `{"version":3}` for no review, or a
choice containing `defaultOption`, `alternatives`, and real `submitText` values.
Version 2 remains read-compatible for historical text recovery, but is never
producer output. For an eligible turn, Stop classifies the collective Final
Trace Envelope rather than looking only at the physical end of the message; a
complete terminal memory citation may follow the choice fence. A first missing
or invalid v3 protocol may block Stop once and require a protocol-only repair
for the same turn; a repeated Stop with `stop_hook_active` fails open.

The Final Trace Envelope is a domain-only bounded suffix parser over the
visible answer, optional requester syntax, optional inline Skill invocation,
choice fence, and one terminal memory citation. It returns derived copies:
`projectionMarkdown` removes recognized transport and legacy requester syntax
but preserves a valid citation as canonical evidence, while
`presentationMarkdown` additionally hides that one citation. Live event
projection consumes the former; completed Answer streams and Answer Timeline
cards consume the latter. This never rewrites Core events, Segment items,
canonical positions, source cursors, or recovery evidence. Malformed,
incomplete, mid-body, duplicate, nested, fenced, or otherwise ineligible
protocol and citation text remains visible; arbitrary trailing prose cannot
make a choice valid. Presentation item fingerprints and page counts may reflect
the hidden metadata.

Core attaches a validated decision to its canonical final message as
`completion_choice`; a valid terminal `intent: none` is normalized to the
durable Continue action (`continue` / `继续`) so the user can advance even when
the agent has no explicit review options. Native typed completion-choice
metadata remains authoritative. Only when that metadata is absent, text
compatibility recovery folds non-truncated v2/v3 envelopes in canonical Core
lane order: the latest valid explicit review selects and the latest valid
explicit none replaces an older review with the same durable Continue action.
Missing, malformed, truncated, or ordinary answer text remains without
controls. Embedded requester syntax or an OpenID is compatibility evidence only.
Notification authority always comes from the exact trusted Submission Intent
actor, never from Markdown.
Swarm stores a valid `human_review`
decision as the exact Primary Prompt, canonical Primary or Worker Conversation
Segment, or Worker Turn's immutable choice specification. Once the final card
target is known, a later fenced projection transaction creates one Completion
Action Set and reserves its own immutable, fresh Completion Review card. The
frozen Answer, Turn Card, or Worker Task card is never patched with new
controls and no standalone reminder is reserved for this new flow. In the
supported compatibility path, a linked historical text reminder is dismissed in that
same reservation transaction only when it is pristine and has no possible
external effect; claimed, attempted, checkpointed, delivered, uncertain, or
otherwise conflicting evidence fails closed and prevents replacement.

The supported path remains the existing `UserPromptSubmit` writer Hook plus
bounded one-repair Stop Hook; Core emits canonical `completion_choice`, which
Swarm and Feishu consume. The writer Hook is not scheduled for removal.

The initial Completion Review payload contains the responsible actor mention,
the declared question, one to four ordered business choices, and system-owned
Ignore. A business callback is deliberately minimal: it carries only the
Action Set ID and option ID. The authenticated Gateway envelope supplies the
actor and source message; SQLite supplies owner, generation, route, and all
other fences. The transaction revalidates those facts and uses the persisted
server-side option text to create ordinary independent Agent Input; Ignore is
local and creates no Prompt or Turn. A Worker-owned canonical Segment routes a
business choice to the active Worker instance and its Worker Thread root, so
the resulting Submission Intent is Worker-owned; it still checks the Worker
generation/session and parent Binding fences. Duplicate, stale, or wrong-user
callbacks cannot create work. The same lifecycle applies to a Primary Prompt,
Primary Segment, Worker Segment, and Worker Turn. The Worker keeps its own
Worker Thread and name. Its actual Pane Identity supplies its own Delivery
Ring; the parent Primary supplies only the parent Binding/generation/Pane
fences, not delivery ordering or a parent-owned conversation thread.

The outbox records delivery before calling Lark and ACK evidence activates the
same Action Set. At startup, Swarm adopts only an exact linked, `delivered`
outbox receipt with a delivered message identity. A pending receipt stays
`presenting`; an uncertain, missing, or conflicting receipt also stays
`presenting`, records a durable recovery diagnostic, and is never replaced or
replayed automatically. Retention keeps a live `presenting` or `active`
Completion Review's Action Set-to-outbox link and frozen payload; terminal safe
history may later compact. Operational status exposes bounded lifecycle and
receipt counts only, never the review payload or choice text. This path does not
approve native tools, write terminal input directly, or resolve the separate
Herdr `blocked` Human Review episode. Historical `legacy-inline` records retain
their compatibility behavior but are not a template for new reviews.

## Explicit control routing

Only documented `/swarm ...` commands and authenticated CardKit actions are
Swarm controls. For every other eligible text, durable admission and receipt
evidence—not an acknowledgement card—determine its treatment and conversation
authority.

`/swarm steer <text>` has two safe outcomes:

- when Herdr proves an exact active Turn, inject exact-turn steering;
- otherwise submit the text as a new independent Agent Input under a dedicated source identity.

The earlier state does not gate the second outcome. `/swarm stop` revalidates Herdr's exact active Turn immediately before control. Neither command derives identity from legacy Prompt state.

`/swarm resume` only reactivates an archived Binding whose Pane is still proven. It does not resume, release, or wake a Prompt FIFO.

`/swarm awake` performs Core projection catch-up and durable card redelivery. It does not wake a Prompt dispatcher and does not submit Agent Input.

`/swarm skip` is not a command. Historical possible-effect evidence is preserved until exact recovery or explicit administrative migration outside the message surface.

## Conversation Projection

The projector consumes ordered Core lane events for an exact Agent session. A lane checkpoint stores the last committed Core position; pending and quarantined lane items expose lag without inventing order.

For live ingestion, each accepted event is reduced in the array order received from Core. Stable IDs deduplicate exact semantic repeats but never act as sort keys. First admission stores the complete projected event exactly as supplied by Core: `submission_id`, typed `choice`, and projected content are immutable. Identity comparison canonicalizes a missing legacy `turnId` as `null`. Core's `record_skipped` diagnostic generates its observation time while decoding, so that time is transport metadata and is excluded only for that diagnostic; business-event occurrence times remain identity-bearing and fail closed when they change. A `source_error` is retained as durable diagnostic evidence but is ignored before conversation projection; its lane settlement and checkpoint advancement remain in the same inbox transaction. A changed `submission_id`, typed choice, or projected content for an existing event ID is a lane-local settled semantic conflict: Swarm records only bounded diagnostics, advances that lane position, and never rewrites historical event, submission ledger, or Conversation Segment state. Projector failures are isolated by an event-scoped savepoint, which rolls back that event's view and `outbound_replies` effects while retaining its pending immutable payload and allowing the Core cursor to progress. Pending recovery reuses the original lane sequence and the existing `outbound_replies` outbox; it does not enrich, replace, rebind, or replay Core history.

Exact duplicate `token_usage` and `context_snapshot` replays are the bounded exception because they rebuild derived Session Activity during inbox ingestion and intentionally produce no Conversation Projection item. If that derived projection fails, the outer batch transaction rolls back the new replay lane item and checkpoint instead of leaving work for the conversation pending projector. The process-local Core ingress retains the queued batch until ingestion returns successfully, so the next drain retries the same canonical event and Session Activity mutation atomically. After a successful rebuild, the replay lane item is settled as ignored because the immutable event already exists in the inbox; no duplicate conversation content is created.

Exact recovery is staged before it affects formal views:

- incomplete pages remain staging-only;
- `indexing` stays retryable;
- `not_found` opens a projection gap;
- `ambiguous` preserves the old projection and requires evidence;
- a complete compatible snapshot atomically replaces the Turn projection, checkpoint, and repair delivery intent.

A late terminal repair creates a continuation delivery when needed. It does not patch a frozen Answer page or rewrite Core state.

## Delivery

Conversation Projection reserves a versioned Delivery Intent in the same
durable transition that changes the view. Reservation also freezes the complete
immutable `PreparedDelivery`: Gateway plan, idempotency and projection identity,
owner fence, checkpoints, snapshot revision, work class, and delivery order.
SQLite remains the restart and recovery authority. After commit, the prepared
value is offered directly to the process-local Delivery Engine so the hot path
does not reload or re-materialize it before the atomic claim.

The Delivery Engine owns exactly one full-data Ring for each actual Pane,
identified by `workspaceId + paneId`, plus one Global Ring for effects that are
truly not Pane-owned. Primary effects use the Primary Pane Ring. New Worker
effects use the exact current Worker Pane Ring and separately freeze the parent
Primary Pane fence. Historical Worker rows whose scope was already the parent
Pane retain that legacy Ring key and remain claimable without rescope or replay.
Missing or stale Worker runtime, parent Pane, or generation ownership fails
closed and never falls back to Global. A session or generation change updates
the item fence, not the Ring identity; `/swarm clear` therefore keeps the same
Ring while a newly created physical Pane gets a new one.

Each Ring permits one external effect at a time and advances by durable
`delivery_order`. The ready scheduler may run up to four different Rings in
parallel and applies live/history fairness across ready Rings. A quarantine
starts in grace blocking for the whole Ring. When its bounded attempt/time
budget expires, it becomes conflict-isolated: later work with another stable
conflict key may bypass it, while same-key work and explicit dependents remain
blocked. Bypass is not release—the failed Delivery, effect certainty,
quarantine, recovery link, and contiguous checkpoint gap remain durable and
queryable.

A positively proven stale, superseded, delivered, dismissed, or
completed-replacement head may be advanced transactionally. Safe supersession
requires durable `not-started` or `rejected` evidence, reconstructible current
state, a non-frozen target, stable identity, current owner/fence, no existing
effect checkpoint, and an unused recovery generation. It retains the original
Delivery as `dismissed`/`superseded`, transfers prerequisites to exactly one
replacement, and waits for that replacement's ACK before dependents advance.
At most one replay-safe replacement can therefore produce one visible
duplicate. Outside the prepared Conversation Page path, `uncertain` effects,
frozen pages, and message deletion are never automatically replayed,
replaced, dismissed, or offered as a direct one-click retry. Prepared
Conversation Page deliveries are the bounded exception: they keep the same
reply ID, plan identity, snapshot identity, and idempotency key across the
approved three-attempt policy. An uncertain attempt may already have applied in
Lark, so a later attempt may duplicate or overwrite that effect. After the
third failed attempt, the delivery is terminally dismissed, its local pending
page link is released in the same transaction, and newer page snapshots become
eligible through ordinary ordering.

Entering conflict isolation reserves one durable Human Review card on an
independent conflict key. The review survives restart or Gateway outage,
mentions the responsible Feishu actor when known, and exposes only bounded,
redacted evidence. Repeated recovery converges on the same review identity.
Dismiss preserves the original Delivery audit; Retry appears only for
confirmed-non-application effect kinds that the action handler independently
revalidates.

Commit notifications are latency hints. Startup, retry timers, overflow repair,
and periodic safety scans discover the oldest nonterminal item for each scope
from the scope/order index and hydrate full prepared values into their Rings.
This cold path makes lost hints and process restarts safe without restoring the
retired lane-head table. Delivery acknowledgement is persisted before the
process-local `DeliveryCheckpointBus` fans out convergence callbacks; a lost
callback is repaired from durable projection and delivery state.

Each observed Pane or Global scope has a durable Delivery Ring checkpoint. It
is a derived, rebasable scan watermark rather than effect authority: refill
uses the same authoritative nonterminal predicate as head selection, computes
`earliestNonterminal - 1` (or the scope maximum when no nonterminal row
exists), persists that value, and selects the current head in one SQLite
transaction. A late manual retry or recovery can therefore move the watermark
backward without changing outbox state. ACK and safe supersession may advance
the watermark as a hot-path optimization, but no recovery, Binding,
notification, or presentation writer depends on it. Refill pagination uses an
ephemeral `pageToken`; it is never persisted and is unrelated to Core cursors.

Delivery order is a presentation constraint only. It never controls Agent Input eligibility, Core conversation order, or Turn recovery.

## Legacy contraction

Production composition no longer constructs `PromptRunWorkflow`, `PrimaryPromptDispatcher`, or `QueueFeedbackProjector`. Startup and periodic recovery do not scan legacy Prompt work for execution, and status/restart safety do not treat legacy Prompt counters as ordinary work authority.

Dormant Prompt tables and recovery modules are intentionally retained while unresolved possible-effect evidence exists. They are compatibility evidence, not a dispatch surface. Test-only fixtures may start the retired workflow to prove migration and no-replay behavior; production composition must not.

Schema migration 109 is the outbound scheduler contraction boundary. It refuses
to run while any pending delivery is legacy-owned or unscoped, then removes the
legacy scheduler control, derived lane-head table, lane-head triggers/indexes,
and per-row scheduler ownership column. It preserves durable scope,
`delivery_order`, frozen Gateway plan and idempotency identity, checkpoints,
quarantine, and recovery history. The pre-contraction delivery rollback command
is no longer part of the operator surface.

## Worker runtime

Worker identity remains fenced by Worker generation, Worker-session generation, owning Primary Binding generation, and parent Pane. New Worker Session text and bootstrap text use Agent Input. Worker topology controls stay outside ordinary input.

Worker Task projections remain durable CardKit read models. Worker process-local execution and exact active controls are still considered by graceful shutdown because they can be actively observed by this process.

## Binding and runtime convergence

`SessionReconciler` is the single path for event-driven and periodic Herdr convergence. It reloads a fresh snapshot, applies identity and generation fences, then updates Binding/runtime projections. Herdr socket events and in-process notifiers are bounded hints; lost, duplicate, or reordered hints are safe.

An orphaned Binding is never repaired from card text. Reattach or replace must prove the actual Pane route. Pane creation and Agent start are checkpointed so startup can resume or fail closed without duplicating effects.

## Core session event transport

Core session observation negotiates two independent server capabilities. The
generic Herdr event subscriber selects either one global Agent-status
subscription or the legacy per-Pane subscriptions. Separately, the session
event subscriber attempts one v3 multiplex connection for the active Core
session targets. Any of the four combinations is valid: v2 or v3 session events
with per-Pane or global Agent status. A missing or rejected v3 capability keeps
the existing v2 ingestion path active.

Composition injects the Herdr-events adapter's one-shot capability probe plus
acknowledgement and frame normalizers into the multiplex transport. Core serves
one initial RPC per socket, so the probe uses its own short connection and the
acknowledged multiplex feed starts with `session.events.subscribe.v3` on a new
long-lived connection. The transport owns only that feed socket,
its acknowledged generation, target replacement, and local zero-target clear;
it imports neither the adapter nor a store. Single-assignment runtime links are
connected only after `CoreSessionIngestionSupervisor` exists: synchronous
activation reaches the supervisor before buffered frames, reconnect target
refresh reloads bounded durable cursors through the supervisor/reader, and
frames cross their narrow callback with the acknowledged transport generation.

Durable cursor authority stays in the Core event inbox and its ingestor. The
multiplex subscriber never reads or writes a cursor store. The supervisor
prepares targets from durable read cursors, accepts the generation returned
after subscription acknowledgement, serializes each frame on the matching
owner tail, and advances durable state only through the ingestor. Shutdown
closes multiplex ingress before waiting for those supervisor tails, so no new
batch can enter while durable ingestion drains.

## Recovery supervisor

Recovery proceeds in this order:

1. catch up canonical Core projection;
2. inspect projection gaps and staged exact-recovery work;
3. rebuild eligible durable view delivery;
4. redeliver through the outbox;
5. require human evidence for ambiguity.

Execution recovery is not a Primary Prompt replay stage. Possible-effect legacy data can inform exact observation, but never creates new submission work.

## Operational status and restart safety

`npm run swarm:status` and `/status` report:

- Agent Input capability/readiness and Submission Intent receipt states;
- Core session-ingestion state, run count, active/awaiting/lagging sessions,
  oldest observed lag, retry attempt/deadline, last successful ingest and last
  typed failure;
- Core projection lanes, pending/quarantined events, lag age, and open gaps;
- Delivery Ring scope counts and bytes, Pane/Global pending work, ready work,
  waiting-behind-scope work, active claims, retries, cooldown, and dead letters;
- Delivery checkpoint scope count, lowest nonterminal order/age, and bounded
  uncertain-effect and active-quarantine blocker counts, without payload data;
- bounded-degradation counts for grace-blocked scopes, isolated conflicts,
  isolated uncertainty, completed bypasses, pending Human Review, and oldest
  review age, without card or Delivery payload data;
- recovery stages and latest projection failure;
- Binding, Worker, lease, ingress, and SQLite-integrity facts.

They do not expose ordinary Prompt queue counters as current execution state.

An unforced restart gates on process-local Worker activity, actionable Ring work,
active delivery, startup recovery, lease/integrity failures, and other
non-recoverable local effects. Durable Submission Intents and legacy
possible-effect evidence are restart-recoverable and are not treated as a FIFO
blocker.

After a separately authorized rollout, epoch-transition verification is
read-only: confirm service readiness and `agentInput` readiness, then confirm
that session-ingestion lag and retry state converge. For the affected lane,
inspect the exact durable checkpoint to verify that its epoch and read cursor
move to the live ring. Only after Core final projection has caught up should
the corresponding card/outbox progress be expected. Installing, restarting,
deploying, or mutating production data are separate operator operations, not
automatic recovery commands.

### Reversible SQLite maintenance

Core Inbox payload retention has its own `CORE_EVENT_RETENTION_MODE` gate:
`off` performs no Core audit or payload write, `audit` evaluates bounded
24-hour eligibility and records semantic Audit Skeleton evidence without
clearing `event_json`, and `compact` revalidates the same barriers before the
atomic JSON-null transition. The Core source is independent from the generic
Delivery/Timeline/Conversation payload-compaction switch. Human Messages,
pending or quarantined lanes, open projection gaps, unresolved recovery, and
nonterminal or unreconstructible Turns retain their full payloads. `/status`
reports Core verified/compacted counts and eligible bytes; maintenance logs
contain aggregate counts and refusal categories, never payload text.

Logical compaction makes SQLite pages reusable by the same database. It does
not shrink the database file or release filesystem blocks. Switching the mode
back to `off` stops new Core maintenance without undoing semantic skeletons or
already compacted rows.

`npm run swarm:maintenance -- [--deadline-ms N] [--resume CYCLE_ID]` is the
only supported physical-compaction path. It initiates the service's graceful
stop, confirms the canonical unit and SQLite lease are inactive, takes a
consistent SQLite backup, drains only retention work that passes the durable
Audit Skeleton barriers under a short-lived fenced maintenance lease, and
creates a separate `VACUUM INTO` candidate. Both backup and candidate must pass
SQLite quick-check, foreign-key, current-schema, and semantic-integrity checks.

Activation is a same-directory rename. The prior database and any WAL/SHM
sidecars move together to a cycle-specific `.original` path before the
candidate becomes active, so stale sidecars cannot attach to it. The command
then starts the canonical user service and requires healthy `/health`, `/ready`,
and `/status` smoke results. Failure after activation moves the candidate to a
`.failed` path and restores the byte-identical original plus sidecars. Backup,
original, failed candidate, and the mode-`0600` phase journal are retained for
audit and manual recovery; the command never deletes them. A bounded resume
validates the journal and exact file identities before continuing.

## Fixed group Orchestrator

The optional fixed Orchestrator reuses one managed TraeX Pane and one fixed Orchestrator Thread for the default project. Its native Core Pane token must equal `orch`, its label is `herdr`, and stable identity is checked through `pane.identity_reconcile.v1`.

`/swarm clear` persists an `OrchestratorClearOperation`, increments `sessionEpoch`, rotates the Agent session, and withdraws prior Answer cards through the `message.delete` effect. Capability discovery checks `agent session-rotate --help`; absence fails closed. New session events are fenced by the new epoch so late old-session observations cannot overwrite current projection state.

## Module ownership

| Area | Primary modules |
| --- | --- |
| Composition | `src/main.ts`, `src/composition/` |
| Inbound durability and routing | `DurableInboundPipeline`, `InboundMessageRoutingWorkflow` |
| Agent Input | `AgentInputWorkflow`, `AgentInputDrainer`, `HerdrAgentInputAdapter`, SQLite agent-input store |
| Core session ingestion | `CoreSessionIngestionSupervisor`, `HerdrSessionEventSubscriber`, Herdr events adapter/reader, durable Core inbox |
| Turn observation | `ExternalTurnObserver` over durable current-session lanes and exact historical recovery |
| Projection and exact recovery | conversation projector, lane projector, exact-recovery stores/workflows |
| Explicit controls | `SwarmCommandGateway`, `CommandIntentDispatcher`, `TurnControlWorkflow` |
| Binding/Pane convergence | `SessionReconciler`, provisioning and session workflows |
| Worker runtime | instance/Worker session workflows and supervisors |
| Delivery | `OutboundIntentWriter`, `RingDeliveryEngine`, `DeliveryCheckpointBus`, CardKit renderers |
| Operations | health snapshot collector, service lifecycle CLI, SQLite operations store |

Adapters normalize external data; coordinators own decisions; domain ports define consumer-shaped contracts; SQLite owns atomic persistence; card renderers remain pure presentation.

## Security boundary

Only configured-chat, user-originated messages and configured-chat card actions enter the service. Project routes, actor allowlists, creator/admin permissions, body limits, and generation fences remain enforced before Agent Input admission. Prompt text is redacted from command errors and logs; terminal/Core content passes bounded parsing and secret redaction before persistence or delivery.
