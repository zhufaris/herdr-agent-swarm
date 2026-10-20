# Feishu Human Message Session Ingestion

## Problem Statement

Feishu ordinary text is durably admitted as an immutable Submission Intent and
is successfully submitted through Herdr Core Agent Input, but some Input Cards
remain `pending` after Core has both a durable receipt and a canonical JSONL
`human_message` carrying the same `submission_id`.

Production evidence on 2026-10-04 showed three independent defects:

1. replayed Core events with the same semantic payload but a different JSON key
   order were rejected as `Core event identity conflict`;
2. receipt recovery accepted only `agent_input_submission_v2`, while Core's
   lookup method returns `agent_events_submission_receipt`;
3. live Core session ingestion is still owned indirectly by
   `ExternalTurnObserver`, so the session stream advances only while an active
   or recoverable Turn is being observed. Idle sessions, active-boundary lookup
   failure, and exact-recovery backoff can therefore stop the durable session
   cursor even while new Human Messages continue to enter Core.

The first two defects are repaired by commits `e14a374c` and `c01bb492`. The
remaining architectural defect is visible in production: receipt uncertainty
fell from 43 to 2 after the adapter repair, while 19 Input Cards remained
pending and the affected live lane cursor remained at its earlier checkpoint.

This behavior violates the existing Core Session Event Stream design: session
ingestion must be continuous and recoverable independently of Turn ownership or
projection state. It also leaves readiness reporting `ready` while a required
Agent Input confirmation path is not converging.

## Solution

Introduce a dedicated `CoreSessionIngestionSupervisor` deep module for the
capability-gated Core v2 session stream. It owns continuous Core-to-SQLite
ingestion for every exact active Primary or Worker session and is independent
of Prompt, Turn, detached recovery, and card delivery state.

The supervisor opens the path-free Core session stream by Pane, validates the
exact Binding/Worker generation, Pane, terminal, Agent kind, native session and
stream epoch, then reads bounded ordered batches from the last cursor committed
in `core_event_inbox`. It uses the existing 512-event process-local ingestion
capacity and never advances a seen cursor outside the inbox transaction.

For compatibility, the first implementation reuses the exact durable lane
identity currently produced for the v2 `active` live boundary. This preserves
the deployed checkpoint and all pending/quarantined lane items. The code may
give that identity a session-ingestion name, but the digest input and resulting
lane ID are frozen by a compatibility test. A future lane rename requires a
separate migration design.

`ExternalTurnObserver` no longer owns remote Core reads for the current v2
session. It drains and projects durable lane items that the supervisor already
ingested. Exact-turn historical recovery remains a separate Core read path and
cannot pause current-session ingestion.

Ingestion of a canonical `human_message.submission_id` keeps the existing
atomic behavior: the event and cursor are persisted, the matching Input Card
changes from `pending` to `working`, and an idempotent Input Card update is
reserved in one SQLite transaction. A startup/periodic canonical-evidence
reconciler also repairs the narrow crash window where a matching Human Message
already exists in the durable inbox but the Input Card transition was not
applied. It never uses a receipt alone and never synthesizes conversation
order.

The supervisor participates in startup recovery, Herdr socket hints, periodic
reconciliation, shutdown, diagnostics and readiness. An exact active session
with pending Input Cards and no viable ingestion path makes the Agent Input
component not ready; ordinary historical projection debt remains degraded
operational status rather than a global liveness failure.

The change also preserves the newly deployed Answer-like Input Card shell:
`pending` and `working` use the same card identity and body, while canonical
Human Message observation changes only the status presentation.

## User Stories

### SCN-1 — New Primary Human Message

When a user sends ordinary text in a bound Primary Feishu thread, Swarm creates
one Submission Intent and one `pending` Input Card before calling Core. Core
accepts the input and writes a canonical Human Message. The session supervisor
ingests that event even if there is no active legacy Prompt, then the existing
card is updated to `working` without another Agent submission.

### SCN-2 — New Worker Human Message

Worker Session ordinary text uses the same ingestion and Input Card lifecycle
under Worker generation, Worker-session generation, parent Binding and Pane
fences. Primary activity or inactivity does not control Worker session ingest.

