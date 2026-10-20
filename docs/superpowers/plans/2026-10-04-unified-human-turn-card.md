# Unified Human Turn Card Implementation Plan

> **Superseded (2026-10-04):** Retained as implementation history for the
> Pending-first rollout. Current authority is
> `docs/spec-coder/specs/2026-10-04-canonical-human-turn-card.md` and its
> implementation plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate pending Input Card and Prompt/Worker Answer-card presentation paths with one durable Turn Card per canonical Human Message.

**Architecture:** Add a source-neutral Conversation Segment aggregate whose page zero is created at Feishu admission and adopted in place by the exact canonical `human_message`. Project Core events into segment-owned timeline rows in lane sequence, then converge Primary, Worker, steering, and direct-Herdr cards through one renderer/workflow while retaining the existing durable outbox and legacy read paths during migration.

**Tech Stack:** TypeScript ESM, Node.js >= 22.12, SQLite via the existing synchronous store/context layer, Vitest, Lark CardKit JSON, Herdr Core JSONL.

**Spec:** `docs/superpowers/specs/2026-10-04-unified-human-turn-card-design.md`

## Global Constraints

- Core JSONL lane sequence is the only final conversation-order authority; never sort by Feishu receipt, timestamp, event ID, hash, SQLite row order, submission ID, outbox order, or card sequence.
- Persist workflow/card intent in SQLite before Lark delivery, and never replay Agent Input after it may have crossed the Core effect boundary.
- The exact canonical `human_message.submission_id`, under the expected Agent/session fence, is the only pending-to-working trigger.
- Page zero remains the same physical CardKit message across `pending -> working -> terminal`.
- Primary, Worker, steering, and direct-Herdr Human Messages use one segment/page contract.
- Frozen pages are never patched; late facts remain owned by their canonical segment and use a continuation/correction page.
- The Answer page limit is the configured value whose validated production default is 9,000 characters; event counts do not create semantic boundaries.
- Existing completed/frozen Lark cards and unresolved legacy recovery evidence are not rewritten or deleted.
- Keep high-risk approval local to the Herdr Pane and preserve current configured-chat, actor, route, redaction, and generation fences.
- Add no runtime dependency and do not edit generated `dist/` output.

## Review Focus

- Two consecutive Human Messages with no intervening Assistant output must produce two visible segments and must not coalesce; Task 3 pins this.
- Canonical Human evidence arriving before CardKit create acknowledgement must update the same page after create checkpoint, not create a second message; Task 5 pins this.
- Duplicate live ingestion and authoritative recovery of the same event must be idempotent and retain one segment/page; Task 3 pins this.
- An outbox target/idempotency conflict on one segment must quarantine that page without blocking a later Human segment; Task 6 pins this.
- A recovered event belonging to a frozen old segment must create an old-segment correction continuation rather than appearing in the newest card; Task 5 pins this.

---

## File Structure

### New focused modules

- `src/domain/conversation-segment.ts` — immutable segment/page identities, lifecycle types, and pure state transitions.
- `src/domain/ports/conversation-segment.ts` — consumer-shaped admission, projection, query, delivery, and checkpoint ports.
- `src/store/sqlite/migrations/conversation-segment-migrations.ts` — forward-only schema revision and indexes.
- `src/store/sqlite/conversation-segment-store.ts` — atomic pending admission, canonical adoption, event projection, page reservation, and checkpoint persistence.
- `src/cards/turn-card.ts` — source-neutral CardKit shell around the existing canonical timeline renderer.
- `src/coordinator/turn-card-workflow.ts` — one keyed convergence workflow for all segment pages.

### Existing modules changed at integration seams

- `src/store/sqlite/migrations.ts`, `src/store/sqlite/schema.ts`, `src/store/sqlite/lease-store.ts`, `src/store/sqlite/capability-graph.ts` — register the schema/store and lease-protected tables.
- `src/domain/input-card-view.ts`, `src/domain/ports/agent-input.ts`, `src/coordinator/agent-input-workflow.ts`, `src/store/sqlite/submission-intent-store.ts` — admit a pending segment/page rather than a separate `input_card_views` lifecycle for new inputs.
- `src/store/sqlite/core-event-inbox-store.ts` — give canonical Human observation the lane sequence needed for exact segment boundaries.
- `src/runtime/herdr-events/event-projector.ts`, `src/domain/answer-timeline.ts` — expose canonical event positions without re-sorting by item ID.
- `src/domain/ports/presentation.ts`, `src/cards/cardkit-application-presentation.ts` — expose the unified Turn Card renderer.
- `src/composition/create-bridge-runtime.ts`, `src/composition/create-outbound-runtime.ts` — wire one store/workflow and keep legacy workflows only as compatibility readers.
- `src/coordinator/projection-delivery-recovery-watchdog.ts`, `src/store/sqlite/outbox-delivery-store.ts`, `src/store/sqlite/outbox-recovery-store.ts` — recover unified pages by immutable segment/page identity.
- `src/store/sqlite/operations-store.ts`, `src/health/health-snapshot-collector.ts`, `src/domain/ports/health.ts` — report unified pending/working/needs-human and delivery backlog.
- `docs/architecture.md`, `docs/feishu-group-usage.md` — make the unified model current behavioral authority after cutover.

---

### Task 1: Add the Conversation Segment domain and forward-only schema

