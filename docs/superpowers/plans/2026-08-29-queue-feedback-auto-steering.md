# Queue Feedback and Conservative Auto-Steering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give queued prompts immediate, durable wait feedback and automatically steer only high-confidence continuation messages into a recent supervised turn.

**Architecture:** A pure classifier marks possible continuations, while one SQLite transaction chooses automatic steering or ordinary FIFO using the current binding generation and parent prompt facts. A separate queue-feedback projector derives coarse timing from persisted Run Cards, writes only changed presentation state, and relies on the existing versioned Lark outbox for delivery.

**Tech Stack:** TypeScript, Node.js ESM, SQLite through `better-sqlite3`, Vitest, Lark CardKit

**Spec:** `docs/superpowers/specs/2026-08-28-queue-feedback-auto-steering-design.md`

## Global Constraints

- Preserve at most one ordinary turn at a time per binding.
- Persist prompt, Run Card, and initial Lark delivery intent before any workflow wake-up.
- Never automatically replay steering text after delivery may have started.
- Do not use a model, fuzzy matching, or configuration to classify continuations.
- Only messages of at most 100 normalized characters may be automatic-steering candidates.
- Only a supervised `working` or `blocked` turn with durable activity in the previous five minutes may receive automatic steering.
- Slash commands, fenced code, unsupported rich content, attachments, and ambiguous requests remain outside automatic steering.
- Use at most ten valid same-binding ordinary-turn samples and require at least three before showing an ETA.
- Refresh queued elapsed-time presentation only when a 30-second display bucket changes.
- Keep `parent_prompt_id` exclusively as the execution parent for steering.
- Use existing ESM `.js` import specifiers and the repository's compact two-space TypeScript style.
- Preserve all unrelated dirty-worktree changes; stage only files owned by the current task.

---

### Task 1: Pure Continuation Classifier

**Files:**
- Create: `src/domain/continuation-classifier.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/adapters/lark-adapter.ts`
- Create: `tests/continuation-classifier.test.ts`
- Modify: `tests/lark-adapter.test.ts`

**Interfaces:**
- Consumes: normalized message text and an explicit `hasUnsupportedContent` bit produced by the Lark adapter.
- Produces: `classifyContinuation(input: ContinuationInput): ContinuationClassification`.

- [ ] **Step 1: Write the failing classifier matrix**

Create table-driven tests that establish the complete code-owned vocabulary and every hard rejection boundary:

```ts
import { describe, expect, it } from "vitest";
import { classifyContinuation } from "../src/domain/continuation-classifier.js";

describe("continuation classifier", () => {
  it.each(["继续", "继续处理", "按这个做", "可以", "确认", "补充：补一条测试", "另外注意: 不要改 API", "再看下日志", "顺便检查类型"])
    ("accepts the conservative phrase %s", (text) => {
      expect(classifyContinuation({ text, hasUnsupportedContent: false })).toEqual({ eligible: true });
    });

  it.each([
    ["/instances", false, "slash_command"],
    ["```ts\nconst x = 1;\n```", false, "code_fence"],
    ["修复另一个登录问题", false, "not_allowlisted"],
    ["继续", true, "unsupported_content"],
    ["继续".repeat(51), false, "too_long"]
  ])("rejects unsafe candidate %s", (text, hasUnsupportedContent, reason) => {
    expect(classifyContinuation({ text, hasUnsupportedContent })).toEqual({ eligible: false, reason });
  });
});
```

- [ ] **Step 2: Run the classifier test and observe the missing module failure**

Run: `npx vitest run tests/continuation-classifier.test.ts`

Expected: FAIL because `src/domain/continuation-classifier.ts` does not exist.

- [ ] **Step 3: Implement the pure classifier**

Define exact result types and keep all text decisions in this file:

```ts
export interface ContinuationInput { text: string; hasUnsupportedContent: boolean }
export type ContinuationRejection = "empty" | "too_long" | "slash_command" | "code_fence" | "unsupported_content" | "not_allowlisted";
export type ContinuationClassification = { eligible: true } | { eligible: false; reason: ContinuationRejection };

const EXACT = new Set(["继续", "继续处理", "按这个做", "可以", "确认"]);
const PREFIXES = ["补充：", "补充:", "另外注意：", "另外注意:", "再看下", "顺便检查"];

export function classifyContinuation(input: ContinuationInput): ContinuationClassification {
  const text = input.text.trim();
  if (!text) return { eligible: false, reason: "empty" };
  if (text.length > 100) return { eligible: false, reason: "too_long" };
  if (text.startsWith("/")) return { eligible: false, reason: "slash_command" };
  if (text.includes("```")) return { eligible: false, reason: "code_fence" };
  if (input.hasUnsupportedContent) return { eligible: false, reason: "unsupported_content" };
  return EXACT.has(text) || PREFIXES.some((prefix) => text.startsWith(prefix))
    ? { eligible: true }
    : { eligible: false, reason: "not_allowlisted" };
}
```

- [ ] **Step 4: Preserve unsafe rich-content metadata at the adapter boundary**

Add optional `hasUnsupportedContent?: boolean` to `IncomingLarkMessage`, treating absence as `false` so existing synthetic messages remain compatible. Text messages set it to `false`. Post normalization must return both the visible text and whether any node was discarded; image, media, file, code-block, and unknown post nodes set it to `true` even when an allowlisted phrase remains visible. Keep rejecting wholly unsupported message types as today. Add adapter tests for a plain `继续` post (`false`) and a post containing `继续` plus an image/unknown node (`true`).

- [ ] **Step 5: Run the focused tests and typecheck**

Run: `npx vitest run tests/continuation-classifier.test.ts tests/lark-adapter.test.ts && npm run typecheck`

Expected: classifier and boundary-normalization matrices pass and TypeScript exits 0.

- [ ] **Step 6: Commit the classifier and boundary signal**

```bash
git add src/domain/continuation-classifier.ts tests/continuation-classifier.test.ts src/domain/types.ts
git add -p src/adapters/lark-adapter.ts tests/lark-adapter.test.ts
git diff --cached --check
git commit -m "feat: classify safe continuation messages"
```

Both adapter files may already contain unrelated local work. Stage only the `hasUnsupportedContent` and matching test hunks; leave all other hunks unstaged.

---

### Task 2: Atomic Automatic-Steering Acceptance

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/domain/run-card-view.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: a candidate parent snapshot from `PromptRunWorkflow.activeTurn()`, binding generation, and a five-minute cutoff.
- Produces: `acceptClassifiedPrompt(input): ClassifiedPromptAcceptance`, including the final persisted `dispatchKind`.

- [ ] **Step 1: Extend the durable prompt vocabulary in failing tests**

Add this exact type and these exact fields to the existing prompt model:

```ts
export type SteeringOrigin = "explicit" | "automatic" | "converted";

// New PromptJob fields:
steeringOrigin: SteeringOrigin | null;
sourcePromptId: string | null;
wasDetached: boolean;
```

Test migration of an existing database, round-trip mapping, and a unique partial index preventing two ordinary prompts from being created from the same failed steering source. Name the index `prompt_jobs_source_prompt_once`.

- [ ] **Step 2: Write failing atomic-routing tests**

Exercise a new store method with this exact contract:

```ts
interface ClassifiedPromptInput {
  prompt: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId" | "steeringOrigin" | "sourcePromptId" | "wasDetached">;
  ordinaryView: RunCardView;
  steeringView: RunCardView;
  rootMessageId: string;
  expectedBindingGeneration: number;
  candidateParentPromptId: string | null;
  activeAfter: string;
  acceptedAt: string;
  answerCardFor(view: RunCardView): object;
}

type ClassifiedPromptAcceptance = {
  prompt: PromptJob;
  view: RunCardView;
  inserted: boolean;
  decision: "automatic_steering" | "ordinary";
  fallbackReason: "no_candidate" | "binding_changed" | "parent_inactive" | "parent_detached" | "parent_state" | "parent_stale" | null;
};
```

Required cases:

- running attached parent, matching generation, eligible runtime state, and `run_cards.activity_at >= activeAfter` selects steering;
- parent ends before `BEGIN IMMEDIATE` validation selects ordinary exactly once;
- detached observation or a durable state outside `working`/`blocked` selects ordinary;
- stale parent activity selects ordinary;
- changed binding generation selects ordinary;
- duplicate `lark_message_id` returns the original decision without creating a second prompt or outbox row; and
- ordinary `queuePosition` is calculated inside the same transaction from earlier queued ordinary turns.

- [ ] **Step 3: Run the store tests and observe missing fields and method failures**

Run: `npx vitest run tests/sqlite-store.test.ts`

Expected: FAIL on the new schema mapping and `acceptClassifiedPrompt`.

- [ ] **Step 4: Add the idempotent schema migration and mappings**

Add nullable columns to `prompt_jobs`:

```sql
ALTER TABLE prompt_jobs ADD COLUMN steering_origin TEXT
  CHECK(steering_origin IN ('explicit','automatic','converted'));