### SCN-3 — Multiple independent inputs

Two or more Feishu inputs may be accepted while an earlier Turn is running,
detached, recovering or uncertain. Each Submission Intent crosses Core
independently. The order of their canonical `human_message` events is copied
unchanged from the Core session stream; no Feishu timestamp, receipt time,
submission ID or SQLite row order is used to reorder them.

### SCN-4 — Restart and historical pending repair

After Swarm restarts, the supervisor resumes each session from the deployed
durable checkpoint and catches up through the Core latest cursor. Historical
Input Cards become `working` only when their matching canonical Human Message
is ingested or is already proven in the durable inbox. Repeated startup and
reconciliation are idempotent.

### SCN-5 — Crash around Input Card transition

If Swarm crashes after a Human Message is stored but before or during the card
state/outbox transition, canonical-evidence reconciliation finds the stored
event and applies the same idempotent transition. If the create card has not
been checkpointed, the latest working snapshot is scheduled only after create
delivery, using the existing projection checkpoint contract.

### SCN-6 — Duplicate and enriched events

Stable event IDs deduplicate identical replays. JSON object key order has no
semantic effect, and a missing legacy `turnId` is equivalent to canonical
`null`. A Human Message may gain `submission_id` after its first journal
representation and is safely enriched. A conflicting historical non-empty ID
is corrected only when the incoming ID has an exact Agent/session-fenced
durable Submission Intent, the old ID has no durable intent, all other
canonical event fields are unchanged, and neither canonical submission binding
points to another event. The event payload and submission ledger rebind
atomically; every other non-empty ID conflict remains an identity error.
Core-generated observation time on a `record_skipped` transport diagnostic is
not semantic identity; occurrence time remains identity-bearing for business
events. Any other semantic mutation of the same stable event ID fails closed
and opens diagnostics without advancing the durable cursor.

### SCN-7 — Source interruption, rollover and cursor expiry

A socket disconnect or process restart resumes from the committed cursor.
Opening a new stream epoch revalidates exact runtime identity and creates the
appropriate new session lane; it does not reuse a cursor across epochs. A typed
cursor-expired response invokes existing exact-turn recovery for receipt-proven
pending inputs. If canonical evidence is unavailable or ambiguous, the card
stays pending and diagnostics become `needs_human`; the body is never replayed.

### SCN-8 — Card delivery failure

Input Card create/update work uses its own `input-card:<submissionId>` delivery
lane and converges independently from unrelated Answer/Worker debt. Provider
failure remains durable and visible. This feature does not bulk-dismiss or
rewrite unrelated historical outbox or dead-letter rows.

### SCN-9 — Readiness and operations

Status reports session-ingestion loop count, lagging sessions, oldest cursor
lag, last successful ingest, retry/backoff and last typed failure. A pending
Input whose exact active session cannot be consumed prevents Agent Input
readiness from reporting healthy. Large status generation must use bounded,
indexed summaries rather than scanning full event or outbox history.

## Implementation Decisions

### Domain Model

The existing bounded contexts and language remain authoritative; no new
business aggregate is introduced.

- **Agent Input** owns Submission Intent and Input Card lifecycle. The
  Submission Intent is the aggregate root for immutable admission and receipt
  state. The Input Card is a projection, not execution state.
- **Conversation Projection** owns durable Core event lanes, checkpoints and
  derived Turn/Answer/Worker views. Core JSONL/session-event order is the sole
  final conversation-order authority.
- **Delivery and Operations** owns Input Card CardKit delivery intent,
  checkpoint, retry and failure reporting. Delivery state cannot affect Agent
  Input eligibility or Core event order.

The proposed **Session Ingestion Lease** is process-local ownership keyed by
exact session identity. It is not a new business entity. Its immutable identity
contains Binding or Worker owner identity and generation, Pane, terminal, Agent
kind, native session and Core stream epoch. Equality requires the complete
tuple. A changed tuple replaces the local loop after the old loop stops.

The following invariants are protected:

- **INV-1:** one active producer may read one Core session epoch for one durable
  live lane in a process;