**Files:**
- Create: `src/domain/conversation-segment.ts`
- Create: `src/domain/ports/conversation-segment.ts`
- Create: `src/store/sqlite/migrations/conversation-segment-migrations.ts`
- Modify: `src/store/sqlite/migrations.ts`
- Modify: `src/store/sqlite/schema.ts`
- Modify: `src/store/sqlite/lease-store.ts`
- Test: `tests/conversation-segment.test.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: existing `AnswerTimelineItem`, `SubmissionIntentOwnerKind`, `OutboundWorkClass`, and `SqliteContext`.
- Produces: `ConversationSegment`, `ConversationSegmentPage`, `ConversationSegmentEventPosition`, `ConversationSegmentStore`, and schema revision 95 tables used by every later task.

- [x] **Step 1: Write failing pure-domain tests**

```ts
it("closes the old segment before the next canonical Human position", () => {
  const closed = closeConversationSegment(openSegment, { laneSequence: 12, itemOrdinal: 0 }, now);
  expect(closed).toMatchObject({ state: "closed", endBefore: { laneSequence: 12, itemOrdinal: 0 } });
});

it("does not use event IDs to break canonical position ties", () => {
  expect(compareSegmentPosition({ laneSequence: 4, itemOrdinal: 0 }, { laneSequence: 4, itemOrdinal: 1 })).toBeLessThan(0);
});
```

- [x] **Step 2: Run the domain test and verify RED**

Run: `npx vitest run tests/conversation-segment.test.ts`

Expected: FAIL because `conversation-segment.ts` and its exports do not exist.

- [x] **Step 3: Define exact domain types and transitions**

```ts
export type ConversationSegmentState = "pending" | "working" | "completed" | "failed" | "cancelled" | "needs_human" | "closed";
export interface ConversationSegmentEventPosition { laneSequence: number; itemOrdinal: number }
export interface ConversationSegment {
  id: string; producerKey: string; ownerKind: "primary" | "worker"; ownerId: string; ownerGeneration: number;
  submissionId: string | null; humanEventId: string | null; agentKind: "traex" | "pi"; sessionId: string | null;
  requestText: string; startAt: ConversationSegmentEventPosition | null; endBefore: ConversationSegmentEventPosition | null;
  state: ConversationSegmentState; viewVersion: number; rootMessageId: string; createdAt: string; updatedAt: string;
}
export interface ConversationSegmentPage {
  id: string; segmentId: string; pageIndex: number; messageId: string | null; cardId: string | null;
  elementId: string; state: "creating" | "active" | "frozen" | "finished"; sequence: number;
  startCursor: AnswerTimelineCursor | null; deliveredCursor: AnswerTimelineCursor | null;
}
```

Implement `compareSegmentPosition`, `closeConversationSegment`, `workingConversationSegment`, and `terminalConversationSegment` as pure functions that reject invalid backward transitions.

- [x] **Step 4: Write failing migration tests**

Assert schema revision 95 creates:

```sql
conversation_segments(
  id PRIMARY KEY, producer_key, owner_kind, owner_id, owner_generation,
  submission_id UNIQUE NULL, human_event_id UNIQUE NULL, agent_kind, session_id NULL,
  request_text, start_lane_sequence NULL, start_item_ordinal NULL,
  end_lane_sequence NULL, end_item_ordinal NULL, state, view_version,
  root_message_id, created_at, updated_at
)
conversation_segment_items(
  segment_id, item_id, lane_sequence, item_ordinal, item_json,
  PRIMARY KEY(segment_id,item_id), UNIQUE(segment_id,lane_sequence,item_ordinal)
)
conversation_segment_pages(
  id PRIMARY KEY, segment_id, page_index, message_id, card_id, element_id,
  state, sequence, start_cursor_json, delivered_cursor_json,
  pending_reply_id, created_at, updated_at,
  UNIQUE(segment_id,page_index)
)
```

Also assert the lease-owned table list contains all three tables and that reopening an existing database is idempotent.

- [x] **Step 5: Implement the migration and static schema mirror**

Put all revision-95 SQL in `conversation-segment-migrations.ts`; call it from `SqliteMigrations.run()`. Add checks enforcing paired start/end position columns and permitted state values. Do not backfill legacy Answer rows in this task.

- [x] **Step 6: Run focused tests and typecheck**

Run: `npx vitest run tests/conversation-segment.test.ts tests/sqlite-store.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/domain/conversation-segment.ts src/domain/ports/conversation-segment.ts src/store/sqlite/migrations/conversation-segment-migrations.ts src/store/sqlite/migrations.ts src/store/sqlite/schema.ts src/store/sqlite/lease-store.ts tests/conversation-segment.test.ts tests/sqlite-store.test.ts
git commit -m "feat: add durable conversation segments"
```

### Task 2: Admit Feishu input as pending segment page zero

**Files:**
- Create: `src/store/sqlite/conversation-segment-store.ts`
- Modify: `src/domain/input-card-view.ts`
- Modify: `src/domain/ports/agent-input.ts`
- Modify: `src/coordinator/agent-input-workflow.ts`
- Modify: `src/store/sqlite/submission-intent-store.ts`
- Modify: `src/store/sqlite/capability-graph.ts`
- Test: `tests/submission-intent-store.test.ts`
- Test: `tests/input-card.test.ts`

**Interfaces:**
- Consumes: `ConversationSegmentStore.admitPending`, `ApplicationPresentation.turnCard`, existing Submission Intent transaction and outbox enqueue.
- Produces: atomic `Submission Intent + pending segment + page zero + card_reply` admission and stable projection key `turn-card:<segmentId>:page:0`.

- [x] **Step 1: Add failing admission tests**

```ts
it("atomically admits one pending Turn Card page with the Submission Intent", () => {
  const result = store.admit(input, pendingTurnCardReservation);
  expect(loadSegmentBySubmission(input.submissionId)).toMatchObject({ state: "pending", humanEventId: null });
  expect(listSegmentPages(result.segmentId)).toHaveLength(1);
  expect(outbox()).toMatchObject([{ kind: "card_reply", projectionKey: `turn-card:${result.segmentId}:page:0` }]);
});

