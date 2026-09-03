# Atomic Queued Prompt Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/swarm close` cancel every queued prompt, terminalize its Run Card, and preserve the correct Answer Card delivery intent in one durable SQLite transaction.

**Architecture:** `SqliteBindingStore` owns a projection-aware batch cancellation operation modeled after pane-orphan convergence. `SessionAdministrationWorkflow` commits that operation first, wakes outbound work once, publishes individual post-commit cancellation notifications, and then performs the existing draining/archive binding transition.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, durable Lark/CardKit outbox

**Spec:** docs/superpowers/specs/2026-08-29-atomic-queued-prompt-cancellation-design.md

## Global Constraints

- SQLite is authoritative; cancellation events are post-commit notifications.
- Select queued prompts in `created_at, rowid` order and include both turn and steering work.
- Never cancel, replay, or redispatch a running or detached prompt.
- Use one supplied timestamp for prompt state, terminal Run Cards, events, and outbox updates.
- Preserve existing outbox keys, answer lanes, delivery ordering, and CardKit checkpoint ownership.
- Never rewrite a pending `stream_card_create` after `card_id_checkpoint` is set.
- Preserve existing active-turn draining and idle archive behavior.
- Reset cutover is out of scope; it retains its current dismiss-old-outbox semantics.
- Preserve unrelated dirty-worktree changes.

---

### Task 1: Specify the projection-aware cancellation contract

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: queued prompt rows, `RunCardView`, existing outbox keys and checkpoint fields.
- Produces: `cancelQueuedPromptsWithProjection(input)` returning FIFO prompt IDs and one aggregate outbox flag.

- [ ] Replace the count-only `cancelQueuedPrompts` contract with:

```ts
cancelQueuedPromptsWithProjection(input: {
  bindingId: string;
  reason: string;
  occurredAt: string;
  rootMessageId: string | null;
  renderRunCard(view: RunCardView): object;
}): { cancelledPromptIds: string[]; outboxReserved: boolean };
```

- [ ] Add a store test with one running turn plus queued ordinary and steering prompts. Assert only queued rows cancel, returned IDs follow `created_at,rowid`, and every matching Run Card reaches failed/position-zero with the supplied reason and timestamp.
- [ ] Add an uncheckpointed-create case. Assert the original `run-card:create:<promptId>:answer` row remains one pending row, keeps lane `answer:<promptId>`, and its payload/view version become terminal.
- [ ] Add a delivered-message case. Assert the store inserts exactly one `run-card:update:<promptId>:answer:<viewVersion>` intent for the existing message target.
- [ ] Add a checkpointed-pending-create case. Assert its create payload/version remain unchanged and the terminal Run Card still commits without an invalid direct card update.
- [ ] Add an existing-CardKit-target case and assert no direct message update is manufactured.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts` and confirm the new contract tests fail before implementation.

---

### Task 2: Implement the atomic cancellation projection

**Files:**
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/domain/ports.ts`
- Modify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: Task 1 contract, `reduceRunCard`, `saveRunCard`, and transaction-aware `enqueueOutboundReply`.
- Produces: one all-or-nothing cancellation transaction.