- **INV-2:** only `CoreEventInboxStore.ingestBatch` advances the durable cursor;
- **INV-3:** ingest eligibility never depends on active Prompt/Turn state;
- **INV-4:** only a canonical `human_message.submission_id` changes an Input
  Card to `working`;
- **INV-5:** receipt recovery never submits the body again;
- **INV-6:** stable event equality is semantic and key-order independent, while
  non-approved semantic changes fail closed;
- **INV-7:** Input Card state and its delivery intent change atomically;
- **INV-8:** Primary and Worker session ingestion preserve their existing
  generation and parent-ownership fences.

### Architecture

#### CoreSessionIngestionSupervisor

This application/runtime module exposes a small lifecycle and wake-up
interface: start periodic convergence, request all or selected Pane/session
convergence, report diagnostics, and stop. Callers do not manage cursors,
batches, retries or stream epochs.

The module depends on consumer-owned capabilities for:

- listing exact active Primary and Worker session routes;
- opening and reading the normalized Core session stream;
- reading and writing durable inbox checkpoints/batches;
- requesting projection of newly durable lane work;
- reconciling pending Input Cards from already durable canonical evidence.

Concrete Herdr, SQLite and wake-up adapters are assembled in the composition
root. The module does not import Feishu SDK types, SQLite rows, Prompt workflow
classes or CardKit renderers.

Each session loop performs bounded work:

1. resolve and validate the current exact route;
2. open the Core stream by Pane and validate terminal/Agent/session identity;
3. derive the compatibility-frozen session lane identity;
4. start from the inbox checkpoint or Core earliest cursor for a new epoch;
5. read and ingest at most the existing 512-event budget per pass;
6. request durable projection work and reschedule while lag remains;
7. record typed failure/backoff without discarding the checkpoint.

Herdr socket events are low-latency wake-up hints. Periodic reconciliation is
the convergence path. Concurrent hints coalesce by exact session identity.

#### Durable inbox projection

Current-session Core reads move out of `ExternalTurnObserver`. The observer
retains ownership correlation, Turn adoption, Answer/Worker projection,
terminal settlement, ambiguity and exact historical recovery. For the v2 live
path it consumes only durable lane events. Legacy explicitly configured modes
retain their existing reader behavior.

The durable lane interface distinguishes:

- remote ingestion: Core batch to inbox/checkpoint;
- local projection: pending inbox event to projected/ignored/quarantined;
- exact recovery: bounded historical turn snapshot under its own identity.

This removes the current return-path hazard where exact recovery backoff or an
absent active Turn prevents current session ingestion.

#### Canonical Input Card reconciliation

The SQLite Agent Input adapter provides a bounded query/action that selects
pending Input Cards with a matching canonical Human Message already present in
`core_event_inbox`. It reuses `observeCanonicalHumanMessage`; there is one
authoritative transition implementation. Selection is indexed/bounded and
idempotent. No caller directly sets `input_card_views.state`.

#### Readiness and diagnostics

The supervisor publishes bounded diagnostics to the health snapshot. Agent
Input readiness combines Core capability with viable ingestion for exact
active sessions that own pending cards. A typed permanent identity/cursor gap
is visible; transient failures use bounded backoff. Status does not enumerate
all pending cards or events.

### Behavior & Failure Modes

- Admission, pending-card reservation and Core submission keep their existing
  transaction/effect order.
- Duplicate Feishu delivery returns the existing Submission Intent and never
  creates another Input Card or Core effect.
- Competing session wake-ups converge through one keyed process-local tail;
  only one read uses a given checkpoint at a time.
- A crash before inbox commit causes Core reread from the old cursor. A crash
  after commit resumes from the new cursor and leaves pending projection work
  durable.
- Projection failure does not roll the session cursor backward. Quarantined
  event debt remains explicit and later events may still be ingested.
- Input Card reconciliation may observe stored canonical evidence regardless
  of whether the related Turn projection is currently blocked.
- Cursor expiry never authorizes resubmission. Exact historical recovery may
  supply canonical Human Message evidence; ambiguity remains pending and
  becomes operational `needs_human`.
- Provider create/update failure changes only delivery state. The canonical
  Input Card projection remains `working` once proven.
- Shutdown stops new Core reads, boundedly awaits current inbox transactions,
  and discards only process-local wake references.