it("deduplicates source delivery without creating another segment or outbox row", () => {
  store.admit(input, pendingTurnCardReservation);
  expect(store.admit(input, pendingTurnCardReservation).outcome).toBe("duplicate");
  expect(countSegmentsBySubmission(input.submissionId)).toBe(1);
});
```

Add a rollback assertion by injecting an enqueue failure and proving neither the intent nor segment remains.

- [x] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/submission-intent-store.test.ts tests/input-card.test.ts`

Expected: FAIL because admission still writes `input_card_views` and stores separate pending/working JSON.

- [x] **Step 3: Define the pending reservation contract**

```ts
export interface PendingTurnCardReservation {
  segmentId: string;
  rootMessageId: string;
  card: object;
}

export interface AdmitPendingConversationSegmentInput {
  segmentId: string; submissionId: string; producerKey: string;
  owner: SubmissionIntentOwner; agentKind: "traex" | "pi";
  expectedSessionId: string | null; requestText: string;
  rootMessageId: string; card: object; occurredAt: string;
}
```

Change `AgentInputStore.admit` to accept `PendingTurnCardReservation`; do not pre-render a separate working card. `AgentInputWorkflow` uses one `idFactory()` result for `submissionId`, a second for `segmentId`, and calls `presentation.turnCard(pendingView)` once.

- [x] **Step 4: Implement atomic pending admission**

Inside the existing `SqliteSubmissionIntentStore.admit` transaction, insert the Submission Intent, call `conversationSegments.admitPending(...)`, create page zero, and enqueue:

```ts
{
  id: `${projectionKey}:create`,
  idempotencyKey: `${projectionKey}:create`,
  kind: "card_reply",
  projectionKey,
  snapshotRevision: 1,
  laneKeyOverride: projectionKey
}
```

Retain reads/recovery for historical `input_card_views`; stop writing that table for new admissions.

- [x] **Step 5: Render the pending shell through the future Turn Card contract**

Temporarily adapt `renderInputCard` to `renderTurnCard` input so the visible output remains Answer-style and contains full sanitized Human text. Pin Pending copy and ensure the serialized card stays within configured payload limits.

- [x] **Step 6: Run focused tests and typecheck**

Run: `npx vitest run tests/submission-intent-store.test.ts tests/input-card.test.ts tests/agent-input-workflow.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/store/sqlite/conversation-segment-store.ts src/domain/input-card-view.ts src/domain/ports/agent-input.ts src/coordinator/agent-input-workflow.ts src/store/sqlite/submission-intent-store.ts src/store/sqlite/capability-graph.ts tests/submission-intent-store.test.ts tests/input-card.test.ts tests/agent-input-workflow.test.ts
git commit -m "feat: admit input as pending turn card"
```

### Task 3: Project canonical Human boundaries and segment-owned timeline items

**Files:**
- Modify: `src/domain/ports/conversation-segment.ts`
- Modify: `src/domain/ports/outbox.ts`
- Modify: `src/store/sqlite/conversation-segment-store.ts`
- Modify: `src/store/sqlite/core-event-inbox-store.ts`
- Modify: `src/runtime/herdr-events/event-projector.ts`
- Modify: `src/domain/answer-timeline.ts`
- Test: `tests/core-event-inbox-store.test.ts`
- Test: `tests/conversation-segment-store.test.ts`
- Test: `tests/answer-timeline-card.test.ts`

**Interfaces:**
- Consumes: lane-owned `(laneId, sequence)` from `core_event_lane_items`, normalized timeline deltas, exact Human submission/session fence.
- Produces: `projectCanonicalEvent(input): ConversationSegmentProjectionResult` that closes/adopts/creates segments and upserts ordered items in one transaction.

- [x] **Step 1: Write failing canonical-boundary tests**

Cover exact adoption, direct Human creation, two consecutive Human events with no Assistant output, wrong-session submission rejection, duplicate live/recovery replay, and item updates preserving their original position.

```ts
expect(project(humanA)).toMatchObject({ outcome: "adopted", segmentId: pendingA.id });
expect(project(humanB)).toMatchObject({ outcome: "created", segmentId: expect.any(String) });
expect(load(pendingA.id).endBefore).toEqual({ laneSequence: 8, itemOrdinal: 0 });
expect(listOpenSegments(producerKey)).toEqual([expect.objectContaining({ id: segmentB.id })]);
```

Assert an event with lane sequence 7 cannot be moved after sequence 8 by lexicographically larger/smaller IDs.

