# Human Message Answer Segmentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every subsequent canonical Human Message visibly start a new durable Answer Card segment without creating or replaying an Agent Prompt.

**Architecture:** Add a source-neutral Answer-segment domain model over the existing canonical timeline, persist segment boundaries and page ownership in SQLite, and let the existing Primary and Worker card convergence workflows render only the active segment. Boundary creation, previous-page freeze, next-page creation, and outbox reservation are atomic with the owning projection transaction; CardKit delivery remains retryable and never repeats Agent input.

**Tech Stack:** TypeScript, Node.js SQLite, Vitest, existing CardKit presentation/outbox ports.

**Spec:** `docs/superpowers/specs/2026-10-01-human-message-answer-segmentation-design.md`

## Global Constraints

- Every subsequent canonical `human_message` starts one segment; Feishu and Herdr-local origins use identical semantics.
- Keep the same Prompt ID, native submission ID, Core turn ID, FIFO position, and observer. Segment creation must not submit or replay Agent input.
- Freeze the previous page at the canonical cursor before the Human Message; content on either side must never cross the boundary or patch a frozen page.
- The new card immediately shows `⏳ 已接收，Agent 正在继续处理。` and `Reply to 👤 <current-human-message-summary>`; the Human Message is not repeated in the body.
- Persist the timeline fact, segment boundary, page transition, and outbox intents atomically and make duplicate Core events idempotent.
- Separate Human Messages are never coalesced, including consecutive messages with no Agent output between them.
- Segment-card creation remains ordered even when the previous page has not yet
  received its CardKit create checkpoint; a later segment must never overtake an
  earlier segment on delivery.
- Existing historical pages remain in segment zero and are not repartitioned by migration.
- Preserve existing redaction, request-summary bounds, projection-gap evidence, immutable-page rules, and no-replay recovery.

## Review Focus

- A duplicate Human Message event must reuse its existing segment and emit no extra CardKit create effect; Task 2 pins this with a reopen/idempotency test.
- Two consecutive Human Messages before any Agent output, including a boundary before the current page's create ACK, must create and deliver distinct cards in segment order; Tasks 2 and 3 pin storage, lane/dependency ordering, and Primary rendering.
- A Tool begun before the boundary and completed after it must surface as a late result on the new segment without patching the old one; Tasks 3 and 4 pin Primary and Worker behavior.
- A committed boundary with an undelivered card must retry only the outbox effect after restart; Task 5 pins crash/recovery behavior.
- A pre-feature database containing historical Human Messages must keep all old pages in segment zero and must not create cards during migration; Task 2 pins compatibility.

---

### Task 1: Define deterministic Answer segment boundaries

**Files:**
- Create: `src/domain/answer-segment.ts`
- Modify: `src/domain/delivery.ts`
- Modify: `src/domain/ports/presentation.ts`
- Test: `tests/answer-segment.test.ts`

**Interfaces:**
- Consumes: canonical `AnswerTimelineItem[]` ordered by `(sequence, id)` and the existing `AnswerTimelineCursor` shape.
- Produces: `AnswerSegment`, `AnswerSegmentBoundary`, `findUnmaterializedHumanBoundaries(...)`, and `itemsForAnswerSegment(...)`; presentation options accept `segment?: AnswerSegment` without changing default segment-zero rendering.

- [ ] **Step 1: Write failing pure-domain tests**

  Add tests named `finds each subsequent human message as an ordered segment boundary`, `does not return an already materialized human boundary`, `keeps consecutive human messages as distinct empty segments`, and `selects only items inside one segment while excluding the human body item`. Assert stable Human Message IDs, request text, start/end sequence bounds, and source-neutral results.

- [ ] **Step 2: Run the domain test and verify RED**

  Run: `npx vitest run tests/answer-segment.test.ts`

  Expected: FAIL because `src/domain/answer-segment.ts` does not exist.

- [ ] **Step 3: Add the domain contracts and pure functions**

  Define:

  ```ts
  export interface AnswerSegment {
    aggregateKind: "primary-run" | "worker-turn";
    aggregateId: string;
    segmentIndex: number;
    sourceHumanItemId: string | null;
    requestText: string;
    startAfterSequence: number;
    endBeforeSequence: number | null;
    state: "open" | "closed";
  }

  export interface AnswerSegmentBoundary {
    sourceHumanItemId: string;
    requestText: string;
    sequence: number;
  }

  export function findUnmaterializedHumanBoundaries(
    items: readonly AnswerTimelineItem[],
    materializedSourceIds: ReadonlySet<string>,
    activationSequence: number,
  ): AnswerSegmentBoundary[];

  export function itemsForAnswerSegment(
    items: readonly AnswerTimelineItem[],
    segment: AnswerSegment,
  ): AnswerTimelineItem[];
  ```

  Keep Human Messages out of returned body items. Preserve late Tool Result handling as a separate render-time prefix; do not mutate canonical Tool identities here.