ALTER TABLE prompt_jobs ADD COLUMN source_prompt_id TEXT REFERENCES prompt_jobs(id);
ALTER TABLE prompt_jobs ADD COLUMN was_detached INTEGER NOT NULL DEFAULT 0 CHECK(was_detached IN (0,1));
CREATE UNIQUE INDEX IF NOT EXISTS prompt_jobs_source_prompt_once
  ON prompt_jobs(source_prompt_id) WHERE source_prompt_id IS NOT NULL;
```

Update `PromptRow`, `mapPrompt`, all prompt inserts, and schema rebuild migrations. Legacy rows map both provenance fields to `null` and `wasDetached` to `false`. Set `was_detached = 1` whenever recovery or runtime observation detaches a prompt, and never clear it when observation later completes. Keep `parent_prompt_id` unchanged.

Add `activity_at` to `run_cards`, initialized from `occurredAt`. Update it only for workflow activity changes (`started`, `blocked`, `output`, `completed`, and `failed`), not for CardKit delivery checkpoints, queue feedback, or delivered-version bookkeeping. This makes the five-minute fence durable without allowing presentation refreshes to keep a parent artificially fresh.

- [ ] **Step 5: Implement `acceptClassifiedPrompt` as one transaction**

Within `BEGIN IMMEDIATE`, reload the binding, parent prompt, and parent Run Card. Select automatic steering only when the binding is still at `expectedBindingGeneration`, the candidate is the binding's only running ordinary prompt, its observation is `attached`, its durable agent state is `working` or `blocked`, and its `activity_at >= activeAfter`; otherwise select ordinary. Use `acceptedAt` for every row created by this acceptance so tests and freshness comparisons share one clock. Set the final queue position before invoking `answerCardFor(finalView)`, then insert prompt, Run Card, answer page, and `stream_card_create` outbox intent before commit.

Use `steeringOrigin: "automatic"` only for the automatic path. The ordinary path stores `steeringOrigin: null`. Duplicate lookup returns the persisted row and view rather than re-evaluating the candidate.

- [ ] **Step 6: Run focused persistence tests**

Run: `npx vitest run tests/sqlite-store.test.ts`

Expected: all store tests pass, including duplicate and migration cases.

- [ ] **Step 7: Commit the atomic acceptance protocol**

```bash
git add src/domain/types.ts src/domain/ports.ts src/domain/run-card-view.ts src/store/sqlite-store.ts tests/sqlite-store.test.ts
git commit -m "feat: accept automatic steering atomically"
```

---

### Task 3: Route High-Confidence Continuations

**Files:**
- Modify: `src/coordinator/inbound-router.ts`
- Modify: `src/main.ts`
- Modify: `tests/helpers/create-test-router.ts`
- Modify: `tests/steering-integration.test.ts`

**Interfaces:**
- Consumes: `classifyContinuation`, `PromptRunWorkflow.activeTurn()`, and `acceptClassifiedPrompt`.
- Produces: durable `automatic_steering` or `ordinary` acceptance followed by exactly one scheduler wake-up.

- [ ] **Step 1: Add failing end-to-end routing cases**

Extend the steering integration harness with controlled time and an active parent. Verify:

```ts
await coordinator.handleMessage(message("m-auto", "继续"));
expect(store.getPromptByLarkMessageId("m-auto")).toMatchObject({
  dispatchKind: "steering", parentPromptId: "parent", steeringOrigin: "automatic"
});
expect(schedulerWake).toHaveBeenCalledWith({ kind: "steering-ready", bindingId: "b1", parentPromptId: "parent" });
```

Also prove `/instances`, `修复另一个问题`, unsupported rich content, a stale active parent, detached observation, `unknown` runtime state, and duplicate delivery remain ordinary or retain command semantics.

- [ ] **Step 2: Run the focused integration test and observe FIFO behavior**

Run: `npx vitest run tests/steering-integration.test.ts`

Expected: `继续` is still accepted as an ordinary turn.

- [ ] **Step 3: Add explicit runtime eligibility to router options**

Inject this narrow function rather than letting the router call Herdr directly:

```ts
automaticSteeringTarget(bindingId: string): { promptId: string; paneId: string; state: "working" | "blocked" } | null;
```

In `main.ts` and the test helper, derive it from `promptRun.activeTurn()`. Return `null` for `unknown`, `idle`, `done`, or absent turns.

- [ ] **Step 4: Route candidates through atomic acceptance**

In `enqueue`, classify only ordinary messages. Pass the candidate parent ID, expected binding generation, and `new Date(nowMs - 5 * 60_000).toISOString()` to the store. Use the returned persisted decision to publish either `SteeringQueued` or `PromptQueued`, audit `prompt.auto_steer` versus `prompt.queue`, and wake exactly one worker.

Log bounded reasons without message text:

```ts
logger.info({ event: "auto-steering-classified", bindingId, messageId: message.messageId, outcome: result.decision, reason: result.fallbackReason }, "classified continuation message");
```

Emit `auto-steering-accepted` for the automatic path and `auto-steering-fell-back-before-dispatch` for an eligible candidate that transactionally became ordinary. Include only event/message IDs, binding ID, prompt ID, parent prompt ID, and bounded reason values; never log the body or actor identity.

- [ ] **Step 5: Run routing, concurrency, and steering tests**

Run: `npx vitest run tests/steering-integration.test.ts tests/concurrency-controls.integration.test.ts tests/sqlite-store.test.ts`

Expected: automatic candidates steer, unsafe inputs stay FIFO, and single-turn concurrency tests remain green.

- [ ] **Step 6: Commit routing integration**

```bash
git add src/coordinator/inbound-router.ts src/main.ts tests/helpers/create-test-router.ts tests/steering-integration.test.ts
git commit -m "feat: route safe continuations to active turns"
```

---

### Task 4: Safe Failed-Steering Conversion

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/domain/events.ts`
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `src/coordinator/card-interaction-workflow.ts`
- Modify: `src/domain/run-card-view.ts`
- Modify: `src/events/conversation-view-projector.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `tests/card-interaction-integration.test.ts`
- Modify: `tests/steering-integration.test.ts`
- Modify: `tests/run-card.test.ts`

**Interfaces:**
- Consumes: failed automatic steering with a known `failureKind`.
- Produces: an idempotent user-triggered ordinary prompt whose `sourcePromptId` references the failed steering prompt.

- [ ] **Step 1: Define and test rejected versus uncertain failures**

Extend `SteeringFailed` with:

```ts
{ promptId: string; parentPromptId: string; error: string; failureKind: "rejected" | "uncertain"; automatic: boolean }
```

Tests must show that `not_working` emits `rejected`, thrown adapter errors emit `uncertain`, and neither path automatically creates an ordinary prompt.

Persist `steeringFailureKind: "rejected" | "uncertain" | null` in the Run Card view when reducing this event. Persist `steeringOrigin` in the Run Card alongside the prompt so rendering and restart convergence do not infer provenance from notice text. Explicit `/swarm steer` uses `explicit`, queued-card conversion uses `converted`, automatic routing uses `automatic`, and ordinary turns use `null`.

Log `auto-steering-delivery-failed` only for automatic steering, with `failureKind`, binding ID, prompt ID, and parent prompt ID. Keep the existing explicit-steering log events unchanged.

- [ ] **Step 2: Add the conversion action to failing card tests**

Add `enqueue_failed_steering` to `CardInteractionActionKind`. Render `作为新任务排队` only when all are true: phase is failed, steering origin is automatic, and failure kind is rejected. Do not render it for uncertain delivery.

The callback carries only fenced identifiers:

```ts
{ action: "enqueue_failed_steering", bindingId, bindingGeneration, sourcePromptId }
```

- [ ] **Step 3: Add the atomic conversion store operation**

Define:

```ts
convertFailedSteeringToTurn(input: {
  interactionId: string; actorOpenId: string; bindingId: string; bindingGeneration: number;
  sourcePromptId: string; newPromptId: string; newLarkMessageId: string; now: string;
  view: RunCardView; rootMessageId: string; answerCardFor(view: RunCardView): object;
}): { outcome: "converted" | "duplicate" | "missing" | "unauthorized" | "stale"; prompt: PromptJob | null };
```

Inside one transaction require the source prompt to be failed, automatic, and rejected by checking durable prompt and Run Card fields; copy its body into a new ordinary prompt; set `source_prompt_id` while leaving the new prompt's `steering_origin` null; calculate queue position; create Run Card and outbox intent; and consume the interaction. The unique partial index makes retries idempotent.

- [ ] **Step 4: Wire the card action and lifecycle copy**

`CardInteractionWorkflow` creates an actor-scoped interaction, invokes the store conversion, wakes `{ kind: "prompt-ready" }` only after commit, and returns `已作为新任务排队`. Update automatic steering completion copy to `已自动加入当前执行`; retain `已加入当前执行` for explicit steering.

- [ ] **Step 5: Run failure, card, and recovery tests**

Run: `npx vitest run tests/steering-integration.test.ts tests/card-interaction-integration.test.ts tests/run-card.test.ts tests/sqlite-store.test.ts`

Expected: safe rejected steering exposes one idempotent conversion; uncertain steering never exposes automatic replay.

- [ ] **Step 6: Commit safe conversion behavior**

```bash
git add src/domain/types.ts src/domain/ports.ts src/domain/events.ts src/coordinator/prompt-run-workflow.ts src/coordinator/card-interaction-workflow.ts src/domain/run-card-view.ts src/events/conversation-view-projector.ts src/cards/run-card.ts src/store/sqlite-store.ts tests/card-interaction-integration.test.ts tests/steering-integration.test.ts tests/run-card.test.ts
git commit -m "feat: convert rejected auto steering safely"
```

---

### Task 5: Queue Wait Estimator and Card Presentation

**Files:**
- Create: `src/domain/queue-wait-estimate.ts`
- Create: `tests/queue-wait-estimate.test.ts`
- Modify: `src/domain/run-card-view.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `tests/run-card-view.test.ts`
- Modify: `tests/run-card.test.ts`
- Modify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: queue position, active start time, current time, and up to ten eligible completed durations.
- Produces: `QueueWaitFeedback` persisted in `RunCardView.queueFeedback`.