### Compatibility & Migration

- Core API method names and payloads remain unchanged.
- `agent_input_submission_v2` and `agent_events_submission_receipt` remain
  accepted at their respective submit/query seams.
- Existing event rows, lane items, quarantines, projection gaps and outbox rows
  are preserved.
- The initial supervisor uses the deployed v2 active-lane digest identity so
  the existing cursor and pending/quarantined items remain authoritative. A
  frozen test protects this byte-level compatibility.
- Existing pending Input Cards are not rewritten by migration. They converge
  only through durable canonical evidence after supervisor startup.
- Legacy `events`, `jsonl` and `shadow` observation modes remain explicit
  compatibility paths and are not routed through the v2 supervisor.
- Existing Answer-like pending/working Input Card content remains the public
  presentation.

## Testing Decisions

- **SCN-1/INV-3/INV-4:** integration test submits a Primary input while no
  Prompt/Turn observer is active, ingests the Core Human Message and asserts the
  same Input Card becomes working without another Core submit.
- **SCN-2/INV-8:** equivalent Worker-session test verifies all generation and
  parent fences.
- **SCN-3/INV-2/INV-3:** concurrent independent inputs arrive in a Core order
  different from Feishu/receipt order; inbox and projections retain Core order.
- **SCN-4/INV-1/INV-2:** SQLite reopen plus supervisor restart resumes the
  frozen deployed lane cursor and catches up historical pending cards exactly
  once.
- **SCN-5/INV-7:** store-level crash-window tests prove canonical evidence
  reconciliation and create-before-update checkpoint behavior.
- **SCN-6/INV-6:** store tests accept recursive key reordering and approved
  `submission_id` enrichment but reject actual payload changes.
- **SCN-7/INV-5:** adapter/supervisor tests cover disconnect, stream epoch
  change, cursor expiry, exact-recovery success, ambiguity and no replay.
- **SCN-8:** Input Card delivery tests cover provider rejection, duplicate
  checkpoint and lane independence from unrelated Answer/Worker debt.
- **SCN-9:** health tests verify bounded diagnostics and readiness behavior;
  query-plan tests reject full history scans for new summaries.
- Architecture-boundary tests prove the supervisor does not import Prompt,
  CardKit, Feishu SDK or concrete SQLite modules and that
  `ExternalTurnObserver` does not own v2 current-session Core reads.
- Final verification runs focused tests, `npm run typecheck`, `npm run build`,
  `npm run docs:audit`, full `npm test`, and a configured read-only production
  status check. Deployment verification submits one real Feishu input only
  after explicit deployment authorization and proves pending -> working from
  the matching Core event without replay.

## Out of Scope

- bulk dismissal, deletion or SQL rewriting of unrelated historical Answer or
  Worker outbox/dead-letter debt;
- changing Core JSONL/session-event ordering or event ID generation;
- changing explicit Swarm command routing or high-risk local approval policy;
- removing legacy Prompt evidence tables or legacy observation modes;
- globally redesigning Answer/Worker CardKit lanes;
- changing a pending Input Card to working from receipt evidence alone;
- pushing branches, opening a PR or publishing external tickets.

## Further Notes

- Workspace: `/workspace/herdr-agent-swarm`.
- Mode: in-place, because task-owned source/spec paths do not overlap the
  existing user-owned `TODO.md`, `.tmp-core-*`, `.trae/`, `docs/research/`,
  untracked earlier spec, or `handoff.md` changes.
- Branch: `main`.
- Starting revision: `c01bb492ff93e209a87cec99f7843fa5e7f99fcd`.
- Existing task evidence includes commits `e14a374c`, `2181cc67`, and
  `c01bb492`; this specification audits and extends them rather than rewriting
  their history.
- Fresh baseline on 2026-10-04: `npm test` passed 263 files and 3,764 tests;
  `npm run typecheck`, `npm run build`, and `git diff --check` passed.
- Gate 1 approved the dedicated session-ingestion design and excluded unrelated
  historical Answer/Worker delivery debt.
- No glossary or ADR change is required: the existing Agent Input and
  Conversation Projection context language already defines the authoritative
  terms and trade-off.