- [x] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/core-event-inbox-store.test.ts tests/conversation-segment-store.test.ts tests/answer-timeline-card.test.ts`

Expected: FAIL because canonical observation has no lane sequence and timeline helpers sort by item ID.

- [x] **Step 3: Carry canonical position through projection**

Extend the dependency call made from `SqliteCoreEventInboxStore`:

```ts
projectCanonicalEvent(input: {
  laneId: string; laneSequence: number; event: CoreEventEnvelope; observedAt: string;
}): { outcome: "adopted" | "created" | "projected" | "duplicate" | "ignored"; segmentId: string | null };
```

Read `laneSequence` from the row inserted/loaded in the same inbox transaction. Do not derive it from `occurredAt` or cursor text.

- [x] **Step 4: Implement atomic segment reduction**

For `human_message`, close the current producer segment at `{ laneSequence, itemOrdinal: 0 }`, exact-adopt by `submission_id` and Agent/session fence, or create a direct working segment. Bind `human_event_id` once and enqueue a page-zero snapshot revision.

For all other visible items, require one open segment and upsert each item with `{ laneSequence, itemOrdinal }`, where `itemOrdinal` is its order in the normalized delta array. Preserve the original position when a running Tool row is updated by a later result.

- [x] **Step 5: Remove ID-based presentation ordering**

Change canonical timeline preparation to consume already ordered items. Where a defensive check is needed, assert strictly increasing `(laneSequence,itemOrdinal)` and fail projection rather than sorting. Keep stable item IDs only for exact upsert/dedup.

- [x] **Step 6: Run focused tests, typecheck, and architecture check**

Run: `npx vitest run tests/core-event-inbox-store.test.ts tests/conversation-segment-store.test.ts tests/answer-timeline-card.test.ts tests/answer-timeline-page.test.ts`

Expected: PASS.

Run: `npm run typecheck && npm run architecture:check`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/domain/ports/conversation-segment.ts src/store/sqlite/conversation-segment-store.ts src/store/sqlite/core-event-inbox-store.ts src/runtime/herdr-events/event-projector.ts src/domain/answer-timeline.ts tests/core-event-inbox-store.test.ts tests/conversation-segment-store.test.ts tests/answer-timeline-card.test.ts tests/answer-timeline-page.test.ts
git commit -m "feat: segment canonical human turns"
```

### Task 4: Build the shared Turn Card renderer

**Files:**
- Create: `src/cards/turn-card.ts`
- Modify: `src/domain/ports/presentation.ts`
- Modify: `src/cards/cardkit-application-presentation.ts`
- Modify: `src/cards/answer-timeline.ts`
- Modify: `src/cards/answer-timeline-page.ts`
- Test: `tests/turn-card.test.ts`
- Test: `tests/answer-timeline-card.test.ts`
- Test: `tests/answer-timeline-page.test.ts`

**Interfaces:**
- Consumes: `ConversationSegmentCardView`, segment page metadata, and ordered `AnswerTimelineItem[]`.
- Produces: `ApplicationPresentation.turnCard(view, page, options): object` shared by every owner kind.

- [x] **Step 1: Write failing rendering tests**

Pin Pending/Working/Completed headers, full sanitized Human request, compact Primary/Worker identity, collapsed full Thinking, stateful Tool panels, and explicit waiting-for-command with no Assistant text.

```ts
expect(elements(thinkingCard)).toContainEqual(expect.objectContaining({
  tag: "collapsible_panel", expanded: false,
  header: { title: expect.objectContaining({ content: expect.stringContaining("思考") }) },
  elements: [expect.objectContaining({ content: fullThinkingText })]
}));
expect(text(waitingCard)).toContain("Waiting for command");
```

Add payload-boundary cases for an 8,000-character Human request, secret-like text, ANSI, empty text, and a Worker header.

- [x] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/turn-card.test.ts tests/answer-timeline-card.test.ts tests/answer-timeline-page.test.ts`

Expected: FAIL because `turnCard` does not exist and Input/Answer shells remain separate.

- [x] **Step 3: Define the renderer view**

```ts
export interface ConversationSegmentCardView {
  segmentId: string; ownerKind: "primary" | "worker"; ownerLabel: string;
  spaceName: string; paneToken: string | null; requestText: string;
  state: ConversationSegmentState; timelineItems: readonly AnswerTimelineItem[];
  gapWarning: string | null; viewVersion: number;
}
```

Expose `turnCard(view, page, { timelineItems, continuation, completionActions })` from `ApplicationPresentation`. Keep renderer input free of SQLite rows and coordinator objects.

- [x] **Step 4: Implement one CardKit shell**

Use the existing `renderAnswerTimelineItem` and page planner. Render Human text in the header/body context once, omit `human_message` timeline body items, keep Thinking full text collapsed, and render `status:blocked` even when it is the only body event. Page > 0 repeats compact request context and page number.

- [x] **Step 5: Run renderer tests and typecheck**

Run: `npx vitest run tests/turn-card.test.ts tests/input-card.test.ts tests/answer-timeline-card.test.ts tests/answer-timeline-page.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/cards/turn-card.ts src/domain/ports/presentation.ts src/cards/cardkit-application-presentation.ts src/cards/answer-timeline.ts src/cards/answer-timeline-page.ts tests/turn-card.test.ts tests/input-card.test.ts tests/answer-timeline-card.test.ts tests/answer-timeline-page.test.ts
git commit -m "feat: render unified human turn cards"
```

### Task 5: Converge every segment through one page workflow

**Files:**
- Create: `src/coordinator/turn-card-workflow.ts`
- Modify: `src/domain/ports/conversation-segment.ts`
- Modify: `src/store/sqlite/conversation-segment-store.ts`
- Modify: `src/composition/create-outbound-runtime.ts`
- Modify: `src/composition/create-bridge-runtime.ts`
- Test: `tests/turn-card-workflow.test.ts`
- Test: `tests/human-turn-card.integration.test.ts`

**Interfaces:**
- Consumes: `ConversationSegmentStore.loadCardView`, `getActivePage`, `reserveSnapshot`, `reserveContinuation`, `reserveFinish`, `reserveLateContinuation`; `ApplicationPresentation.turnCard`.
- Produces: `TurnCardWorkflow.converge(segmentId, workClass?)` and `convergeActionable()`.

- [x] **Step 1: Write failing convergence tests**

Cover:

1. create pending page zero;
2. canonical adoption before create acknowledgement, then checkpoint-driven working update to the same message;
3. ordinary working snapshot update;
4. 9,000-character continuation in the same segment;
5. terminal freeze/finalization;
6. recovered old-segment event producing a correction continuation;
7. keyed serialization coalescing concurrent convergence calls.

```ts
expect(delivery.map(({ kind }) => kind)).toEqual(["card_reply"]);
checkpointCreate(page0.messageId);
await workflow.converge(segment.id);
expect(delivery.at(-1)).toMatchObject({ kind: "card_update", rootMessageId: page0.messageId });
expect(store.listPages(segment.id)).toHaveLength(1);
```

- [x] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/turn-card-workflow.test.ts tests/human-turn-card.integration.test.ts`

