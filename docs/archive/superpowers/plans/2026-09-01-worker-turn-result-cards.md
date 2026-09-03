# Worker Turn Result Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Worker turn a durable Feishu task card that shows trustworthy output and supports explicit steering plus card-reply follow-ups without replaying uncertain work.

**Architecture:** Keep `instance_turns` authoritative for execution and add a separate `WorkerTurnCardView` projection, page records, and Worker-specific outbox identity. Store transitions reduce the projection and reserve delivery intent in the same SQLite transaction; a small convergence workflow renders and wakes delivery. Structured `RuntimeTurnObservation` data is fenced to the exact Worker turn before it can update output.

**Tech Stack:** TypeScript ESM, Node.js >= 22.12, SQLite through `better-sqlite3`, Vitest, Herdr runtime observations, Lark CardKit V2, durable outbox.

**Spec:** `docs/superpowers/specs/2026-09-01-worker-turn-result-cards-design.md`

## Global Constraints

- `/to <worker> <text>` always creates a new FIFO ordinary turn; `/steer` never falls back to `/to`.
- A prompt that may have reached an agent is never automatically replayed.
- SQLite is the source of truth; cards are projections and never repair execution state.
- Every execution/projection/outbox transition that must agree is one SQLite transaction.
- Worker task lanes are isolated by `worker-turn:<turnId>`; a failed card for one task cannot block another task.
- Only output owned by the exact runtime turn and current instance generation may be persisted or rendered.
- Completed result pages are immutable; long output continues on a new page.
- Keep high-risk approval and stop behavior local to Herdr.
- Do not backfill live task cards for historical `instance_turns`.
- Preserve unrelated `.worktree/`, `TODO.md`, and `docs/herdr-agent-swarm-architecture.svg`.

---

## File Structure

**Create**

- `src/domain/worker-turn-card-view.ts` — Worker card/page types and pure lifecycle reducer.
- `src/cards/worker-turn-card.ts` — CardKit V2 renderer for queued, active, terminal, and continuation views.
- `src/coordinator/worker-turn-card-workflow.ts` — render convergence, page planning, and outbox wake-up.
- `src/coordinator/worker-turn-observer.ts` — exact-turn observation ownership and sanitized output projection.
- `tests/worker-turn-card-view.test.ts` — reducer state-machine tests.
- `tests/worker-turn-card-workflow.test.ts` — card creation, updates, pages, restart convergence, and lane isolation.
- `tests/worker-turn-observer.test.ts` — transcript ownership, output, completion, and conflict tests.

**Modify**

- `src/domain/instance-turn.ts` — parent/source/runtime identity fields.
- `src/domain/agent-runtime.ts` — structured dispatch hooks and receipt identity.
- `src/domain/types.ts` — direct Feishu parent ID and Worker outbox metadata.
- `src/domain/ports.ts` — Store, checkpoint, and Worker card workflow ports.
- `src/store/sqlite-store.ts` — migration 8, atomic turn/card transitions, pages, outbox checkpoints, lookup by delivered card message.
- `src/store/outbox-lanes.ts` — `worker-turn:<turnId>` lane selection.
- `src/adapters/lark-adapter.ts` — normalize `parent_id`.
- `src/runtime/agents/traex-driver.ts` and `src/runtime/agents/terminal-agent-driver.ts` — forward structured observation hooks.
- `src/events/instance-work-scheduler.ts` — project dispatch/observation state without treating delivery as answer completion.
- `src/coordinator/instance-turn-supervisor.ts` — restart observation through exact runtime identity.
- `src/coordinator/instance-messaging-workflow.ts` — atomic ordinary/follow-up acceptance and turn-targeted steering.
- `src/coordinator/instance-interaction-workflow.ts` — `/to`, `/steer`, and direct-card-reply routing.
- `src/cards/instance-detail-card.ts` — bounded recent-turn summaries.
- `src/events/lark-outbox-dispatcher.ts` — Worker card target validation and delivery checkpoints.
- `src/events/outbound-target-validation.ts` — prevent cross-turn Worker card updates.
- `src/main.ts` — compose/start/stop Worker card and observation workflows.
- `docs/architecture.md` and `docs/feishu-group-usage.md` — durable flow and operator commands.
- Existing focused tests named in each task.

