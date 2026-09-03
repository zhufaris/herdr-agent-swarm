# Card Freshness and Wait Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver small Answer updates within a bounded interval, render Main Card activity from durable business-event time, and suppress successful internal wait polling rows.

**Architecture:** Keep transcript presentation policy in `tool-activity-projector`, make the existing per-prompt scheduler the sole Answer coalescing boundary, and place the Main Card presentation timestamp inside `TopicViewState`. Preserve SQLite outbox reservation, CardKit stream sequencing, frozen-page behavior, and prompt replay safety.

**Tech Stack:** TypeScript ESM, Node.js 22.5+, Vitest, SQLite, Lark CardKit.

**Spec:** `docs/superpowers/specs/2026-08-27-card-freshness-and-wait-projection-design.md`

## Global Constraints

- Successful wait/poll results emit no Answer activity row.
- Failed waits retain one bounded and redacted semantic fallback when no command correlation exists.
- Every visible Answer change becomes deliverable after at most one coalescing interval; terminal states remain immediate.
- Main Card time comes from the latest visible business event and survives restart.
- Do not rewrite canonical answer offsets or frozen Answer pages.
- Preserve transactional sequence allocation, outbox idempotency, and no-prompt-replay guarantees.
- Preserve unrelated uncommitted changes; stage overlapping files interactively or by exact patch.

## File structure

- `src/runtime/tool-activity-projector.ts`: classifies internal waits and decides whether their terminal result is visible.
- `src/runtime/traex-transcript.ts`: consumes nullable projected rows without emitting empty separators; this file already contains unrelated uncommitted discovery-cache work.
- `src/events/conversation-view-projector.ts`: schedules every changed Answer view with bounded coalescing.
- `src/domain/topic-view.ts`: owns the durable Main Card presentation timestamp.
- `src/cards/run-card.ts`: renders Main Card time from the view-owned timestamp.
- `src/coordinator/main-card-workflow.ts`: removes Binding time as presentation input.
- Main-card call sites in provisioning, reconciliation, administration, and prompt workflows: render from the view contract consistently.
- Focused tests lock each behavior at the closest production seam.

---

### Task 1: Suppress successful internal wait activity

**Files:**
- Modify: `src/runtime/tool-activity-projector.ts`
- Modify: `src/runtime/traex-transcript.ts`
- Test: `tests/tool-activity-projector.test.ts`
- Test: `tests/traex-transcript.test.ts`

**Interfaces:**
- Consumes: `ToolActivityDescriptor.category` and normalized function-call output.
- Produces: `projectToolResult(descriptor, output): string`, where an empty string means no user-visible activity.

- [ ] **Step 1: Write failing projector tests**

Add exact assertions:

```ts
it.each([
  ["write_stdin", { session_id: 263 }],
  ["wait", { cell_id: "296" }]
])("suppresses successful internal wait results for %s", (name, args) => {
  const { descriptor } = projectToolCall(name, JSON.stringify(args));
  expect(projectToolResult(descriptor, JSON.stringify({ exit_code: 0 }))).toBe("");
});

it("renders one semantic redacted fallback for a failed wait", () => {
  const { descriptor } = projectToolCall("write_stdin", JSON.stringify({ session_id: 263 }));
  const result = projectToolResult(descriptor, "Process exited with code 1\nTOKEN=secret\nconnection closed");
  expect(result).toContain("✗ 等待后台任务完成 · exit 1");
  expect(result).not.toMatch(/write_stdin|session 263|secret/);
});
```

Change the transcript test that currently expects running and successful Wait rows so repeated successful results both resolve to `""`.

- [ ] **Step 2: Run tests and confirm the exact failure**

Run: `npx vitest run tests/tool-activity-projector.test.ts tests/traex-transcript.test.ts`

Expected: FAIL because successful waits currently render `✓ Wait ...`, running waits render `… Wait ...`, and failures expose the low-level target.

- [ ] **Step 3: Implement the minimal projection policy**

In `projectToolResult`, handle `descriptor.category === "Wait"` before generic rendering:

```ts
if (descriptor.category === "Wait") {
  if (status.kind !== "failed") return "";
  const heading = `✗ 等待后台任务完成 · ${status.summary}`;
  return renderFailure(heading, normalized);
}
```