Expected: FAIL because no unified workflow is wired.

- [x] **Step 3: Implement keyed convergence**

Mirror the proven `tails: Map<string, Promise<void>>` serialization pattern, but key only by `segmentId`. The workflow plans page content from persisted segment items and reserves all delivery in the store transaction. It never reads Lark to infer targets.

- [x] **Step 4: Implement create-checkpoint catch-up and immutable pagination**

If page zero has no `messageId`, return after the create intent. On create checkpoint, persist `messageId/cardId`, compare delivered revision with the current segment revision, and reserve the latest snapshot. Freeze a page before reserving its continuation. Route late old-segment facts through `reserveLateContinuation` even when a newer segment exists.

- [x] **Step 5: Wire runtime notifications**

Expose the workflow through `createOutboundRuntime`. Core segment projection, outbox checkpoints, startup convergence, and recovery watchdog schedule `turn:<segmentId>` rather than Primary/Worker-specific card keys for unified rows. Keep `AnswerPageWorkflow` and `WorkerTurnCardWorkflow` wired only for legacy actionable rows.

- [x] **Step 6: Run focused integration tests and typecheck**

Run: `npx vitest run tests/turn-card-workflow.test.ts tests/human-turn-card.integration.test.ts tests/answer-page-workflow.test.ts tests/worker-turn-card-workflow.test.ts`

Expected: PASS, including legacy compatibility cases.

Run: `npm run typecheck && npm run architecture:check`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/coordinator/turn-card-workflow.ts src/domain/ports/conversation-segment.ts src/store/sqlite/conversation-segment-store.ts src/composition/create-outbound-runtime.ts src/composition/create-bridge-runtime.ts tests/turn-card-workflow.test.ts tests/human-turn-card.integration.test.ts tests/answer-page-workflow.test.ts tests/worker-turn-card-workflow.test.ts
git commit -m "feat: converge unified turn card pages"
```

### Task 6: Add recovery, quarantine isolation, and operational diagnostics

**Files:**
- Modify: `src/coordinator/projection-delivery-recovery-watchdog.ts`
- Modify: `src/store/sqlite/conversation-segment-store.ts`
- Modify: `src/store/sqlite/outbox-delivery-store.ts`
- Modify: `src/store/sqlite/outbox-recovery-store.ts`
- Modify: `src/store/sqlite/operations-store.ts`
- Modify: `src/health/health-snapshot-collector.ts`
- Modify: `src/domain/ports/health.ts`
- Test: `tests/projection-delivery-recovery-watchdog.test.ts`
- Test: `tests/outbox-recovery-policies.test.ts`
- Test: `tests/health-snapshot-collector.test.ts`
- Test: `tests/human-turn-card.integration.test.ts`

**Interfaces:**
- Consumes: immutable `segmentId/pageIndex`, unified projection key, outbox checkpoint/dead-letter state.
- Produces: isolated recovery of missing page delivery plus `/status` counts for segment lifecycle and unified delivery backlog.

- [x] **Step 1: Write failing recovery and isolation tests**

```ts
it("quarantines one mismatched page without blocking a later segment", async () => {
  poisonTarget(segmentA, 0);
  enqueueReadySnapshot(segmentB, 0);
  await dispatcher.drain();
  expect(pageEffect(segmentA, 0).state).toBe("dead_letter");
  expect(pageEffect(segmentB, 0).state).toBe("delivered");
});
```

Also test create-effect ambiguity, missing target, frozen-page late continuation, and stable retry reusing the same idempotency key and payload.

- [x] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/projection-delivery-recovery-watchdog.test.ts tests/outbox-recovery-policies.test.ts tests/health-snapshot-collector.test.ts tests/human-turn-card.integration.test.ts`

Expected: FAIL because recovery recognizes only Primary Answer and Worker Task families.

- [x] **Step 3: Add the unified recovery family**

Teach the watchdog and recovery policy to parse only:

```ts
type TurnCardProjectionTarget = { family: "turn-card"; segmentId: string; pageIndex: number };
```

Validate the stored page target before replacement. On mismatch, record a segment/page projection gap and quarantine that effect. Never fall back to `latest message_id`, another segment, or legacy Prompt identity.

- [x] **Step 4: Add diagnostics**

Expose:

```ts
turnCards: {
  pending: number; working: number; terminal: number; needsHuman: number;
  pagesAwaitingCreate: number; pagesAwaitingUpdate: number; quarantined: number;
}
```

Keep legacy counters explicitly labeled until the migration exit criteria are met. Readiness fails only for required current-path capability/integrity failures, not historical frozen-card debt.