## Task 1: Durable Worker Turn and Card Projection Model

**Files:**

- Create: `src/domain/worker-turn-card-view.ts`
- Modify: `src/domain/instance-turn.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/worker-turn-card-view.test.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**

- Produces `WorkerTurnCardView`, `WorkerTurnCardPage`, `WorkerTurnCardChange`, `createQueuedWorkerTurnCard()`, and `reduceWorkerTurnCard()`.
- Produces `InstanceStore.acceptInstanceTurnWithCard(input)` and projection/page load/save methods used by later tasks.
- Extends `InstanceTurn` with `parentTurnId`, `sourceMessageId`, `runtimeTurnId`, and `runtimeTurnStartedAt`.

- [ ] **Step 1: Write failing reducer tests**

Cover queued creation, queue-position updates, running/blocked transitions, append/replace output, completed/failed/cancelled/uncertain states, and monotonic `viewVersion`. Use concrete assertions such as:

```ts
const queued = createQueuedWorkerTurnCard({
  turnId: "turn-a", instanceId: "reviewer", instanceGeneration: 2,
  workerName: "reviewer", rootMessageId: "root-1", requestText: "review",
  queuePosition: 2, occurredAt: "2026-09-01T00:00:00.000Z"
});
const running = reduceWorkerTurnCard(queued, { type: "running", occurredAt: "2026-09-01T00:00:01.000Z" });
expect(running).toMatchObject({ phase: "running", viewVersion: 2, startedAt: "2026-09-01T00:00:01.000Z" });
```

- [ ] **Step 2: Run reducer tests and verify RED**

Run: `npx vitest run tests/worker-turn-card-view.test.ts`

Expected: FAIL because the Worker card domain module does not exist.

- [ ] **Step 3: Implement the pure domain model**

Define the projection separately from `RunCardView` so it has no fake Primary binding:

```ts
export type WorkerTurnCardPhase =
  | "queued" | "preparing" | "running" | "blocked"
  | "completed" | "failed" | "cancelled" | "dispatch-uncertain";