Extract the existing bounded failure-fence construction into a private helper so Command and Wait failures share the same 20-line, 4,000-character redaction rules. Keep `renderItem` dropping empty projected strings.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/tool-activity-projector.test.ts tests/traex-transcript.test.ts`

Expected: PASS, including repeated `write_stdin` suppression and failed-wait redaction.

- [ ] **Step 5: Commit only Task 1 hunks**

```bash
git add src/runtime/tool-activity-projector.ts tests/tool-activity-projector.test.ts
git add -p src/runtime/traex-transcript.ts tests/traex-transcript.test.ts
git diff --cached --check
git commit -m "fix: hide internal wait polling activity"
```

### Task 2: Guarantee bounded Answer update latency

**Files:**
- Modify: `src/events/conversation-view-projector.ts`
- Test: `tests/event-card-integration.test.ts`
- Test: `tests/card-update-scheduler.test.ts` only if scheduler behavior itself needs adjustment

**Interfaces:**
- Consumes: `CardUpdateScheduler.schedule(promptId, viewVersion, immediate)`.
- Produces: one coalesced convergence after `ANSWER_STREAM_INTERVAL_MS` for every non-terminal visible RunCard change.

- [ ] **Step 1: Write a failing small-delta integration test**

Use fake timers, create and checkpoint an Answer streaming card, publish one `TurnOutputObserved` whose rendered delta is below 400 characters, then assert:

```ts
await vi.advanceTimersByTimeAsync(1_499);
expect(store.listPendingOutboundReplies()).toHaveLength(0);
await vi.advanceTimersByTimeAsync(1);
expect(store.listPendingOutboundReplies()).toEqual([
  expect.objectContaining({ kind: "stream_content", promptId: "p1" })
]);
```

Also publish several small deltas inside the same interval and assert the single reserved payload contains the newest accumulated content.

- [ ] **Step 2: Run the exact regression test and confirm red**

Run: `npx vitest run tests/event-card-integration.test.ts -t "delivers a small Answer delta within one coalescing interval"`

Expected: FAIL if the current threshold path can leave a small update without a timer or reserves stale content.

- [ ] **Step 3: Make scheduling unconditional for changed non-terminal output**

Replace threshold-based eligibility with bounded coalescing:

```ts
const terminal = ["blocked", "completed", "failed"].includes(next.phase);
this.scheduler.schedule(promptId, next.viewVersion, terminal);
```

Remove `ANSWER_STREAM_MIN_DELTA_CHARS` and `answerContentLengths` if the failing test proves they no longer serve another invariant. Retain immediate terminal flushing and scheduler in-flight follow-up behavior.

- [ ] **Step 4: Verify focused Answer behavior**

Run: `npx vitest run tests/card-update-scheduler.test.ts tests/event-card-integration.test.ts tests/answer-page-workflow.test.ts`

Expected: PASS; small deltas reserve after 1,500 ms, bursts coalesce, terminal updates remain immediate, and pagination tests stay green.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/events/conversation-view-projector.ts tests/event-card-integration.test.ts tests/card-update-scheduler.test.ts
git diff --cached --check
git commit -m "fix: bound answer card update latency"
```

### Task 3: Make Main Card event time durable and authoritative

**Files:**
- Modify: `src/domain/topic-view.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `src/coordinator/main-card-workflow.ts`
- Modify: `src/coordinator/binding-provisioning-workflow.ts`
- Modify: `src/coordinator/session-administration-workflow.ts`
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `src/coordinator/herdr-runtime-reconciler.ts`
- Test: `tests/topic-view.test.ts`
- Test: `tests/run-card.test.ts`
- Test: `tests/event-card-integration.test.ts`
- Test: nearest focused reconciler/startup test if compatibility needs direct coverage

**Interfaces:**
- Produces: `TopicViewState.activityAt: string | null`.
- Consumes: `renderProjectEntryCard(view)`; no Binding timestamp option is used for Main Card presentation.

- [ ] **Step 1: Write failing reducer and renderer tests**

Add assertions that a visible event adopts `occurredAt`, while a duplicate keeps object identity and time:

```ts
const started = reduceTopicView(initialTopicView("b1"), {
  ...event("TurnStarted", { promptId: "p1", queueDepth: 1 }),
  occurredAt: "2026-08-27T12:00:00Z"
});
expect(started.activityAt).toBe("2026-08-27T12:00:00Z");
const duplicate = reduceTopicView(started, {
  ...event("TurnStarted", { promptId: "p1", queueDepth: 1 }),
  eventId: "duplicate", occurredAt: "2026-08-27T12:05:00Z"
});
expect(duplicate).toBe(started);
```

Freeze system time and assert `renderProjectEntryCard({ ...view, activityAt: ... })` shows the correct relative time without passing Binding metadata. Add an integration assertion that the outbox payload produced for a later visible event uses that event time even when `binding.lastActivityAt` is older.

- [ ] **Step 2: Run tests and confirm red**

Run: `npx vitest run tests/topic-view.test.ts tests/run-card.test.ts tests/event-card-integration.test.ts -t "activity|latest visible event"`

Expected: FAIL because `TopicViewState` lacks `activityAt` and rendering currently reads `binding.lastActivityAt`.

- [ ] **Step 3: Add the durable presentation timestamp**

Extend the state and reducer:

```ts
export interface TopicViewState {
  // existing fields
  activityAt: string | null;
}