- [x] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run tests/projection-delivery-recovery-watchdog.test.ts tests/outbox-recovery-policies.test.ts tests/health-snapshot-collector.test.ts tests/human-turn-card.integration.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/coordinator/projection-delivery-recovery-watchdog.ts src/store/sqlite/conversation-segment-store.ts src/store/sqlite/outbox-delivery-store.ts src/store/sqlite/outbox-recovery-store.ts src/store/sqlite/operations-store.ts src/health/health-snapshot-collector.ts src/domain/ports/health.ts tests/projection-delivery-recovery-watchdog.test.ts tests/outbox-recovery-policies.test.ts tests/health-snapshot-collector.test.ts tests/human-turn-card.integration.test.ts
git commit -m "feat: recover unified turn card delivery"
```

### Task 7: Cut over new writes, retain legacy reads, and verify the release

**Files:**
- Modify: `src/coordinator/answer-page-workflow.ts`
- Modify: `src/coordinator/worker-turn-card-workflow.ts`
- Modify: `src/store/sqlite/answer-segment-store.ts`
- Modify: `src/store/sqlite/submission-intent-store.ts`
- Modify: `src/cards/input-card.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/feishu-group-usage.md`
- Test: `tests/human-turn-card.integration.test.ts`
- Test: `tests/external-turn-observer.test.ts`
- Test: `tests/authoritative-turn-snapshot-store.test.ts`
- Test: `tests/submission-intent-store.test.ts`

**Interfaces:**
- Consumes: all unified segment/card interfaces from Tasks 1-6.
- Produces: production composition that writes only the unified path for new Human Messages while retaining legacy recovery/read behavior.

- [x] **Step 1: Add cutover regression tests**

Prove that new Feishu Primary input, Worker input, steering input, and direct-Herdr Human events create no new `input_card_views`, `answer_segments`, Primary Answer page, or Worker Task page rows. Prove historical rows still converge and no recovery path submits Agent Input.

- [x] **Step 2: Run the cutover tests and verify RED**

Run: `npx vitest run tests/human-turn-card.integration.test.ts tests/external-turn-observer.test.ts tests/authoritative-turn-snapshot-store.test.ts tests/submission-intent-store.test.ts`

Expected: FAIL while one or more new-write paths still target legacy card aggregates.

- [x] **Step 3: Remove remaining new-write routing to legacy card aggregates**

Keep legacy workflow methods callable only from startup/recovery queries that return historical actionable IDs. Delete the production call from canonical Human observation to `input_card_views` for unified submissions. Keep the legacy tables, migrations, and readers intact.

- [x] **Step 4: Update current documentation**

Document the three-object model, exact pending-to-working evidence, direct-Herdr behavior, Primary/Worker parity, continuation pagination, and status fields. Mark the 2026-09-28 and 2026-10-01 design documents superseded; do not delete them.

- [x] **Step 5: Run the affected suite**

Run:

```bash
npx vitest run \
  tests/conversation-segment.test.ts \
  tests/conversation-segment-store.test.ts \
  tests/submission-intent-store.test.ts \
  tests/core-event-inbox-store.test.ts \
  tests/turn-card.test.ts \
  tests/turn-card-workflow.test.ts \
  tests/human-turn-card.integration.test.ts \
  tests/external-turn-observer.test.ts \
  tests/authoritative-turn-snapshot-store.test.ts \
  tests/projection-delivery-recovery-watchdog.test.ts \
  tests/outbox-recovery-policies.test.ts
```

Expected: PASS.

- [x] **Step 6: Run all repository gates**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run architecture:check`

Expected: PASS.

Run: `npm test`

Expected: all Vitest files pass.

Run: `npm run build`

Expected: PASS and generated build identity succeeds without manually editing `dist/`.

Run: `git diff --check`

Expected: no output.

- [x] **Step 7: Perform read-only deployment preflight**

Run: `npm run config:validate -- "$HOME/.config/herdr-agent-swarm/.env" "$HOME/.config/herdr-agent-swarm/projects.json"`

Expected: valid configured environment and project registry. If the actual configured paths differ, obtain them from the installed user unit without printing secrets and run the same validator against those exact files.

Run: `npm run swarm:status`

Expected: capture the pre-deploy readiness, queued/running/uncertain work, outbox backlog, projection gaps, recovery stages, and latest CardKit error. Do not install or restart in this task without a separate explicit deployment authorization.

Observed: configuration validation passed for 5 projects and 5 workspaces on `127.0.0.1:8788`. The installed unit was active, but the bridge endpoint timed out and recent logs reported existing `outbound_prompt_reference` integrity degradation, historical CardKit sequence rejection, an outbound idempotency conflict, and earlier SQLite lock failures. These operational findings were recorded without mutating runtime state and remain a deployment blocker/risk outside this branch repair.

- [x] **Step 8: Commit**

```bash
git add src/coordinator/answer-page-workflow.ts src/coordinator/worker-turn-card-workflow.ts src/store/sqlite/answer-segment-store.ts src/store/sqlite/submission-intent-store.ts src/cards/input-card.ts docs/architecture.md docs/feishu-group-usage.md tests/human-turn-card.integration.test.ts tests/external-turn-observer.test.ts tests/authoritative-turn-snapshot-store.test.ts tests/submission-intent-store.test.ts
git commit -m "refactor: cut over unified human turn cards"
```

### Task 8: Repair canonical Worker adoption and Core-only segment selection