export interface WorkerTurnCardView {
  turnId: string; instanceId: string; instanceGeneration: number; workerName: string;
  parentTurnId: string | null; rootMessageId: string; messageId: string | null;
  cardId: string | null; elementId: string; phase: WorkerTurnCardPhase;
  requestText: string; answer: string; queuePosition: number;
  startedAt: string | null; finishedAt: string | null; notice: string | null;
  resultCapture: "pending" | "captured" | "unavailable";
  pageIndex: number; pageStart: number; sequence: number;
  viewVersion: number; deliveredVersion: number; createdAt: string; updatedAt: string;
}
```

Keep reducer inputs explicit; no reducer performs I/O or reads current time.

- [ ] **Step 4: Write failing Store and migration tests**

Test migration 8 on a reopened database, including existing historical turns. Test that:

- old rows map new columns to `null`;
- no historical card projection is created;
- `parent_turn_id` is accepted only for a settled same-instance parent;
- ordinary turns reject a non-null parent;
- acceptance creates one turn, one queued projection, and one outbox row atomically;
- duplicate idempotency returns the original turn/card without adding outbox rows.

Use this public boundary:

```ts
store.acceptInstanceTurnWithCard({
  id: "turn-b", idempotencyKey: "lark:m2", actor, projectId: "p1",
  instanceId: "reviewer", instanceGeneration: 2, kind: "followup",
  text: "continue", parentTurnId: "turn-a", sourceMessageId: "m2",
  view, card: renderWorkerTurnCard(view)
});
```

- [ ] **Step 5: Run Store tests and verify RED**

Run: `npx vitest run tests/sqlite-store.test.ts tests/worker-turn-card-view.test.ts`

Expected: FAIL on missing migration columns/tables and methods.

- [ ] **Step 6: Implement migration 8 and atomic Store methods**

Migration 8 adds nullable turn provenance columns, `worker_turn_cards`,
`worker_turn_card_pages`, and nullable `worker_turn_id` on `outbound_replies`.
Use indexed uniqueness on delivered `message_id` and `(turn_id, page_index)`.
Rebuild `outbound_replies` only if SQLite cannot add the required checked/FK
column safely; preserve every existing reply, lane, checkpoint, and quarantine.

Add methods with exact responsibilities:

```ts
interface AcceptInstanceTurnWithCardInput {
  id: string; idempotencyKey: string; actor: ControlActor; projectId: string;
  instanceId: string; instanceGeneration: number; kind: InstanceTurn["kind"];
  text: string; parentTurnId: string | null; sourceMessageId: string;
  view: WorkerTurnCardView; card: object;
}
acceptInstanceTurnWithCard(input: AcceptInstanceTurnWithCardInput): { turn: InstanceTurn; view: WorkerTurnCardView; inserted: boolean };
loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
findWorkerTurnByCardMessage(messageId: string): { turn: InstanceTurn; view: WorkerTurnCardView } | null;
listWorkerTurnCardPages(turnId: string): WorkerTurnCardPage[];
applyInstanceTurnProjection(input: { turnId: string; expectedGeneration: number; change: WorkerTurnCardChange; render(view: WorkerTurnCardView): object }): WorkerTurnCardView | null;
```

`acceptInstanceTurnWithCard` validates the parent, inserts the turn/view, records
`turn.accepted`, and reserves `stream_card_create` in one `BEGIN IMMEDIATE`
transaction. Roll back everything on any error.

- [ ] **Step 7: Run tests and verify GREEN**

Run: `npx vitest run tests/worker-turn-card-view.test.ts tests/sqlite-store.test.ts`

Expected: PASS, including reopen/migration and duplicate acceptance tests.

- [ ] **Step 8: Commit**

```bash
git add src/domain/worker-turn-card-view.ts src/domain/instance-turn.ts src/domain/types.ts src/domain/ports.ts src/store/sqlite-store.ts tests/worker-turn-card-view.test.ts tests/sqlite-store.test.ts
git commit -m "feat: persist worker turn card projections"
```

## Task 2: Worker Card Rendering, Outbox Lanes, and Delivery Checkpoints

**Files:**

- Create: `src/cards/worker-turn-card.ts`
- Create: `src/coordinator/worker-turn-card-workflow.ts`
- Modify: `src/store/outbox-lanes.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/events/lark-outbox-dispatcher.ts`
- Modify: `src/events/outbound-target-validation.ts`
- Test: `tests/instance-cards.test.ts`
- Test: `tests/worker-turn-card-workflow.test.ts`
- Test: `tests/lark-outbox-dispatcher.test.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**

- Consumes `WorkerTurnCardView` and Store methods from Task 1.
- Produces `renderWorkerTurnCard(view, page?)` and `WorkerTurnCardWorkflow.converge(turnId)`.
- Extends `OutboundCheckpointSubscriber` with `onWorkerTurnCheckpoint(listener)`.

- [ ] **Step 1: Write failing rendering and lane tests**

