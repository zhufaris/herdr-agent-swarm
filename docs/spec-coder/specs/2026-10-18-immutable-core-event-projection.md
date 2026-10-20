# Immutable Core Event Consumption and Feishu Delivery

<!-- spec-coder:artifact-v1 spec -->

Date: 2026-10-18

Status: delivered; reopened Gate 3 implementation, dual-axis review, and fresh dual-repository verification accepted.

Core authority: `<herdr-core-repo>/.worktrees/fix/immutable-event-projection/.local/prd/2026-10-18-immutable-event-projection-plan.md`.

Workspace: `<repo-root>/.trae/worktrees/final-trace-envelope`, branch `worktree-final-trace-envelope`, baseline `c057118c2a2f087b5137caa76e01ab4934da3b85`, containing local `main` `f3eea7aec86710b43758c2ea09a8591eed3472ec` plus the accepted final-trace and three-attempt prepared-delivery changes. The earlier `fix/core-session-ingestion-replay` worktree and its seven provisional files remain untouched and are not an implementation source.

## Problem Statement

Core already owns the canonical append-only event Journal. Swarm therefore must not create a second event outbox or treat its SQLite copy as another event authority. The rejected design did both indirectly: it expected historical Core events to gain `submission_id` or typed `choice`, merged those differences into `core_event_inbox.event_json`, and considered a second replay cursor.

Latest-main inspection shows that v3 multiplex and the normal ring-v2 path already use one Core ring cursor and owner/generation fences. The remaining failures are local. `SqliteCoreEventInboxStore` can still replace a submission alias, preserve or add historical human-message enrichment, update an existing event JSON document, or throw an identity conflict that rolls back the whole batch. One deterministic bad item can therefore keep the cursor on the same batch and block later independent events.

Swarm still needs a local durable consumption record. If it advances the Core cursor to avoid head-of-line blocking, it must retain enough payload for a failed local projection to retry after the bounded Core ring window expires. This record is an inbox, not an outbox and not canonical history. Feishu delivery is a distinct external side effect and continues to require the existing durable `outbound_replies` outbox.

## Solution

Keep one immutable Core-event consumption path and one existing Feishu outbox.

```text
Core Journal (canonical authority)
  -> Core session ring / v3 multiplex (single cursor)
  -> Swarm core_event_inbox + lane item (thin inbox / receipt)
  -> deterministic conversation and card projection
  -> outbound_replies (the only outbox)
  -> Feishu/Lark
```

On first admission, Swarm inserts the projected event exactly as Core supplied it. Optional `submission_id` and typed `choice` are write-once projection annotations that are already complete on that first projection. An exact semantic duplicate is idempotent. A different payload for the same public event ID is a deterministic conflict: Swarm never mutates the settled event, stores only bounded conflict diagnostics on the lane item, marks that ring position ignored, and continues the batch.

Normal projection remains atomic with its Feishu outbox reservation and Core cursor update. If the projector throws, an event-scoped SQLite savepoint rolls back partial projection/outbox writes while preserving the immutable inbox row and pending lane item; the outer batch transaction may then continue and advance the cursor. Existing bounded pending-projection recovery retries that local projection and eventually quarantines it. A later successful retry creates projection state and `outbound_replies` in one SQLite transaction. Delivery attempts remain independent and never repeat Core ingestion or TraeX input.

The thin inbox may retain a full payload only while local projection/recovery needs it. Existing retention compaction may later replace settled payloads with immutable identity/hash/state evidence. Core Journal remains the only source for canonical event history.

## User Stories

### SCN-1: Typed choice is present on first admission

Swarm receives one projected human event whose `submission_id` and typed `choice` were joined by Core during first Journal admission. It stores that projection once, creates the conversation/card projection and reserves the required Feishu outbox intent in the same SQLite transaction as the ring cursor.

### SCN-2: Exact duplicate follows reconnect

An event with the same public event ID and immutable semantic projection is idempotent even when transport `source_id` or cursor metadata differs. Swarm does not reproject or redeliver it, and the single ring cursor continues.

### SCN-3: Conflicting duplicate appears in a batch

An event reuses a settled public event ID but changes source-derived content, `submission_id`, or typed `choice`. Swarm leaves the existing event and canonical-submission binding unchanged, records a bounded conflict count/hash/time on the lane item, marks the conflicting ring position ignored, and continues later items in the same batch.

### SCN-4: Local projection fails after admission

Swarm durably retains the immutable inbox event and pending lane item, rolls back partial reducer/outbox effects for that item, continues independent later events, and advances the Core cursor. Pending recovery can retry from the local inbox without asking Core to mutate or republish history.

### SCN-5: Pending projection later succeeds

Recovery projects the stored event with its original lane sequence and atomically reserves the existing `outbound_replies` intent. Ordering derives from durable lane sequence, not retry completion time.

### SCN-6: Pending projection exhausts its bounded attempts

The lane item becomes quarantined with bounded failure evidence. It does not mutate the Core event, rewind the ring cursor, block later messages, or submit another TraeX prompt.

### SCN-7: Feishu delivery fails three times

The existing prepared-delivery policy records the third failure as terminal/dead-lettered and continues later independent delivery work. The Core inbox, ring cursor and TraeX submission are not repeated.

### SCN-8: Core repairs a missed Journal event into the ring

Swarm consumes the repaired immutable projection through the ordinary ring-v2 or v3 multiplex path and its existing single cursor. No canonical replay sidecar or second high-water is used.

## Implementation Decisions

### INV-1: Core Journal is the event authority

