# Answer Card Markdown Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan task-by-task with tests written before implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Markdown and code in every Answer Card page as bounded, CardKit-compatible Markdown without changing canonical answer offsets or durable delivery behavior.

**Architecture:** Add a pure source-aware Markdown page renderer beside the existing conservative normalizer, then delegate the Answer stream facade to it. The renderer maps transformed output back to canonical source consumption, so `answer_pages.source_start` remains stable while tables, links, HTML, and code-fence repairs affect only CardKit content.

**Tech Stack:** TypeScript ESM, Vitest, Lark CardKit Markdown, existing Answer page planner and SQLite-backed recovery workflow.

**Spec:** `docs/superpowers/specs/2026-08-26-answer-card-markdown-rendering-design.md`

## Global Constraints

- Keep `ANSWER_STREAM_PAGE_LIMIT` at exactly 9,000 UTF-16 code units.
- Keep `pageStart` and `nextPageStart` as offsets into the canonical persisted answer.
- Keep one stable CardKit Markdown element per Answer page.
- Do not change SQLite schema, Answer page lifecycle, outbox ordering, prompt dispatch, or no-replay behavior.
- Render-only normalization must not mutate `RunCardView.answer`, `answerSegments`, or `answerDraft`.
- Preserve established TypeScript style and local ESM `.js` import specifiers.

---

### Task 1: Source-aware Markdown page renderer

**Files:**
- Modify: `src/runtime/lark-markdown.ts`
- Test: `tests/lark-markdown.test.ts`

**Interfaces:**
- Consumes: canonical Markdown `source`, canonical `pageStart`, and rendered `limit`.
- Produces: `renderLarkMarkdownPage(source: string, pageStart: number, limit: number): { page: string; nextPageStart: number | null }`.

- [x] **Step 1: Write failing compatibility and source-offset tests**

Add tests that call `renderLarkMarkdownPage` and assert: supported Markdown remains structured; tables become `text` fences; HTML and unsafe links are sanitized; inline/fenced code literals are unchanged; normalized output stays within its limit; and returned offsets slice the original source rather than transformed output.

- [x] **Step 2: Run the focused test and confirm the missing export fails**

Run: `npx vitest run tests/lark-markdown.test.ts`

Expected: FAIL because `renderLarkMarkdownPage` is not exported.

- [x] **Step 3: Implement mapped render units and bounded selection**

Implement a pure renderer that incrementally consumes canonical lines or hard source chunks. Reuse the same fence, table, HTML, and link compatibility rules as `normalizeLarkMarkdown`. Track synthetic prefix/suffix characters separately from canonical consumption, prefer complete-line boundaries, and guarantee forward progress.

- [x] **Step 4: Run the focused Markdown tests**

Run: `npx vitest run tests/lark-markdown.test.ts`

Expected: all Markdown compatibility and page-mapping tests pass.

### Task 2: Answer stream integration and fence-safe continuation

**Files:**
- Modify: `src/runtime/answer-stream.ts`
- Modify: `tests/answer-stream.test.ts`
- Test: `tests/answer-page-plan.test.ts`

**Interfaces:**
- Consumes: `renderLarkMarkdownPage` from Task 1.
- Produces: unchanged `renderAnswerStreamPage(content, pageStart, limit)` facade and unchanged planner behavior.

- [x] **Step 1: Add failing Answer-specific tests**

Add tests proving complete Markdown, an unfinished language-tagged code block, multi-page code, table continuation, a long unbroken line, exact canonical reconstruction from source offsets, and the 9,000-character default.

- [x] **Step 2: Run the Answer stream and planner tests before integration**

Run: `npx vitest run tests/answer-stream.test.ts tests/answer-page-plan.test.ts`

Expected: new normalization assertions fail against the current fence-only renderer.

- [x] **Step 3: Delegate the Answer facade to the source-aware renderer**

Replace the local fence parser in `answer-stream.ts` with the Task 1 renderer while preserving the exported page limit and return contract. Keep `splitAnswerStreamPage` unchanged for compatibility.

- [x] **Step 4: Run focused stream and planner tests**

Run: `npx vitest run tests/lark-markdown.test.ts tests/answer-stream.test.ts tests/answer-page-plan.test.ts`

Expected: all focused tests pass, including existing page planner behavior.

### Task 3: Delivery and recovery regression coverage

**Files:**
- Modify only if coverage is absent: `tests/event-card-integration.test.ts`
- Modify only if coverage is absent: `tests/answer-page-recovery.integration.test.ts`

**Interfaces:**
- Consumes: unchanged Answer page workflow and outbox interfaces.
- Produces: evidence that initial creation, stream updates, continuation, and restart recovery all render through the same source-aware function.

- [x] **Step 1: Inspect existing exact-payload assertions**

Confirm whether existing tests compare created/updated CardKit content with `renderAnswerStreamPage`. Add only the missing assertion for transformed Markdown and canonical `sourceStart`.

- [x] **Step 2: Run delivery and recovery tests**

Run: `npx vitest run tests/event-card-integration.test.ts tests/answer-page-recovery.integration.test.ts`

Expected: initial and continued payloads match the pure renderer, and recovery preserves page identity and canonical offsets.

### Task 4: Documentation and completion verification

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/plans/2026-08-26-answer-card-markdown-rendering.md`

**Interfaces:**
- Consumes: verified renderer behavior.
- Produces: current architecture documentation and checked execution record.

- [x] **Step 1: Document the rendering boundary**

Update the Answer streaming section to state that all pages use conservative, source-aware Markdown normalization and that synthetic display characters do not change durable source offsets.

- [x] **Step 2: Run the complete verification matrix**

Run in order after the final code change:

```bash
npx vitest run tests/lark-markdown.test.ts tests/answer-stream.test.ts tests/answer-page-plan.test.ts tests/event-card-integration.test.ts tests/answer-page-recovery.integration.test.ts
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits zero; Vitest reports no failed tests; TypeScript and the production build complete successfully; Git reports no whitespace errors.

- [x] **Step 3: Audit the acceptance criteria and commit**

Map every design acceptance criterion to a test, implementation site, or fresh command result. Then stage the implementation, tests, architecture update, and completed plan and create one focused commit.