Assert CardKit V2 JSON for every phase, safe error redaction, bounded request
summary, `View Worker`, parent turn display, stable normalized element IDs, and
the explicit unavailable-output copy. Assert all Worker create/update/stream rows
use `worker-turn:<turnId>`, while two turns have distinct lanes.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/instance-cards.test.ts tests/worker-turn-card-workflow.test.ts tests/sqlite-store.test.ts`

Expected: FAIL because renderer, workflow, and lane selection are absent.

- [ ] **Step 3: Implement renderer and target validation**

Export:

```ts
export function renderWorkerTurnCard(view: WorkerTurnCardView, page?: WorkerTurnCardPage): object;
```

Use only CardKit V2-compatible `markdown`, `column_set`, and callback-button
layouts already exercised by `instance-cards.test.ts`. The callback value for
`View Worker` carries `instanceId` and `instanceGeneration`; it does not carry
trusted execution state.

Add Worker target validators that require `outbound_replies.worker_turn_id`,
the matching projection/page, and the exact message/card/element ID before an
update, stream, or finish call.

- [ ] **Step 4: Implement Worker lane selection and delivery checkpoints**

Change `outboundLaneKey` so a row with `workerTurnId` returns
`worker-turn:<workerTurnId>` before generic Answer/reply rules. Update the SQL
equivalent used by migrations. Extend the dispatcher checkpoint path so a
delivered Worker `stream_card_create` records the main/page message and CardKit
IDs and notifies `onWorkerTurnCheckpoint(turnId, viewVersion)`.

- [ ] **Step 5: Implement card convergence and pagination**

`WorkerTurnCardWorkflow.converge(turnId)` reloads the durable view and:

- coalesces a not-yet-delivered initial create payload to the latest view;
- streams cumulative content into the active page after card checkpoint;
- freezes a full page and reserves exactly one continuation;
- emits a versioned static update for state-only changes;
- never calls an Agent driver.

Reuse `answer-page-plan.ts` calculations where their input is generic; do not
reuse `RunCardView` or invent a fake `bindingId`.

- [ ] **Step 6: Add delivery-isolation and restart tests**

Prove a permanent failure for turn A quarantines only
`worker-turn:turn-a`, turn B is still delivered, and reopening the Store retains
card/page checkpoints and monotonic versions. Spy on `AgentRuntimeDriver.submit`
and assert no card retry invokes it.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `npx vitest run tests/instance-cards.test.ts tests/worker-turn-card-workflow.test.ts tests/lark-outbox-dispatcher.test.ts tests/sqlite-store.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cards/worker-turn-card.ts src/coordinator/worker-turn-card-workflow.ts src/store/outbox-lanes.ts src/store/sqlite-store.ts src/domain/ports.ts src/events/lark-outbox-dispatcher.ts src/events/outbound-target-validation.ts tests/instance-cards.test.ts tests/worker-turn-card-workflow.test.ts tests/lark-outbox-dispatcher.test.ts tests/sqlite-store.test.ts
git commit -m "feat: deliver durable worker task cards"
```

## Task 3: Submit `/to` with an Atomic Queued Task Card

**Files:**

- Modify: `src/coordinator/instance-messaging-workflow.ts`
- Modify: `src/coordinator/instance-interaction-workflow.ts`
- Modify: `src/main.ts`
- Test: `tests/instance-messaging.integration.test.ts`
- Test: `tests/instance-routing.integration.test.ts`

**Interfaces:**

- Consumes `acceptInstanceTurnWithCard()` and `renderWorkerTurnCard()`.
- Changes `InstanceMessagingWorkflow.submit()` to accept Feishu source context and return the durable card view.

- [ ] **Step 1: Write failing `/to` integration tests**

Call `/to reviewer A`, B, and C. Assert three turns, three task-card create
intents in independent lanes, queue positions 1/2/3, and no generic
`Agent control / 已提交` acknowledgement card. Repeat message B and assert no
duplicate turn or card intent.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/instance-messaging.integration.test.ts tests/instance-routing.integration.test.ts`

Expected: FAIL because `/to` still emits a generic status card.

- [ ] **Step 3: Implement source-aware submission**

Use this input shape:

```ts
submit(input: {
  idempotencyKey: string; actor: ControlActor; projectId: string;
  targetInstanceId: string; content: { kind: "turn" | "followup"; text: string };
  source?: { messageId: string; rootMessageId: string; parentTurnId?: string | null };
}): Promise<{ accepted: true; turn: InstanceTurn; card: WorkerTurnCardView | null; inserted: boolean }>;
```

