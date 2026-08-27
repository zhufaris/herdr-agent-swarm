# Completed Answer Card Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve live Answer Card continuation guidance and completed Answer Card structure without changing canonical pagination or durable delivery semantics.

**Architecture:** Add a render-only warning to mutable stream payloads only when the canonical renderer has a continuation. Expand the existing completed-card renderer into a pure semantic fenced-block classifier that preserves order and independently collapses large blocks. Reuse the existing post-`stream_finish` idempotent answer `card_update`; no store lifecycle, schema, or outbox contract changes are needed.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, SQLite durable outbox, Lark CardKit 2.0.

**Spec:** `docs/superpowers/specs/2026-08-27-answer-card-complete-rendering-design.md`

## Global Constraints

- The canonical Answer page limit remains 9,000 characters; `source_start`, stream sequences, finish order, and continuation creation must not change.
- The live warning is visual-only and appears only for a page that has canonical continuation content.
- Final panels appear only after `stream_finish` has made the page `finished`; frozen and failed pages remain excluded.
- Fold only complete fences over 80 lines or 6,000 code characters; preserve every original code character and fence language.
- Retain one idempotent answer `card_update` to the existing Answer message; add no schema, action, callback, prompt replay, or remote control.

---

### Task 1: Render-only live continuation warning

**Files:**
- Modify: `src/runtime/answer-stream.ts`
- Test: `tests/answer-stream.test.ts`

**Interfaces:**
- Consumes: `renderLarkMarkdownPage(source, pageStart, ANSWER_STREAM_PAGE_LIMIT)`.
- Produces: existing `renderAnswerStreamPage(source, pageStart)` output with an unchanged canonical `nextPageStart` and a page suffix only when a next page exists.

- [ ] **Step 1: Write failing tests for the visual warning and canonical boundary.**

  Add one test using source just over `ANSWER_STREAM_PAGE_LIMIT` and assert the returned page contains `… 本页接近显示上限` while `nextPageStart` equals the page boundary from `renderLarkMarkdownPage`. Add a short-source test asserting no warning.

- [ ] **Step 2: Run the focused test before implementation.**

  Run: `npx vitest run tests/answer-stream.test.ts -t 'continuation warning'`

  Expected: fail because the returned rendered page currently contains no warning.

- [ ] **Step 3: Add a bounded display-only suffix.**

  In `renderAnswerStreamPage`, use the existing rendered result. When `nextPageStart !== null`, append a constant warning after the rendered page while preserving the returned `nextPageStart` exactly. Reserve enough visual room by rendering with `ANSWER_STREAM_PAGE_LIMIT - warning.length` for a continuable page; do not modify source, page planner inputs, or calculated offset.

- [ ] **Step 4: Verify the focused stream tests.**

  Run: `npx vitest run tests/answer-stream.test.ts`

  Expected: all Answer-stream pagination tests pass with the original 9,000-character bound.

### Task 2: Semantic completed-block rendering

**Files:**
- Modify: `src/cards/run-card.ts`
- Test: `tests/run-card.test.ts`

**Interfaces:**
- Consumes: `renderFinalAnswerCard(view, { pageNumber, initialContent })`.
- Produces: the same completed CardKit card shape with ordered `markdown` and `collapsible_panel` elements; panel headers are `plain_text` values containing semantic type, line count, and character count.

- [ ] **Step 1: Write failing renderer tests.**

  Add tests that pass complete `bash`, `text`, `diff`, `json`, and `ts` fences over the threshold. Assert each produces an initially collapsed panel titled respectively `命令`, `执行输出`, `变更 Diff`, `配置 / JSON`, and `TypeScript 代码`, including `行` and `字符`. Add a multiple-block test proving prose order is retained and only eligible blocks collapse.

- [ ] **Step 2: Run the focused renderer tests before implementation.**

  Run: `npx vitest run tests/run-card.test.ts -t 'semantic|panel title|fold'`

  Expected: fail because current titles have only a generic code label and no character count/type distinctions.

- [ ] **Step 3: Implement deterministic fence classification.**

  Keep `splitFinalAnswerBlocks` narrow and complete-fence-only. Replace `foldedCodeTitle(language, lineCount)` with a pure classifier returning the semantic label, then render `${label} · ${lineCount} 行 · ${characterCount} 字符`. Preserve `block.source` unchanged inside panel Markdown. Leave short/malformed blocks as Markdown.

- [ ] **Step 4: Verify completed-card rendering.**

  Run: `npx vitest run tests/run-card.test.ts`

  Expected: existing streaming/folding tests and new semantic-title tests pass.

### Task 3: Final-upgrade integration and release verification

**Files:**
- Test: `tests/answer-page-workflow.test.ts`
- Test: `tests/lark-outbox-dispatcher.test.ts`
- Modify: `docs/architecture.md` only if its CardKit contract needs clarification after the implementation.

**Interfaces:**
- Consumes: existing `AnswerPageWorkflow.reserveFinalFoldedCard`, `reserveFinalAnswerCardUpdate`, and Lark `card_update` delivery.
- Produces: one idempotent final card update after stream finish, carrying the richer completed-card payload while preserving answer-page state and delivery target.

- [ ] **Step 1: Extend the final-workflow test with semantic payload assertions.**

  In the existing folded-page workflow test, use a long `text` fence and assert the reserved `card_update` payload contains a `collapsible_panel` with an `执行输出` header. Converge twice and assert exactly one final-update idempotency key.

- [ ] **Step 2: Verify the focused workflow and outbox suites.**

  Run: `npx vitest run tests/answer-page-workflow.test.ts tests/lark-outbox-dispatcher.test.ts`

  Expected: all tests pass; the failure/retry behavior continues to call only `updateCard`, never stream or create methods.

- [ ] **Step 3: Run the release gate.**

  Run: `npm run typecheck && npm run build && npm test && git diff --check`

  Expected: every command exits 0.

- [ ] **Step 4: Commit and deploy the verified slice.**

  Check that `.git` is writable. Stage only the files above plus this spec and plan. Commit with `feat: refine Answer Card completion rendering`. Restart `herdr-lark-bridge.service` only after the build succeeds, then poll `http://127.0.0.1:8787/status` until it reports the generated build ID and `readiness.status: ready`.