- [ ] **Step 4: Run focused tests and typecheck**

  Run: `npx vitest run tests/answer-segment.test.ts && npm run typecheck`

  Expected: all tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit**

  ```bash
  git add src/domain/answer-segment.ts src/domain/delivery.ts src/domain/ports/presentation.ts tests/answer-segment.test.ts
  git commit -m "feat: define durable answer segments"
  ```

### Task 2: Persist segments and atomically reserve boundary effects

**Files:**
- Modify: `src/store/sqlite/schema.ts`
- Modify: `src/store/sqlite/migrations.ts`
- Modify: `src/store/sqlite/migrations/card-outbox-migrations.ts`
- Create: `src/store/sqlite/answer-segment-store.ts`
- Modify: `src/store/sqlite/projection-store.ts`
- Modify: `src/store/sqlite/worker-turn/projection.ts`
- Modify: `src/store/sqlite/lease-store.ts`
- Modify: `src/store/sqlite/capability-graph.ts`
- Modify: `src/domain/ports/projection.ts`
- Modify: `src/domain/ports/instance.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/sqlite-capability-graph.test.ts`

**Interfaces:**
- Consumes: Task 1 `AnswerSegmentBoundary` and rendered previous/follow-up cards supplied by projection owners.
- Produces: `listAnswerSegments(aggregateKind, aggregateId)` and transactional `reserveHumanMessageAnswerSegments(input): { created: number; replyIds: string[] }`. The input includes aggregate identity, expected generation, ordered boundaries, previous finalized card, one next-card payload per boundary, root message ID, and work class.

- [ ] **Step 1: Write failing SQLite tests for schema, atomicity, and compatibility**

  Cover segment-zero creation for new Primary and Worker views; exact source-item uniqueness; two consecutive boundaries producing two segment/page rows and two non-coalesced create intents; a boundary before the preceding page's create ACK remaining ordered behind that effect; duplicate reservation returning `created: 0`; rollback leaving timeline, pages, segments, and outbox unchanged; lease fencing; and reopen persistence. Add a pre-migration fixture with an already-consumed Human Message and assert migration assigns all existing pages to segment zero without creating outbox work.

- [ ] **Step 2: Run the focused store tests and verify RED**

  Run: `npx vitest run tests/sqlite-store.test.ts tests/sqlite-capability-graph.test.ts -t "Answer segment|answer segment|Human Message boundary"`

  Expected: FAIL on missing schema/store capability.

- [ ] **Step 3: Add the implementation-time next available migration and the focused store**

  At implementation time, inspect `schema_migrations` usage and assign the next available migration version; plans do not reserve migration numbers. Add `answer_segments` keyed by `(aggregate_kind, aggregate_id, segment_index)`, with unique non-null `(aggregate_kind, aggregate_id, source_human_item_id)`, request text, activation/boundary sequences, state, and timestamps. Add `segment_index NOT NULL DEFAULT 0` to `answer_pages` and `worker_turn_card_pages`. The migration seeds only segment zero, records each aggregate's current maximum timeline sequence as its activation watermark, and emits no outbound row.

  Implement `SqliteAnswerSegmentStore` and include every new table in the lease write-fence list. Use existing nested SQLite transactions so callers already inside `projectCoreEvent(...)` or Worker transition transactions commit timeline, segment/page changes, and outbox intents together. Use source Human Message ID for idempotency; do not derive identity from text or timestamp.

- [ ] **Step 4: Run store tests, full SQLite tests, and typecheck**

  Run: `npx vitest run tests/sqlite-store.test.ts tests/sqlite-capability-graph.test.ts && npm run typecheck`

  Expected: all tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/store/sqlite/schema.ts src/store/sqlite/migrations.ts src/store/sqlite/migrations/card-outbox-migrations.ts src/store/sqlite/answer-segment-store.ts src/store/sqlite/projection-store.ts src/store/sqlite/worker-turn/projection.ts src/store/sqlite/lease-store.ts src/store/sqlite/capability-graph.ts src/domain/ports/projection.ts src/domain/ports/instance.ts tests/sqlite-store.test.ts tests/sqlite-capability-graph.test.ts
  git commit -m "feat: persist answer segment boundaries"
  ```

### Task 3: Project and render Primary Human Message segments

**Files:**
- Modify: `src/events/conversation-view-projector.ts`
- Modify: `src/coordinator/answer-page-workflow.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `src/cards/answer-card-header.ts`
- Modify: `src/cards/answer-timeline-page.ts`
- Test: `tests/answer-page-workflow.test.ts`
- Test: `tests/answer-timeline-page.test.ts`
- Test: `tests/event-card-integration.test.ts`
- Test: `tests/core-event-recovery.test.ts`