- [ ] Open one `BEGIN IMMEDIATE`, select queued prompt/card pairs for the binding in FIFO order, and return early with an empty result when none exist.
- [ ] Update selected prompt rows to cancelled/completed with the supplied reason and timestamp. Do not issue a binding-wide update that can include a concurrently claimed row outside the selected set.
- [ ] Reduce each card with `{ type: "failed", occurredAt, notice: reason }`, save it once, and render the final view once.
- [ ] For an uncheckpointed pending initial create, call the existing idempotent enqueue helper with the same create key and terminal payload so the pending row updates in place.
- [ ] For a card with `answerMessageId` and no `answerCardId`, enqueue the existing versioned `card_update`.
- [ ] For checkpointed pending create or an existing `answerCardId`, persist the terminal Run Card but reserve no direct update; existing checkpoint/Answer Page convergence remains authoritative.
- [ ] Return FIFO prompt IDs and whether at least one pending outbox row was inserted or updated; commit once. Roll back all changes on any thrown error.
- [ ] Add an injected-trigger test that fails the second outbox mutation and asserts every prompt, card, and outbox row remains at its pre-call state.
- [ ] Add repeated/empty-call tests asserting no new versions, intents, or IDs.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts`.

---

### Task 3: Move archive notifications after durable cancellation

**Files:**
- Modify: `src/coordinator/session-administration-workflow.ts`
- Modify: `tests/pane-thread-lifecycle-integration.test.ts`
- Modify: `tests/helpers/create-test-router.ts` only if fixture wiring requires it.

**Interfaces:**
- Consumes: `cancelQueuedPromptsWithProjection`, `renderRequestAnswerCard`, event bus, and outbound notifier.
- Produces: one durable cancellation batch followed by FIFO observer notifications.

- [ ] Add an integration test with multiple queued prompts and a lifecycle subscriber that reads the store during each `PromptCancelled`. Assert the prompt and Run Card are already terminal before the event is observed.
- [ ] Assert cancellation events arrive in FIFO order with one common timestamp/reason, and `outboundWork.wake()` is called once even when several cards reserve work.
- [ ] Assert a transaction failure produces no cancellation events, no wake, no binding transition, and no audit success.
- [ ] Change the workflow store pick to the new method and add the pure Answer Card renderer dependency directly, without external calls inside the transaction.
- [ ] In `archive`, capture one timestamp, execute the batch first, wake once when required, then publish one `PromptCancelled` event per returned ID before the existing binding transition.
- [ ] Preserve `BindingDraining` for a supervised active turn and `BindingArchived` for an idle binding. Preserve the existing reason strings and audit record.
- [ ] Run `npx vitest run tests/pane-thread-lifecycle-integration.test.ts tests/sqlite-store.test.ts`.

---

### Task 4: Stop rescanning the queue for terminal cancellation notifications

**Files:**
- Modify: `src/events/queue-feedback-projector.ts`
- Modify: `tests/queue-feedback-projector.test.ts`
- Modify: `tests/event-card-integration.test.ts`

**Interfaces:**
- Consumes: post-commit `PromptCancelled` events and persisted terminal Run Cards.
- Produces: observer-only cancellation events with no binding-wide queue-feedback scan.

- [ ] Add a queue-projector test publishing `PromptCancelled` and assert neither `loadQueueFeedbackInputs` nor `projectQueuedRunCards` is called.
- [ ] Remove `PromptCancelled` from `REFRESH_EVENTS`; keep PromptQueued, TurnStarted, TurnCompleted, and TurnFailed unchanged.
- [ ] Add or extend an event-card integration assertion that a cancellation event over an already-terminal Run Card does not increment its version again and still schedules terminal delivery convergence where applicable.
- [ ] Run `npx vitest run tests/queue-feedback-projector.test.ts tests/event-card-integration.test.ts tests/pane-thread-lifecycle-integration.test.ts`.

---

### Task 5: Focused verification and implementation commit

**Files:**
- Modify only files named in Tasks 1 through 4.

**Interfaces:**
- Consumes: completed implementation and committed design.
- Produces: one independently reviewable implementation commit.

- [ ] Run `npx vitest run tests/sqlite-store.test.ts tests/pane-thread-lifecycle-integration.test.ts tests/queue-feedback-projector.test.ts tests/event-card-integration.test.ts tests/answer-page-workflow.test.ts tests/concurrency-controls.integration.test.ts`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Review that one immediate transaction owns cancellation/card/outbox changes, checkpointed creates are immutable, events happen post-commit, and no reset-cutover path changed.
- [ ] Commit only the implementation and focused tests as `fix: atomically project queued prompt cancellation`.

---

### Task 6: Full verification and safe deployment

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: committed implementation and standalone service lifecycle.
- Produces: full-suite evidence and a matching deployed identity.

- [ ] Run `npm test` and require every test to pass.
- [ ] Run `npm run build` after the final commit and record the generated build ID.
- [ ] Run `npm run swarm:restart` without `--force`; if a running prompt blocks it, schedule one delayed retry through the same safety gate.
- [ ] Run `npm run swarm:status` after startup convergence and verify active service, `ready` readiness, matching expected/observed identity, zero new failed prompts, and no stalled outbox lanes.
- [ ] Confirm no live Lark validation message was synthesized.
