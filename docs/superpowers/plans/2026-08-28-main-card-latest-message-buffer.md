# Main Card Latest-Message Buffer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the group project-entry Main Card's `最新消息` from four lines to the latest 12 lines with a 6,000-character field budget, backed by a 9,000-character TopicView rolling tail.

**Architecture:** Keep the change inside the existing non-canonical Main Card projection and pure CardKit renderer. `TopicViewState.answer` retains only the latest 9,000 characters; `renderProjectEntryCard()` selects the latest 12 meaningful lines and applies a 6,000-character middle preview. Answer pages, canonical offsets, recovery, and the separate remote-panel preview remain unchanged.

**Tech Stack:** TypeScript, Vitest, CardKit JSON rendering, SQLite-backed topic projection

**Spec:** `docs/superpowers/specs/2026-08-27-main-card-visual-hierarchy-design.md`

## Global Constraints

- The project-entry `最新消息` field is bounded at 12 meaningful lines and 6,000 rendered characters.
- `TopicViewState.answer` retains exactly the latest 9,000 characters and resets at the existing turn boundary.
- The remote-panel `最近输出` budget remains 2,000 characters.
- Answer Card content remains 9,000 characters per page with unchanged canonical source offsets and recovery behavior.
- Do not modify or commit the unrelated architecture atlas plan or generated HTML.

---

### Task 1: Expand the TopicView rolling Answer tail

**Files:**
- Modify: `src/domain/topic-view.ts`
- Test: `tests/topic-view.test.ts`

**Interfaces:**
- Consumes: Answer snapshots already passed to `keepAnswerTail(answer: string): string`.
- Produces: `TopicViewState.answer` containing at most the final 9,000 source characters.

- [ ] **Step 1: Write failing reducer tests**

Change the current rolling-window test to build more than 9,000 characters and assert both exact length and exact tail. Change the `mirrorRunCardToTopic` assertion to pass 9,100 characters and retain exactly 9,000.

```ts
expect(view.answer).toHaveLength(9_000);
expect(view.answer).toBe(fullAnswer.slice(-9_000));
expect(mirrorRunCardToTopic(initial, run).answer).toBe("x".repeat(9_000));
```

- [ ] **Step 2: Run the reducer tests and observe the old 2,500-character behavior**

Run: `npx vitest run tests/topic-view.test.ts`

Expected: FAIL because `keepAnswerTail()` still returns only 2,500 characters.

- [ ] **Step 3: Expand the projection limit**

Introduce a named constant and use it in the existing helper.

```ts
const TOPIC_ANSWER_TAIL_LIMIT = 9_000;

function keepAnswerTail(answer: string): string {
  return answer.slice(-TOPIC_ANSWER_TAIL_LIMIT);
}
```

- [ ] **Step 4: Run the reducer tests**

Run: `npx vitest run tests/topic-view.test.ts`

Expected: PASS.

### Task 2: Expand the project-entry latest-message renderer

**Files:**
- Modify: `src/cards/run-card.ts`
- Test: `tests/run-card.test.ts`

**Interfaces:**
- Consumes: the bounded `TopicViewState.answer` produced by Task 1.
- Produces: a CardKit Markdown element headed `最新消息`, containing no more than the latest 12 meaningful lines and no more than 6,000 preview characters excluding the heading.

- [ ] **Step 1: Write failing renderer tests**

Update the four-line expectation to 12 lines, and add a long 12-line answer whose selected preview exceeds 6,000 characters. Assert that the oldest excluded line is absent, all 12 eligible line labels are represented where the budget permits, the omission marker appears, and the preview body is at most 6,000 characters.

```ts
expect(latestMessage.split("\n").slice(2)).toEqual(lines.slice(-12));
expect(previewBody.length).toBeLessThanOrEqual(6_000);
expect(previewBody).toContain("已省略中间");
```

- [ ] **Step 2: Run the renderer tests and observe the old four-line behavior**

Run: `npx vitest run tests/run-card.test.ts`

Expected: FAIL because `renderProjectEntryCard()` selects four lines and applies the shared 2,000-character limit.

- [ ] **Step 3: Split the renderer constants and expand only the project-entry path**

Keep the existing remote-panel limit, add explicit project-entry limits, and use them only in `renderProjectEntryCard()`.

```ts
const MAIN_CARD_PREVIEW_LIMIT = 2_000;
const PROJECT_ENTRY_PREVIEW_LINE_LIMIT = 12;
const PROJECT_ENTRY_PREVIEW_CHARACTER_LIMIT = 6_000;

const preview = actionable
  ? null
  : latestLines(visibleAnswer, PROJECT_ENTRY_PREVIEW_LINE_LIMIT) ?? fallback;

truncateLarkMarkdownMiddle(preview, PROJECT_ENTRY_PREVIEW_CHARACTER_LIMIT);
```

- [ ] **Step 4: Run both focused test files**

Run: `npx vitest run tests/run-card.test.ts tests/topic-view.test.ts`

Expected: PASS.

### Task 3: Verify, commit, and deploy the exact build

**Files:**
- Verify only: all modified source, test, spec, and plan files

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: one verified implementation commit and a healthy restarted Herdr plugin service.

- [ ] **Step 1: Run repository verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Run: `git diff --check`

Expected: all tests pass, TypeScript succeeds, the build identity is generated, and no whitespace errors are reported.

- [ ] **Step 2: Review and commit only the feature files**

```bash
git add src/domain/topic-view.ts src/cards/run-card.ts tests/topic-view.test.ts tests/run-card.test.ts docs/superpowers/plans/2026-08-28-main-card-latest-message-buffer.md
git commit -m "feat: expand Main Card latest-message buffer"
```

- [ ] **Step 3: Restart through the supported Herdr plugin action**

Run: `herdr plugin action invoke restart --plugin herdr-lark-bridge`

Expected: the managed service restarts with the generated build identity from the committed source.

- [ ] **Step 4: Verify production readiness and build identity**

Run the plugin status action and query the configured loopback `/ready` and `/status` endpoints using the service environment. Confirm readiness, no active quarantine, and that the running commit matches the implementation commit.