**Interfaces:**
- Consumes: Task 1 segment selection and Task 2 transactional reservation through `ProjectionStore` / `AnswerPageStore`.
- Produces: Primary cards whose header and body are derived from the page's segment, plus immediate accepted-state cards for empty follow-up segments.

- [ ] **Step 1: Write failing Primary behavior tests**

  Assert one follow-up freezes the delivered old page at the pre-message cursor and reserves a new card with `Reply to 👤 Continue from Feishu` plus `⏳ 已接收，Agent 正在继续处理。`. Assert redaction and header-summary bounds still apply; later Agent output appears only on the new card; duplicate Core replay creates no extra page/outbox row; Feishu and Herdr-local observations with the same canonical facts produce the same segments; two consecutive messages create two ordered cards; and a pre-boundary Tool completion arriving later is emitted through the existing late-result mechanism on the active segment.

- [ ] **Step 2: Run Primary focused tests and verify RED**

  Run: `npx vitest run tests/answer-page-workflow.test.ts tests/answer-timeline-page.test.ts tests/event-card-integration.test.ts tests/core-event-recovery.test.ts -t "Human Message segment|human message segment|follow-up segment"`

  Expected: FAIL because Primary convergence still consumes Human Messages without changing cards.

- [ ] **Step 3: Integrate Primary projection and rendering**

  During exact Core-event projection, detect all unmaterialized boundaries after the durable activation watermark and call Task 2's reservation in the same outer transaction. Render the previous segment with its bounded items before freezing it. Render each new page with segment request text overriding `RunCardView.requestText`; an empty open segment renders exactly `⏳ 已接收，Agent 正在继续处理。`. Update `AnswerPageWorkflow.convergeTimeline(...)` to select the active segment's items and preserve existing cursor/checkpoint, continuation, gap-warning, and finalization behavior.

- [ ] **Step 4: Run Primary tests and shared projection tests**

  Run: `npx vitest run tests/answer-page-workflow.test.ts tests/answer-timeline-page.test.ts tests/event-card-integration.test.ts tests/core-event-recovery.test.ts`

  Expected: all selected tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/events/conversation-view-projector.ts src/coordinator/answer-page-workflow.ts src/cards/run-card.ts src/cards/answer-card-header.ts src/cards/answer-timeline-page.ts tests/answer-page-workflow.test.ts tests/answer-timeline-page.test.ts tests/event-card-integration.test.ts tests/core-event-recovery.test.ts
  git commit -m "feat: split primary answers on human messages"
  ```

### Task 4: Apply the same segment contract to Worker answers

**Files:**
- Modify: `src/coordinator/worker-turn-observer.ts`
- Modify: `src/coordinator/worker-turn-card-workflow.ts`
- Modify: `src/cards/worker-turn-card.ts`
- Modify: `src/store/sqlite/worker-turn-store.ts`
- Test: `tests/worker-turn-observer.test.ts`
- Test: `tests/worker-turn-card-workflow.test.ts`
- Test: `tests/worker-turn-card-view.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2 segment contracts and transactional Worker projection capability.
- Produces: Worker Task Answer pages with the same source-neutral Human Message boundary semantics and no changes to Worker turn identity or dispatch.

- [ ] **Step 1: Write failing Worker behavior tests**

  Cover a Worker Human Message boundary, two consecutive messages, exact event deduplication, correct `Reply to` summary, output isolation across frozen/new pages, and a Tool result completed after the boundary. Assert no new `instance_turns` row and no repeated driver submit/steer call.

- [ ] **Step 2: Run Worker tests and verify RED**

  Run: `npx vitest run tests/worker-turn-observer.test.ts tests/worker-turn-card-workflow.test.ts tests/worker-turn-card-view.test.ts -t "Human Message segment|human message segment|follow-up segment"`

  Expected: FAIL because Worker convergence has no segment ownership.

- [ ] **Step 3: Integrate Worker projection and rendering**

  Extend the existing atomic `transitionInstanceTurnWithProjection(...)` path to materialize boundaries and reserve their page effects. Reuse Task 1 selection and the same accepted/continuing copy. `WorkerTurnCardWorkflow` must read the page's segment rather than the whole timeline; it must retain Worker generation fences, canonical root/thread ownership, projection-gap warning, and existing continuation behavior.