export function initialTopicView(bindingId: string): TopicViewState {
  return { /* existing fields */, activityAt: null };
}

export function reduceTopicView(state: TopicViewState, event: BridgeEvent): TopicViewState {
  const candidate = reduceTopicViewSnapshot(state, event);
  const next = updateTopicView(state, candidate);
  return next === state ? state : { ...next, activityAt: event.occurredAt };
}
```

Ensure `sameTopicPresentation` includes `activityAt` only through the reducer's visible-change decision: compare business presentation first, then stamp the accepted changed view. This prevents a duplicate event from becoming visible solely because its timestamp differs. When loading old JSON, `initialTopicView` supplies `null`.

- [ ] **Step 4: Remove stale Binding time from every Main Card renderer**

Change `topicStateLine` to use `input.activityAt`, remove `TopicCardRenderOptions.lastActivityAt`, and convert all calls from:

```ts
renderProjectEntryCard(view, { lastActivityAt: binding.lastActivityAt })
```

to:

```ts
renderProjectEntryCard(view)
```

For transactional paths that construct a view before changing Binding state, ensure the view is reduced from the actual lifecycle event first; never substitute `new Date()` during rendering. Carefully preserve concurrent changes in `herdr-runtime-reconciler.ts`.

- [ ] **Step 5: Verify focused Main Card behavior**

Run: `npx vitest run tests/topic-view.test.ts tests/run-card.test.ts tests/event-card-integration.test.ts tests/herdr-runtime-reconciler.test.ts`

Expected: PASS; event time is stable across retries and recovery, duplicates do not advance it, and existing lifecycle rendering remains unchanged.

- [ ] **Step 6: Commit only Task 3 hunks**

```bash
git add src/domain/topic-view.ts src/cards/run-card.ts src/coordinator/main-card-workflow.ts src/coordinator/binding-provisioning-workflow.ts src/coordinator/session-administration-workflow.ts src/coordinator/prompt-run-workflow.ts tests/topic-view.test.ts tests/run-card.test.ts tests/event-card-integration.test.ts
git add -p src/coordinator/herdr-runtime-reconciler.ts
git diff --cached --check
git commit -m "fix: derive main card time from visible events"
```

### Task 4: Full verification and deployment

**Files:**
- Verify only; do not edit generated `dist/` output.

**Interfaces:**
- Consumes: all three completed behavior changes.
- Produces: a verified build and a healthy restarted bridge.

- [ ] **Step 1: Run the complete verification set**

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all Vitest files pass, TypeScript reports no errors, build identity is generated successfully, and the worktree diff has no whitespace errors.

- [ ] **Step 2: Audit scope before deployment**

```bash
git status --short
git diff --stat
git diff --cached --stat
```

Confirm unrelated transcript-cache and reliability changes remain preserved and are not accidentally included in these commits.

- [ ] **Step 3: Restart through the supported operator surface**

```bash
herdr plugin action invoke restart --plugin herdr-lark-bridge
herdr plugin action invoke status --plugin herdr-lark-bridge
```

Expected: managed service is active; `/ready` reports `ready`; Herdr and Lark connections are usable; startup recovery finishes; pending outbox is empty or actively draining without a new permanent failure.

- [ ] **Step 4: Perform a live non-destructive observation**

Send or observe one normal turn through the configured bridge and verify:

```text
- no successful Wait/write_stdin rows appear
- a short Answer update appears within the bounded interval
- Main Card relative time corresponds to the latest visible turn event
```

Do not infer success from process health alone; correlate the card payload/outbox state and the visible Lark result.