**Files:**
- Modify: `src/coordinator/instance-messaging-workflow.ts`
- Modify: `src/coordinator/turn-control-workflow.ts`
- Modify: `src/coordinator/worker-turn-dispatcher.ts`
- Modify: `src/domain/agent-runtime.ts`
- Modify: `src/domain/ports/conversation-segment.ts`
- Modify: `src/domain/ports/instance.ts`
- Modify: `src/runtime/agents/terminal-agent-driver.ts`
- Modify: `src/runtime/agents/traex-driver.ts`
- Modify: `src/store/sqlite/conversation-segment-store.ts`
- Modify: `src/store/sqlite/worker-turn-store.ts`
- Test: `tests/agent-driver-contract.test.ts`
- Test: `tests/conversation-segment-store.test.ts`
- Test: `tests/instance-messaging.integration.test.ts`
- Test: `tests/turn-control-workflow.integration.test.ts`

**Interfaces:**
- Consumes: stable Worker turn identity, native Herdr submission queue, expected Agent session fence, and Core lane position.
- Produces: one pending Worker/steering Turn Card that is adopted by the exact canonical Human Message without synthetic timeline positions, plus canonical-only open-segment selection.

- [x] **Step 1: Add and observe focused Red tests**

Prove a visible Worker turn remains pending with no Human timeline row before Core evidence, the dispatcher carries its exact submission identity, canonical Human adoption reuses the same segment/page, and altered SQLite timestamps cannot change the selected segment.

- [x] **Step 2: Implement exact native submission and pending adoption**

Use the Worker turn ID as the native `submission_id`, require the native session fence, create the unified segment in `pending`, and request projection without inventing a canonical Human item.

- [x] **Step 3: Remove non-Core segment ordering**

Exclude unadopted pending segments from canonical producer listings and choose open segments only by `start_lane_sequence,start_item_ordinal`. Fail closed on duplicate canonical starts rather than adding a non-Core tie-breaker.

- [x] **Step 4: Run affected verification**

Focused Red became Green; 11 affected suites passed with 163 tests, typecheck passed, architecture validation checked 494 source files, and the build generated a new identity.

- [x] **Step 5: Repeat Standards and Spec review**

Both axes passed with no Critical or Important finding. Standards retained only low-risk duplication/readability notes.

- [x] **Step 6: Run read-only preflight and fresh full repository verification**

Read-only preflight completed with the existing production risks recorded in Task 7 Step 7. Fresh verification passed: 272 Vitest files and 3865 tests, plus typecheck, architecture validation across 494 source files, and build identity `sha256:d8447a6d7aacc6fab4437376fa510102302b95e709dcddcedf54a9eaf234c2a3`.

- [x] **Step 7: Commit the repair atomically**

### Task 9: Make page-zero creation and ordinary-message checkpoint atomic

**Status:** Gate 3 approved; implementation in progress.

**Files:**
- Modify: `src/domain/ports/conversation-segment.ts`
- Modify: `src/store/sqlite/conversation-segment-store.ts`
- Modify: `src/store/sqlite/submission-intent-store.ts`
- Modify: `src/events/outbound-delivery-executor.ts`
- Modify: `src/events/gateway-outbox-dispatcher.ts`
- Modify: `src/composition/create-outbound-runtime.ts`
- Modify: `src/coordinator/turn-card-workflow.ts`
- Test: `tests/agent-input-workflow.test.ts`
- Test: `tests/conversation-segment-store.test.ts`
- Test: `tests/human-turn-card.integration.test.ts`
- Test: `tests/turn-card-outbound-callback.test.ts`
- Test: `tests/turn-card-workflow.test.ts`
- Test: `tests/feishu-gateway-plugin.test.ts`

**Spec references:** `ARCH-R1`, `INV-R1`, and `SCN-R1` through `SCN-R7` in
`docs/superpowers/specs/2026-10-04-unified-human-turn-card-design.md`.

**What to build:** Deliver one complete repaired Feishu Turn Card path. The
same SQLite transaction that admits a pending segment must create page zero,
reserve its only initial `card_reply`, and link that reply through
`pending_reply_id`. A real ordinary Feishu receipt containing only `messageId`
must checkpoint the page and unlock all later update/finalize/continuation work
against that physical message. Startup or periodic convergence must adopt a
uniquely linked create that was already delivered before its page checkpoint;
ambiguous evidence must open a projection gap and must not send a replacement.

**Ownership and implementation path:**

- `SqliteConversationSegmentStore.admitPending` is the aggregate persistence
  boundary for segment + page zero + create effect + exact effect link. Extend
  its input only with transport routing data required by the existing outbox;
  keep presentation payload and immutable projection identity intact.
- `SqliteSubmissionIntentStore` remains the Input Intent transaction owner and
  invokes that deep operation inside the same transaction, but removes its
  independent `enqueue` call. Duplicate admission returns before either owner
  creates a new effect.
- `ConversationSegmentStore.checkpointPage` accepts required `messageId` and
  optional `cardId`. It verifies the exact `pendingReplyId` when checkpointing
  a create; existing immutable message/surface values may be repeated but not
  contradicted.
- Ordinary `card_update` paths (`reserveSnapshot`, terminal finalize, and page
  continuation) use the page's required message target and do not require a
  fabricated CardKit surface. Streaming-specific paths retain their surface
  requirement.
- `OutboundDeliveryExecutor` notifies Turn Card listeners for a delivered
  Turn Card projection whenever `deliveredMessageId` exists, passing the
  optional `cardIdCheckpoint` without inventing one. Composition preserves that
  optionality through the store checkpoint.