`core_event_inbox` is a local consumption receipt and bounded retry payload. It cannot enrich, replace or reinterpret a Core event and is never exposed as canonical history.

### INV-2: Projected events are immutable after first admission

For an existing event ID, Swarm never performs `None -> Some`, `Some -> None`, alias replacement, choice preservation/merge, or any other `event_json` update. A future legitimate annotation must arrive as a new explicitly linked event.

### INV-3: One Core cursor

Ring-v2 and v3 multiplex retain the existing epoch-qualified ring cursor only. Swarm stores no replay revision, choice cursor or second high-water.

### INV-4: Conflict is a settled consumption outcome

A deterministic identity conflict writes bounded lane-local diagnostics and is ignored for projection. It advances consumption and cannot roll back unrelated valid items in the batch.

### INV-5: Projection failure preserves retry material

An event-scoped savepoint removes partial projection and outbox effects but retains the immutable inbox row and pending lane item in the outer transaction. Cursor progress never discards the only local payload needed for retry.

### INV-6: Projection and Feishu intent are atomic

Whenever projection succeeds, its conversation/card state and required `outbound_replies` reservation commit together. There is no event outbox between Core and Swarm.

### INV-7: Feishu delivery is independent

The existing SQLite outbox owns network idempotency, claims, attempts, dead-lettering and delivered IDs. Delivery never participates in Core cursor acknowledgement and never repeats a prompt.

### INV-8: Inbox payload retention is bounded

Pending rows retain retry payload. Settled projected/ignored/quarantined rows remain eligible for the existing audited compaction path, which preserves identity and semantic hash evidence without making Swarm canonical history.

### INV-9: Owner and generation fences remain authoritative

Multiplex route ownership, binding/worker generation, card identity and outbox claim fences are preserved. Conflict skipping does not bypass them.

## Architecture

### ARCH-1: Simplify the existing inbox store

Remove `canonicalSubmissionResolution`, `canPreserveCanonicalHumanEnrichment`, historical `event_json` updates and the enrichment-aware merge helper. Replace them with immutable semantic equality that ignores only transport-local source/cursor metadata and includes all projected payload fields, including `submission_id` and `choice`.

### ARCH-2: Keep diagnostics on the lane item

Add bounded conflict metadata to `core_event_lane_items` rather than introducing an event outbox or storing conflicting candidate bodies. One lane/event row retains count, last candidate hash/reason and observation time.

### ARCH-3: Isolate one event with a SQLite savepoint

The outer batch transaction still validates lane identity and commits the final cursor. Each event gets an admission/projection savepoint so deterministic conflict or projector failure cannot roll back previously handled or later independent items. A store-wide SQLite failure still rolls back the complete batch and cursor.

### ARCH-4: Reuse pending projection recovery

The existing pending/quarantined lane lifecycle owns local retry. Recovery reads the immutable inbox payload and original lane sequence. No Core replay API or event outbox is added.

### ARCH-5: Reuse the existing Feishu outbox

Reducers continue to reserve `outbound_replies` through the current store transaction. Prepared delivery keeps the accepted three-attempt skip behavior already present in this workspace.

### ARCH-6: Reader and subscriber stay single-cursor

`HerdrEventsReader`, v3 multiplex subscriber and ingestion supervisor keep their latest-main contracts. The seven provisional replay-capability edits in the older worktree are not copied or committed.

## Testing Decisions

- Prove first admission with typed choice creates one immutable inbox row, one projection and the expected existing outbox intent.
- Prove exact duplicates with different transport cursor/source metadata are idempotent.
- Prove changed `submission_id`, changed/missing choice and changed source-derived payload are conflicts, never mutations.
- Put a conflict between two valid events in one batch and prove both valid events project, conflict diagnostics persist and the cursor reaches the batch high-water.
- Inject projector failure after partial reducer/outbox work and prove the savepoint removes partial effects while retaining a pending inbox row and allowing the next event to project.
- Retry the pending item and prove projection plus `outbound_replies` are atomic and use the original lane sequence.
- Exhaust pending projection attempts and prove quarantine without cursor rewind or later-message blocking.
- Preserve compacted-inbox guards and prove no settled payload is resurrected or rewritten.
- Preserve single-cursor ring-v2/v3 multiplex, owner/generation fences and three-attempt Feishu delivery tests.
- Run focused identity/inbox/migration/retention/projection/outbox tests, `npm run typecheck`, `npm run build`, `npm test` and `git diff --check`.

Baseline evidence: on `c057118c`, fresh `npm run typecheck`, `npm run build`, and `npm test` all exited 0 on 2026-10-18. The full suite passed 313 files and 5,176 tests. The worktree was clean before this specification was added.

## Out of Scope

- A Swarm event outbox, second canonical event store or full Core history mirror.
- Session canonical replay, choice replay, dual cursors or global replay as card authority.
- Modifying the preserved seven-file provisional worktree.
- Production SQLite repair, live Feishu E2E, installation, restart, deployment, push or pull request.

## Further Notes

- The term `core_event_inbox` is intentional: it is consumer-owned receipt/retry state. `outbound_replies` is the outbox.
- Existing compacted hashes remain retention evidence. The implementation plan must explicitly handle already-compacted rows without resurrecting payload or adding a mutable compatibility merge.
- Core ring reconciliation may redeliver exact immutable events. Swarm idempotency absorbs that without any event update.
- Delivery review found no confirmed Standards or Spec defect. Installation, restart, deployment, push, and production data mutation remain unauthorized.