Human Feishu `/to` supplies `source`; Primary tool submissions may omit it and
retain their current headless behavior. Remove only the `/to` acknowledgement
reply; rejection cards and instance-control cards remain unchanged. Wake the
outbox after the atomic acceptance and then wake Worker scheduling.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npx vitest run tests/instance-messaging.integration.test.ts tests/instance-routing.integration.test.ts tests/primary-worker-flow.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coordinator/instance-messaging-workflow.ts src/coordinator/instance-interaction-workflow.ts src/main.ts tests/instance-messaging.integration.test.ts tests/instance-routing.integration.test.ts tests/primary-worker-flow.integration.test.ts
git commit -m "feat: create task cards for worker submissions"
```

## Task 4: Project Worker Lifecycle Without Treating Dispatch as an Answer

**Files:**

- Modify: `src/events/instance-work-scheduler.ts`
- Modify: `src/coordinator/instance-turn-supervisor.ts`
- Modify: `src/coordinator/worker-turn-card-workflow.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/instance-messaging.integration.test.ts`
- Test: `tests/instance-turn-supervisor.test.ts`
- Test: `tests/worker-turn-card-workflow.test.ts`

**Interfaces:**

- Consumes `applyInstanceTurnProjection()` and `WorkerTurnCardWorkflow.converge()`.
- Produces one transition helper that changes execution state, reduces its card view, and reserves a render in one Store transaction.

- [ ] **Step 1: Write failing lifecycle tests**

Assert `queued -> preparing -> running -> blocked` updates only the matching
task card. Assert `confirmed-delivered` without a completed structured
observation does **not** set `completed` and does not store the runtime cursor as
answer text. Assert failure and uncertain cards contain safe guidance.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/instance-messaging.integration.test.ts tests/instance-turn-supervisor.test.ts tests/worker-turn-card-workflow.test.ts`

Expected: FAIL because the scheduler currently completes on dispatch receipt.

- [ ] **Step 3: Add atomic lifecycle projection methods**

Replace bare `updateInstanceTurn` use on card-backed turns with a Store boundary:

```ts
transitionInstanceTurnWithProjection(input: {
  turnId: string; expectedGeneration: number; state: InstanceTurnState;
  result?: string | null; error?: string | null; eventKind: string;
  change: WorkerTurnCardChange; render(view: WorkerTurnCardView): object;
}): { turn: InstanceTurn; view: WorkerTurnCardView } | null;
```

Headless Primary-tool Worker turns continue through the existing transition path.
Both paths record the same durable `instance_events`.

- [ ] **Step 4: Correct scheduler and supervisor completion semantics**

The scheduler marks dispatching/running and lets the structured observer own
answer completion. A driver receipt may prove dispatch but cannot provide final
answer content. For capability `structuredEvents: false`, a settled driver call
may complete execution with `resultCapture: "unavailable"` and an empty
canonical result; the card must say output capture is unavailable.

The supervisor uses the same projection transition path for recovered
running/blocked/uncertain states. It never writes `observed:idle` into `result`.

- [ ] **Step 5: Recompute queued positions after settlement**

Add one transaction that lists current-generation queued turns in FIFO order,
updates only changed queue positions, and coalesces their pending/update renders.
Call it after completed, failed, or cancelled settlement and before waking the
next turn.

- [ ] **Step 6: Run tests and verify GREEN**

Run: `npx vitest run tests/instance-messaging.integration.test.ts tests/instance-turn-supervisor.test.ts tests/worker-turn-card-workflow.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/events/instance-work-scheduler.ts src/coordinator/instance-turn-supervisor.ts src/coordinator/worker-turn-card-workflow.ts src/store/sqlite-store.ts tests/instance-messaging.integration.test.ts tests/instance-turn-supervisor.test.ts tests/worker-turn-card-workflow.test.ts
git commit -m "feat: project worker turn lifecycle"
```