- Before convergence can reserve another effect, the segment store/workflow
  reconciles a `creating` page with its exact linked outbox row. A unique
  delivered `card_reply` with matching projection identity adopts its
  `delivered_message_id` and optional surface checkpoint atomically. Missing,
  conflicting, wrong-kind, wrong-target, or multiple ownership evidence opens
  one idempotent `turn_recovery` projection gap and leaves the page unchanged.
- Core lane order, canonical Human adoption, Agent Input replay policy, frozen
  pages, 9,000-character pagination, and all legacy read paths remain unchanged.
  No migration deletes existing external cards or rewrites production data.

**Acceptance criteria and verification:**

- [ ] **Step 1 — Observe RED for production-shaped delivery.** Change
  `tests/turn-card-outbound-callback.test.ts` so the gateway returns only a
  message ref. Assert the listener receives `(segmentId, pageIndex, messageId,
  null)` and reconvergence runs. Run
  `npx vitest run tests/turn-card-outbound-callback.test.ts`; it must fail
  because the current executor gates notification on `cardIdCheckpoint`.
- [ ] **Step 2 — Observe RED for atomic admission.** Extend
  `tests/agent-input-workflow.test.ts` and
  `tests/human-turn-card.integration.test.ts` to prove accepted admission has
  exactly one page-zero create row whose ID equals `pending_reply_id`, duplicate
  admission adds nothing, and an injected enqueue failure rolls back the Input
  Intent, segment, page, and outbox row together. Assert later convergence
  before delivery returns `waiting` and does not create a second reply. Run the
  two tests and confirm failure against the current split owner.
- [ ] **Step 3 — Observe RED for restart adoption and fail-closed recovery.** In
  `tests/human-turn-card.integration.test.ts`, persist then reopen each state:
  linked undelivered create; linked delivered message-only create; linked
  delivered create with optional surface; wrong projection key/kind; conflicting
  delivered identity; and missing link. Prove only the two exact delivered
  states adopt, duplicate recovery is idempotent, undelivered work reuses its
  original reply, ambiguity opens an idempotent projection gap, and no case
  emits a second create. Run the integration test and confirm the delivered
  uncheckpointed case fails before implementation.
- [ ] **Step 4 — Implement the minimum aggregate and port repair.** Move initial
  enqueue/linking into `admitPending`, remove the Submission Intent store's
  second enqueue, make ordinary card surface identity optional end-to-end, and
  add exact linked-create recovery. Do not add a runtime dependency or schema
  migration unless a Red test proves the existing schema cannot express the
  invariant.
- [ ] **Step 5 — Prove ordinary message-target convergence.** Extend
  `tests/turn-card-workflow.test.ts` and the SQLite integration test so a
  message-only checkpoint can update a working card, finish a terminal card,
  and create a continuation reply without a surface ID; an immutable message
  or non-null surface conflict must remain stale and open recovery evidence.
  Preserve the gateway plugin test proving the real Feishu adapter returns a
  message ref without manufacturing a surface ref.
- [ ] **Step 6 — Run focused Green verification.** Run:

  ```bash
  npx vitest run \
    tests/agent-input-workflow.test.ts \
    tests/human-turn-card.integration.test.ts \
    tests/turn-card-outbound-callback.test.ts \
    tests/turn-card-workflow.test.ts \
    tests/feishu-gateway-plugin.test.ts
  npm run typecheck
  npm run architecture:check
  npm run build
  git diff --check
  ```

  All commands must pass. Inspect the complete diff for duplicate create
  ownership, lossy optional-target conversion, replay risk, and unrelated
  changes.
- [ ] **Step 7 — Run full delivery verification and commit atomically.** Run
  `npm test`, repeat `npm run typecheck`, `npm run architecture:check`,
  `npm run build`, and `git diff --check` from fresh output. Stage only the
  Task 9 paths plus the approved spec/plan amendments and commit as
  `fix: checkpoint unified turn card replies`. Do not push, install, restart,
  mutate production SQLite, or delete external cards in this ticket.

**Blocked by:** None. Deployment and real Feishu acceptance remain a separate
authorized operational stage after the committed implementation passes
delivery review.

## Plan Self-Review

- **Spec coverage:** Admission, exact adoption, direct Human creation, Primary/Worker/steering parity, canonical segmentation, full Thinking/tool/waiting rendering, pagination, frozen late results, durable idempotency, recovery isolation, migration, diagnostics, documentation, and full verification map to Tasks 1-8. The post-deployment single-create, message-only checkpoint, and restart-adoption repair maps completely to Task 9.
- **Placeholder scan:** The plan contains no deferred implementation marker; every test/code step names its interface, expected failure/pass, and command.
- **Type consistency:** `segmentId`, `ConversationSegmentEventPosition`, page identity, `turn-card:<segmentId>:page:<pageIndex>`, and `ApplicationPresentation.turnCard` are introduced once and used consistently by later tasks.
- **Review Focus coverage:** Consecutive Humans and duplicate recovery are in Task 3; pre-ack adoption and frozen late facts are in Task 5; mismatch isolation is in Task 6. Task 9 covers `SCN-R1` through `SCN-R7`, including the real message-only receipt, rollback, restart adoption, duplicate recovery, and fail-closed ambiguity.
- **Scope:** Tasks 1-8 delivered the original vertical path. Task 9 is one intentionally indivisible repair because admission ownership, receipt conversion, checkpoint persistence, and restart recovery must change together to avoid another half-cutover state. Historical cleanup and deployment remain separate.