- [ ] **Step 1: Write failing estimator tests with exact arithmetic**

Define:

```ts
export interface QueueWaitFeedback {
  aheadCount: number;
  activeElapsedSeconds: number | null;
  estimateLowerSeconds: number | null;
  estimateUpperSeconds: number | null;
  sampleCount: number;
  elapsedBucket: number | null;
}

export function estimateQueueWait(input: {
  queuePosition: number; activeStartedAt: string | null; now: string; completedDurationsMs: readonly number[];
}): QueueWaitFeedback;
```

Cover no samples, fewer than three samples, odd and even medians, active elapsed subtraction, no active turn, zero remaining time, ten-sample truncation, invalid durations, and outward 30-second rounding. Queue position counts only ordinary prompts waiting in FIFO, not the active turn. For median 60 seconds, queue position 3, and active elapsed 20 seconds, the point estimate is 160 seconds: the 80–240 second range rounds outward to 60–240 seconds.

- [ ] **Step 2: Run the estimator test and observe the missing module failure**

Run: `npx vitest run tests/queue-wait-estimate.test.ts`

Expected: FAIL because the estimator does not exist.

- [ ] **Step 3: Implement the pure estimator**

Filter non-finite and non-positive samples, keep the most recent ten supplied by the store, require three, compute the median, then calculate:

```ts
const aheadCount = Math.max(0, queuePosition - 1);
const activeRemainingMs = activeStartedAt ? Math.max(0, medianMs - elapsedMs) : 0;
const queuedAheadMs = medianMs * aheadCount;
const estimateMs = activeRemainingMs + queuedAheadMs;
```

Round the lower bound down and upper bound up to 30-second units. If both collide, add one 30-second unit to the upper bound.

- [ ] **Step 4: Persist queue presentation fields and duration queries**

Add nullable `queue_feedback_json` to `run_cards`, include it in `run_cards_view`, mapping, inserts, updates, and idempotent migration. Add:

```ts
listCompletedOrdinaryTurnDurations(bindingId: string, limit: number): number[];
loadQueueFeedbackInputs(bindingId: string): { activeStartedAt: string | null; queued: RunCardView[]; durationsMs: number[] };
```

The SQL must join `prompt_jobs` and `run_cards`, require `dispatch_kind = 'turn'`, `state = 'delivered'`, `phase = 'completed'`, `observation_state = 'completed'`, `was_detached = 0`, non-null timestamps, and a positive duration; order newest first by `finished_at` and apply `min(limit, 10)`. Compute each duration from `started_at` to `finished_at`.

Update `acceptClassifiedPrompt` so the ordinary path loads these samples and the current active start inside the acceptance transaction, computes `queueFeedback` with `acceptedAt`, and renders that enriched final view into the initial `stream_card_create` payload. Test that the very first durable card intent already contains queue position, and contains elapsed/ETA when three valid samples exist; no follow-up projector tick is required for initial feedback.