## Task 5: Capture Exact Structured Worker Output

**Files:**

- Create: `src/coordinator/worker-turn-observer.ts`
- Modify: `src/domain/agent-runtime.ts`
- Modify: `src/runtime/agents/traex-driver.ts`
- Modify: `src/runtime/agents/terminal-agent-driver.ts`
- Modify: `src/events/instance-work-scheduler.ts`
- Modify: `src/coordinator/instance-turn-supervisor.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/main.ts`
- Test: `tests/worker-turn-observer.test.ts`
- Test: `tests/instance-messaging.integration.test.ts`
- Test: `tests/instance-turn-supervisor.test.ts`

**Interfaces:**

- Consumes `RuntimeTurnObservation`, `TraexTranscriptReaderPort`, and Worker projection transitions.
- Produces `WorkerTurnObserver.observe(turnId, observation)` and `recover(turnId)`.
- Changes driver submit to `submit(runtime, text, hooks?)`.

- [ ] **Step 1: Write failing ownership and output tests**

Test this sequence: fresh turn start claims exact `turnId/startedAt`; matching
answer deltas append; matching completed lifecycle persists final sanitized
answer and completes the task; another transcript turn is ignored. Also test
missing identity, generation mismatch, restart reopen, aborted lifecycle, and
redaction of reasoning/protocol/secret content.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/worker-turn-observer.test.ts tests/instance-messaging.integration.test.ts tests/instance-turn-supervisor.test.ts`

Expected: FAIL because no Worker observer or structured dispatch hooks exist.

- [ ] **Step 3: Extend the driver hook without changing delivery safety**

```ts
export interface AgentDispatchHooks {
  onDispatched?(): void | Promise<void>;
  onObservation?(observation: RuntimeTurnObservation): void | Promise<void>;
}
submit(runtime: AgentRuntimeRef, text: string, hooks?: AgentDispatchHooks): Promise<DispatchReceipt>;
```

Forward `hooks.onObservation` and `hooks.onDispatched` to `HerdrPort.runPrompt`.
Keep the `dispatched` boolean and `delivery-uncertain` classification unchanged.
Update every fake driver call site in the same commit.

- [ ] **Step 4: Implement exact-turn ownership**

`WorkerTurnObserver.observe()` accepts output only after a `freshTurnStart` for
the expected current-generation task. Atomically persist `runtimeTurnId` and
`runtimeTurnStartedAt`; subsequent observations must match. Normalize output
through the existing safe transcript/output functions before applying a card
change. Completion uses `turnLifecycle.finalAnswer` when present and otherwise
the accumulated trusted answer. Aborted lifecycle becomes `cancelled` only when
the exact identity matches.

- [ ] **Step 5: Implement restart recovery**

For a current-generation turn with exact identity and a supported TraeX session,
call `transcriptReader.openAfterTurn(session, runtimeTurnId, startedAt)` and drain
bounded observations through the same `observe()` method. Never call
`AgentRuntimeDriver.submit`. If exact identity or reader support is absent,
retain `dispatch-uncertain` or the existing observable state.

- [ ] **Step 6: Wire scheduler, Herdr wake hints, startup, and shutdown**

The scheduler passes observations to the Worker observer. `HerdrEventRouter`
wakes both pane-state reconciliation and exact output observation for matching
Worker panes. Startup recovers after the lease/write fence and before readiness;
shutdown awaits bounded observer work and leaves uncertain durable state on
timeout.

- [ ] **Step 7: Run tests and verify GREEN**

Run: `npx vitest run tests/worker-turn-observer.test.ts tests/instance-messaging.integration.test.ts tests/instance-turn-supervisor.test.ts tests/traex-transcript.test.ts`

Expected: PASS, including explicit assertions that restart recovery made zero
driver `submit` calls.

- [ ] **Step 8: Commit**

```bash
git add src/coordinator/worker-turn-observer.ts src/domain/agent-runtime.ts src/runtime/agents/traex-driver.ts src/runtime/agents/terminal-agent-driver.ts src/events/instance-work-scheduler.ts src/coordinator/instance-turn-supervisor.ts src/store/sqlite-store.ts src/main.ts tests/worker-turn-observer.test.ts tests/instance-messaging.integration.test.ts tests/instance-turn-supervisor.test.ts tests/traex-transcript.test.ts
git commit -m "feat: capture trusted worker output"
```

## Task 6: Normalize Direct Replies and Route Contextual Steer or Follow-up

**Files:**

- Modify: `src/domain/types.ts`
- Modify: `src/adapters/lark-adapter.ts`
- Modify: `src/coordinator/instance-interaction-workflow.ts`
- Modify: `src/coordinator/instance-messaging-workflow.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/lark-adapter.test.ts`
- Test: `tests/instance-routing.integration.test.ts`
- Test: `tests/instance-messaging.integration.test.ts`

**Interfaces:**

- Produces `IncomingLarkMessage.parentMessageId: string | null`.
- Consumes `findWorkerTurnByCardMessage()` from Task 1.
- Produces turn-targeted `steer({ ..., targetTurnId })` validation.

- [ ] **Step 1: Write failing Lark normalization tests**

Build an `im.message.receive_v1` reply event with distinct `message_id`,
`parent_id`, `root_id`, and `thread_id`. Assert all four identities survive in
the normalized message and that root messages have `parentMessageId: null`.

- [ ] **Step 2: Write failing contextual routing tests**

Assert:

- reply + bot mention to the exact running task card calls `steer` with that turn;
- reply to completed/failed/cancelled card creates one follow-up with parent ID;
- reply to queued or uncertain card returns a rejection card and mutates nothing;
- an unmapped parent never guesses from topic or selected Worker;
- explicit `/to` and `/steer` take precedence over contextual inference;
- duplicate reply events create one operation or follow-up.

- [ ] **Step 3: Run tests and verify RED**

Run: `npx vitest run tests/lark-adapter.test.ts tests/instance-routing.integration.test.ts tests/instance-messaging.integration.test.ts`

Expected: FAIL because `parentMessageId` and exact card routing are absent.

- [ ] **Step 4: Normalize and persist direct parent identity**

Map `data.message.parent_id ?? null` to `parentMessageId`. Update all test message
fixtures explicitly so accidental `undefined` cannot masquerade as a reply.

- [ ] **Step 5: Implement exact contextual routing**

In `handleOrdinaryMessage`, before selected-target routing, resolve only a non-null
direct parent against delivered Worker card messages. Require bot mention and
operator authorization. Running/blocked invokes turn-targeted steer; settled
creates `kind: "followup"`; queued/uncertain rejects. Do not infer from
`rootMessageId`, topic, Worker selection, or request text.

Strengthen `InstanceMessagingWorkflow.steer` to verify `targetTurnId` is the one
unique current-generation active turn before accepting the external operation.
Record `turn.steered` only after delivery succeeds.

- [ ] **Step 6: Run tests and verify GREEN**

Run: `npx vitest run tests/lark-adapter.test.ts tests/instance-routing.integration.test.ts tests/instance-messaging.integration.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/adapters/lark-adapter.ts src/coordinator/instance-interaction-workflow.ts src/coordinator/instance-messaging-workflow.ts src/store/sqlite-store.ts tests/lark-adapter.test.ts tests/instance-routing.integration.test.ts tests/instance-messaging.integration.test.ts
git commit -m "feat: route worker card replies"
```

## Task 7: Worker Detail History and Task Navigation

**Files:**

- Modify: `src/cards/instance-detail-card.ts`
- Modify: `src/coordinator/instance-interaction-workflow.ts`
- Modify: `src/domain/ports.ts`
- Test: `tests/instance-cards.test.ts`
- Test: `tests/instance-routing.integration.test.ts`

**Interfaces:**

- Consumes Worker card summaries from the Store.
- Produces callback action `instance_turn_open` with `instanceId`, `generation`, and `turnId`.

- [ ] **Step 1: Write failing recent-turn rendering tests**

Assert the detail card lists a bounded newest-first set with short ID, state,
request/result summaries, capture status, and an open action. Assert the old
single `RECENT RESULT` field is absent and card JSON stays under 12,000 bytes for
large history.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/instance-cards.test.ts tests/instance-routing.integration.test.ts`