- [ ] **Step 4: Run Worker and cross-surface tests**

  Run: `npx vitest run tests/worker-turn-observer.test.ts tests/worker-turn-card-workflow.test.ts tests/worker-turn-card-view.test.ts tests/primary-worker-flow.integration.test.ts`

  Expected: all selected tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/coordinator/worker-turn-observer.ts src/coordinator/worker-turn-card-workflow.ts src/cards/worker-turn-card.ts src/store/sqlite/worker-turn-store.ts tests/worker-turn-observer.test.ts tests/worker-turn-card-workflow.test.ts tests/worker-turn-card-view.test.ts
  git commit -m "feat: split worker answers on human messages"
  ```

### Task 5: Prove restart recovery and complete the operational contract

**Files:**
- Modify: `src/coordinator/startup-view-converger.ts`
- Modify: `src/store/sqlite/outbox-delivery-store.ts`
- Modify: `src/store/sqlite/outbox-recovery/replaceable-card.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/feishu-group-usage.md`
- Modify: `TODO.md`
- Test: `tests/startup-view-converger.test.ts`
- Test: `tests/answer-page-recovery.integration.test.ts`
- Test: `tests/lark-outbox-dispatcher.test.ts`
- Test: `tests/documentation-audit.test.ts`

**Interfaces:**
- Consumes: durable segment/page/outbox evidence from Tasks 2-4.
- Produces: startup convergence that resumes the exact active segment and operator documentation describing the visible boundary.

- [ ] **Step 1: Write failing crash-window tests**

  Cover restart after the boundary transaction but before create delivery, restart after new-card create ACK but before later content, a permanent/uncertain delivery failure, and startup with multiple consecutive empty segments. Assert only the pending CardKit effect retries, old pages remain frozen, segment IDs stay stable, and no Prompt/Worker turn dispatch occurs.

- [ ] **Step 2: Run recovery tests and verify RED**

  Run: `npx vitest run tests/startup-view-converger.test.ts tests/answer-page-recovery.integration.test.ts tests/lark-outbox-dispatcher.test.ts -t "Answer segment|answer segment|Human Message boundary"`

  Expected: at least one crash-window assertion FAILS before startup integration.

- [ ] **Step 3: Integrate startup convergence and docs**

  Make startup converge creating/active segment pages from durable rows only. Do not infer a boundary from terminal contents or rewrite historical segment-zero pages. Update architecture and Feishu usage docs, and leave the TODO item open until production acceptance proves Feishu and Herdr-local cases.

- [ ] **Step 4: Run the complete gate**

  Run:

  ```bash
  npm test
  npm run typecheck
  npm run architecture:check
  npm run docs:audit
  npm run build
  git diff --check
  ```

  Expected: every command exits 0.

- [ ] **Step 5: Commit**

  ```bash
  git add src/coordinator/startup-view-converger.ts src/store/sqlite/outbox-delivery-store.ts src/store/sqlite/outbox-recovery/replaceable-card.ts docs/architecture.md docs/feishu-group-usage.md TODO.md tests/startup-view-converger.test.ts tests/answer-page-recovery.integration.test.ts tests/lark-outbox-dispatcher.test.ts tests/documentation-audit.test.ts
  git commit -m "feat: recover human message answer segments"
  ```

### Task 6: Install and accept the feature in production

**Files:**
- Modify: `TODO.md`
- Modify: `.superpowers/sdd/2026-10-01-human-message-answer-segmentation-plan/progress.md`

**Interfaces:**
- Consumes: the fully reviewed Tasks 1-5 release candidate.
- Produces: installed immutable Swarm release plus durable live evidence for one Feishu and one Herdr-local follow-up boundary.

- [ ] **Step 1: Review the whole branch and remediate blocking findings**

  Run independent Standards and Spec reviews against this plan/spec. Fix Critical/Important findings, rerun their covering tests, and record verdicts in the plan ledger.

- [ ] **Step 2: Install and restart through the supported lifecycle**

  Run `./install.sh`, refresh `npm run swarm:status`, inspect durable queued/running work, and use `npm run swarm:restart -- --force` only when the operator authorization for this rollout is current.

- [ ] **Step 3: Execute live acceptance**

  For one Feishu follow-up and one Herdr-local follow-up inside active exact turns, record the Human Message event ID, segment/page identity, outbox reply ID, CardKit checkpoint, and absence of a second Prompt/native submission. Verify the old card is frozen, the new card visibly acknowledges the current Human Message, and subsequent output appears only on the new card.

- [ ] **Step 4: Close the TODO only from durable evidence**

  Update `TODO.md` and the ledger with exact acceptance evidence. Leave the item open if either origin, restart recovery, or no-replay proof is missing.

- [ ] **Step 5: Commit**

  ```bash
  git add TODO.md
  git commit -m "docs: record human message segment acceptance"
  ```