- [ ] **Step 5: Add the queue-feedback reducer and card copy**

Add a `queue-feedback` change that increments `viewVersion` only when the value changes. Render queued metadata as:

```text
⏳ 已排队 · 前方 2 条
当前任务已运行 48 秒
预计等待约 1–3 分钟
```

With fewer than three samples, omit only the estimate line. With no active turn, omit the active elapsed line. Keep the existing queue conversion button.

- [ ] **Step 6: Run estimator, Run Card, and store tests**

Run: `npx vitest run tests/queue-wait-estimate.test.ts tests/run-card-view.test.ts tests/run-card.test.ts tests/sqlite-store.test.ts`

Expected: arithmetic, persistence round-trip, view idempotence, and rendered copy all pass.

- [ ] **Step 7: Commit ETA calculation and presentation**

```bash
git add src/domain/queue-wait-estimate.ts tests/queue-wait-estimate.test.ts src/domain/run-card-view.ts src/cards/run-card.ts src/store/sqlite-store.ts tests/run-card-view.test.ts tests/run-card.test.ts tests/sqlite-store.test.ts
git commit -m "feat: show durable queue wait feedback"
```

---

### Task 6: Bounded Queue Feedback Projector

**Files:**
- Create: `src/events/queue-feedback-projector.ts`
- Create: `tests/queue-feedback-projector.test.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/events/conversation-view-projector.ts`
- Modify: `src/main.ts`
- Modify: `src/runtime/shutdown.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `tests/runtime-shutdown.test.ts`
- Modify: `tests/event-card-integration.test.ts`
- Modify: `tests/health-server.test.ts`

**Interfaces:**
- Consumes: lifecycle events, durable queue snapshots, `estimateQueueWait`, and `OutboundIntentPort.enqueueRunCardUpdate`.
- Produces: changed queued Run Cards plus coalesced versioned answer-card updates.

- [ ] **Step 1: Write failing projector lifecycle tests**

Construct `QueueFeedbackProjector` with injectable clock and timers:

```ts
new QueueFeedbackProjector({
  store, outbound, outboundWork, logger, now: () => clock, intervalMs: 30_000,
  setIntervalFn: fakeSetInterval, clearIntervalFn: fakeClearInterval
});
```

Verify it refreshes immediately on `PromptQueued`, `TurnStarted`, `TurnCompleted`, `TurnFailed`, `PromptCancelled`, and `RunQueuePositionChanged`; ticks only while queued turns exist; ignores terminal cards; skips identical 30-second buckets; and clears its timer during `stop()`.

- [ ] **Step 2: Run the projector test and observe the missing class failure**

Run: `npx vitest run tests/queue-feedback-projector.test.ts`

Expected: FAIL because the projector does not exist.

- [ ] **Step 3: Implement bounded projection**

For each affected binding, serialize refreshes with a per-binding promise tail. Load one queue snapshot, calculate feedback for each queued ordinary Run Card, apply the `queue-feedback` reducer, save only changed views, and enqueue a versioned answer update only when `answerMessageId` exists. If the initial answer card is still being created, persist the new view and let normal answer-page convergence render the latest version after the delivery checkpoint.

For every changed estimate, log `queue-estimate-projected` with binding ID, prompt ID, ahead count, sample count, and rounded lower/upper seconds only. Do not log request text or actor identity.

Use one unref'd interval only while at least one queued ordinary Run Card exists. `stop()` clears it and awaits all binding tails. Do not publish workflow wake-ups.

- [ ] **Step 4: Connect lifecycle and runtime ownership**

Start the projector after the outbox dispatcher and before `InboundRouter.start()`. Subscribe it to the same lifecycle event bus, but keep it separate from `ConversationViewProjector`. Add a distinct optional `queueFeedbackProjector` dependency to `BridgeRuntimeShutdown`; stop it after the coordinator and before the existing conversation projector and publisher, and include its settlement in the write-capable components that must finish before the SQLite fence is released.

Call an initial `converge()` during startup so queued cards regain feedback after restart without touching prompt dispatch.

Extend `OperationalSummary` and `getOperationalSummary()` with aggregate-only automatic-steering counts (queued/delivered/failed and rejected/uncertain failure totals) and queued-feedback counts (queued cards with/without an estimate). Assert the `/status` shape without exposing prompt bodies or actor IDs.

- [ ] **Step 5: Verify outbox coalescing and shutdown**

Run: `npx vitest run tests/queue-feedback-projector.test.ts tests/event-card-integration.test.ts tests/runtime-shutdown.test.ts tests/health-server.test.ts`

Expected: repeated ticks produce at most the newest replaceable update, restart convergence produces no prompt wake-up, and shutdown leaves no timer or SQLite writer active.

- [ ] **Step 6: Commit the bounded projector**

```bash
git add src/events/queue-feedback-projector.ts tests/queue-feedback-projector.test.ts src/domain/ports.ts src/domain/types.ts src/events/conversation-view-projector.ts src/main.ts src/runtime/shutdown.ts src/store/sqlite-store.ts tests/runtime-shutdown.test.ts tests/event-card-integration.test.ts tests/health-server.test.ts
git commit -m "feat: refresh queued wait feedback"
```

---

### Task 7: Documentation and Full Verification

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/feishu-group-usage.md`
- Modify: `AGENTS.md` only if a durable operator or testing rule changed