Expected: FAIL on the current 240-character recent-result implementation.

- [ ] **Step 3: Implement bounded summaries and safe open action**

Render at most five recent turns and summarize without changing canonical result.
On `instance_turn_open`, reload instance generation and turn ownership, then
return the durable task view as callback card content. Do not rerun, resume, or
re-observe the turn. Preserve binding-generation fences already used by instance
controls.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npx vitest run tests/instance-cards.test.ts tests/instance-routing.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cards/instance-detail-card.ts src/coordinator/instance-interaction-workflow.ts src/domain/ports.ts tests/instance-cards.test.ts tests/instance-routing.integration.test.ts
git commit -m "feat: show worker task history"
```

## Task 8: Documentation, Full Verification, and Production Readiness

**Files:**

- Modify: `docs/architecture.md`
- Modify: `docs/feishu-group-usage.md`
- Test: all affected tests and full suite

**Interfaces:**

- Documents the final behavior from Tasks 1-7; produces no new runtime API.

- [ ] **Step 1: Update operator documentation**

Document concrete examples:

```text
/to reviewer Review the SQLite transaction boundaries
/steer reviewer Focus on generation fencing
```

Explain that `/to` queues a new task, `/steer` affects only the active task, a
reply to an active task card steers it, and a reply to a settled task card creates
a follow-up. Explain `dispatch-uncertain` and why it has no automatic retry.

- [ ] **Step 2: Update architecture documentation**

Add the Worker path:

```text
Lark inbound -> atomic InstanceTurn + WorkerTurnCard projection + outbox
             -> FIFO scheduler -> exact structured observation
             -> SQLite result/page projection -> Worker-specific outbox lane
             -> Lark CardKit
```

Document direct-parent routing, exact transcript identity, page immutability,
generation fencing, and independent lane quarantine.

- [ ] **Step 3: Run focused verification**

Run:

```bash
npx vitest run tests/lark-adapter.test.ts tests/instance-cards.test.ts tests/instance-routing.integration.test.ts tests/instance-messaging.integration.test.ts tests/instance-turn-supervisor.test.ts tests/worker-turn-card-view.test.ts tests/worker-turn-card-workflow.test.ts tests/worker-turn-observer.test.ts tests/lark-outbox-dispatcher.test.ts tests/sqlite-store.test.ts tests/primary-worker-flow.integration.test.ts tests/traex-transcript.test.ts
```

Expected: all selected test files PASS.

- [ ] **Step 4: Run repository verification**

Run in order:

```bash
npm test
npm run typecheck
npm run build
npm run docs:audit
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Review no-replay evidence**

Search every `AgentRuntimeDriver.submit` call and confirm only the scheduler calls
it for a claimed never-started turn. Inspect tests proving outbox retries, startup
recovery, detail-card viewing, and contextual replies make zero replay calls.

Run: `rg -n "\.submit\(|AgentRuntimeDriver" src tests`

Expected: no publisher, card workflow, reply-view action, or recovery display path
calls the driver submission boundary.

- [ ] **Step 6: Commit documentation**

```bash
git add docs/architecture.md docs/feishu-group-usage.md
git commit -m "docs: explain worker task cards"
```

- [ ] **Step 7: Prepare deployment evidence without deploying**

Record the final commit list, `git status --short`, test totals, typecheck/build
success, and migration 8 coverage. Do not run `./install.sh` or restart the live
service until the user explicitly asks to deploy after reviewing the implementation.