**Interfaces:**
- Consumes: the implemented behavior from Tasks 1–6.
- Produces: implementation-backed operator guidance and final verification evidence.

- [ ] **Step 1: Update user and architecture documentation**

Document that allowlisted short continuations may automatically join a recent active turn, that the Answer card says when this occurs, and that all ambiguous messages remain FIFO. Explain queue-position and coarse ETA semantics, the three-sample minimum, and the user-triggered conversion after rejected automatic steering. Preserve the warning that uncertain steering is never replayed automatically.

- [ ] **Step 2: Run the focused regression suite**

Run:

```bash
npx vitest run \
  tests/continuation-classifier.test.ts \
  tests/queue-wait-estimate.test.ts \
  tests/queue-feedback-projector.test.ts \
  tests/sqlite-store.test.ts \
  tests/steering-integration.test.ts \
  tests/card-interaction-integration.test.ts \
  tests/run-card-view.test.ts \
  tests/run-card.test.ts \
  tests/event-card-integration.test.ts \
  tests/concurrency-controls.integration.test.ts \
  tests/runtime-shutdown.test.ts \
  tests/health-server.test.ts \
  tests/lark-adapter.test.ts
```

Expected: every listed test file passes.

- [ ] **Step 3: Run repository-wide verification**

Run:

```bash
npm run typecheck
npm run build
npm test
```

Expected: TypeScript exits 0, build generates `dist/build-info.json`, and the full Vitest suite passes.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/architecture.md docs/feishu-group-usage.md
git commit -m "docs: explain queue feedback and auto steering"
```

- [ ] **Step 5: Build and restart the standalone service only after all commits exist**

Run:

```bash
npm run build
npm run swarm:restart
npm run swarm:status
```

Expected: `herdr-agent-swarm.service` is active, `readiness.status` is `ready`, and expected/observed build IDs and Git commits match. Do not restart the compatibility `herdr-lark-bridge.service`.

- [ ] **Step 6: Perform a bounded live acceptance only with operator authorization**

If the operator authorizes sending test messages to a configured topic, start a deliberately observable task, then send `继续` while its turn is active. Verify the second Answer card says `已自动加入当前执行`, no ordinary queued prompt is created for that message, and the parent receives the steering exactly once. Then queue an ambiguous new task and verify its card immediately shows exact queue position and, after three valid historical samples exist, a coarse wait range. Without that authorization, stop after service readiness and record live acceptance as not run; do not synthesize external Lark traffic.

Record only prompt IDs, binding IDs, timing, disposition, and delivery status in the verification note; do not copy prompt bodies, terminal secrets, or Lark credentials.
