# CardKit Long-Message Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render oversized CardKit message text as a bounded head-and-tail preview with an accurate middle-omission marker, without changing any canonical durable text or answer-page behavior.

**Architecture:** Add one pure helper to the existing Lark Markdown runtime module. It normalizes and bounds only a render copy, then use it at the main-card and initial Answer-card presentation seams. Existing source-aware Answer pagination remains untouched: page source offsets, stream sequences, and durable answer content continue to use canonical source text.

**Tech Stack:** TypeScript (Node ESM), Vitest, pure CardKit render functions, existing Lark Markdown normalization and source-aware answer pagination.

**Spec:** `docs/superpowers/specs/2026-08-27-cardkit-long-message-preview-design.md`

## Global Constraints

- Main-card preview budget is exactly 2,000 characters; Answer-card initial display budget is exactly 9,000 characters.
- At or below budget, return the normalized text unchanged. Above budget, keep head and tail and insert exactly `… 已省略中间 <lineCount> 行 / <characterCount> 字符 …` as a standalone line.
- This is presentation-only: do not mutate `TopicViewState`, `RunCardView`, SQLite records, prompt text, answer segments/drafts, fingerprints, outbox idempotency keys, or view versions.
- Do not alter `renderLarkMarkdownPage`, `answer_pages.source_start`, continuation creation, frozen-page semantics, or CardKit stream sequence ordering.
- Keep existing Markdown safety transformations and final field-size limits effective.
- Do not fold unrelated reconciler-durability or bridge-owned-session worktree changes into this slice.

---

## File structure and boundaries

- `src/runtime/lark-markdown.ts` owns a deterministic `truncateLarkMarkdownMiddle()` helper beside the existing head-only and tail-only bounded render helpers.
- `src/cards/run-card.ts` selects presentation budgets and calls the helper only after native-status stripping/preview normalization has selected the user-visible copy. It remains a pure CardKit renderer.
- `tests/lark-markdown.test.ts` establishes exact helper behavior and hard limits.
- `tests/run-card.test.ts` proves renderer integration and that the source input objects remain unchanged.
- `tests/answer-stream.test.ts` is regression coverage: Answer-page canonical pagination remains independent of the display-only helper.

### Task 1: Create the deterministic head-and-tail Markdown preview helper

**Files:**

- Modify: `src/runtime/lark-markdown.ts`
- Test: `tests/lark-markdown.test.ts`

**Interfaces:**

- Consumes: `normalizeLarkMarkdown(source)` and the caller-selected `maxLength`.
- Produces:

```ts
export function truncateLarkMarkdownMiddle(source: string, maxLength: number): string;
```

- The returned marker format is exactly:

```ts
`… 已省略中间 ${omittedLineCount} 行 / ${omittedCharacterCount} 字符 …`
```

- [ ] **Step 1: Write failing unit tests for the public helper contract**

In `tests/lark-markdown.test.ts`, import `truncateLarkMarkdownMiddle` and add tests with exact assertions for: unchanged short text, exact-budget text, and an oversized newline-delimited JSON-shaped source. The long source must prove that the rendered result retains both `"first": true` and `"last": true`, contains the marker, and is within budget.

```ts
const source = [
  "{",
  "  \"first\": true,",
  ...Array.from({ length: 80 }, (_, index) => `  \"middle-${index}\": ${index},`),
  "  \"last\": true",
  "}"
].join("\n");
const result = truncateLarkMarkdownMiddle(source, 180);
expect(result).toContain('\"first\": true');
expect(result).toContain('\"last\": true');
expect(result).toMatch(/… 已省略中间 \d+ 行 \/ \d+ 字符 …/);
expect(result.length).toBeLessThanOrEqual(180);
```

- [ ] **Step 2: Run the unit test and confirm it fails**

Run: `npx vitest run tests/lark-markdown.test.ts -t "middle omission"`

Expected: FAIL because `truncateLarkMarkdownMiddle` is not exported.

- [ ] **Step 3: Implement normalized head-and-tail selection**

Add `truncateLarkMarkdownMiddle(source, maxLength)` to `src/runtime/lark-markdown.ts`. Normalize once with `normalizeLarkMarkdown(source)`. If normalized content fits, return it. Otherwise select a head and tail around the midpoint of the remaining budget, reserve marker/newline space before selecting source text, and calculate omitted character count from the normalized source span excluded by the result.

Use the retained source ranges—not a post-hoc search—to calculate omitted line count: count `\n` within the omitted span, plus one when the span contains any non-empty range. Prefer a nearby newline on the head's right and tail's left only when the resulting assembled value remains at or below `maxLength`; otherwise retain the exact hard boundary. Return `head + "\n\n" + marker + "\n\n" + tail`.

- [ ] **Step 4: Add edge-case tests before finalizing the helper**

Add tests proving: (a) CRLF text is normalized before counts/display; (b) one extremely long line still retains a non-empty head and tail and obeys the limit; (c) a small defensive budget returns a bounded prefix rather than throwing; (d) a fenced Markdown input returns no unsafe/unclosed fence.

```ts
const result = truncateLarkMarkdownMiddle("x".repeat(400), 80);
expect(result).toContain("已省略中间");
expect(result.length).toBeLessThanOrEqual(80);
expect(result.startsWith("x")).toBe(true);
expect(result.endsWith("x")).toBe(true);
```

- [ ] **Step 5: Run all Lark Markdown tests**

Run: `npx vitest run tests/lark-markdown.test.ts`

Expected: PASS. Existing head-only/tail-only truncation and source-aware page tests remain green.

- [ ] **Step 6: Commit the isolated runtime utility**

```bash
git add src/runtime/lark-markdown.ts tests/lark-markdown.test.ts
git diff --cached --check
git commit -m "feat: add bounded CardKit middle previews"
```

Do not stage the pre-existing bridge-owned session or reconciler-durability changes. If the Git index remains read-only, retain the verified patch and report the exact environment error.

### Task 2: Apply the preview copy at CardKit rendering seams

**Files:**

- Modify: `src/cards/run-card.ts`
- Test: `tests/run-card.test.ts`
- Regression test: `tests/answer-stream.test.ts`

**Interfaces:**

- Consumes: `truncateLarkMarkdownMiddle(source, maxLength)`, `normalizeLarkPreview`, `stripNativeTraexStatus`, and the pure `TopicViewState`/`RunCardView` render inputs.
- Produces: bounded CardKit Markdown `content` strings only; it does not add a CardKit action or a persistence operation.
- Required presentation policy:

```ts
const MAIN_CARD_PREVIEW_LIMIT = 2_000;
const ANSWER_CARD_PREVIEW_LIMIT = 9_000;
```

- [ ] **Step 1: Write the failing main-card renderer test**

In `tests/run-card.test.ts`, create a `TopicViewState` whose answer is a JSON-shaped value with visible `head-field`, 3,000+ characters of middle rows, and visible `tail-field`. Render both `renderRunCard()` and `renderProjectEntryCard()`. Assert their serialized CardKit objects contain both field names and `已省略中间`; assert the original `input.answer` equals its pre-render value.

```ts
const original = makeLongJsonPreview();
const input = { ...initialTopicView("b1"), phase: "done" as const, answer: original };
for (const card of [renderRunCard(input), renderProjectEntryCard(input)]) {
  expect(JSON.stringify(card)).toContain("head-field");
  expect(JSON.stringify(card)).toContain("tail-field");
  expect(JSON.stringify(card)).toContain("已省略中间");
}
expect(input.answer).toBe(original);
```

- [ ] **Step 2: Run the renderer test and confirm it fails**

Run: `npx vitest run tests/run-card.test.ts -t "middle omission.*main"`

Expected: FAIL because current main cards use only tail truncation or latest-line selection.

- [ ] **Step 3: Replace tail-only compact main-card previews with middle previews**

In `src/cards/run-card.ts`, import `truncateLarkMarkdownMiddle`. For `renderRunCard()`, replace `truncateLarkMarkdownTail(input.answer.trim(), 2_000)` with the new helper and the named 2,000 limit. For `renderProjectEntryCard()`, apply the helper after `latestLines()` chooses its compact preview; do not remove the current 20-line selection, progress fallback, or actionable-notice priority.

- [ ] **Step 4: Write the failing Answer-card test for a non-streaming initial render**

In `tests/run-card.test.ts`, use a completed `RunCardView` with a 10,000+ character JSON-shaped `answer` and no `initialContent` override. Assert `renderRequestAnswerCard()` displays head/tail fields and the omission marker, is within the 9,000 content budget, and leaves `view.answer` unchanged. Include a second case with `initialContent: "canonical page content"` to ensure it still displays that supplied page copy rather than recomputing a preview from the aggregate answer.

- [ ] **Step 5: Apply the Answer-card display-only transform without altering pages**

In `renderRequestAnswerCard()`, first choose `content` exactly as it does today: `options.initialContent ?? baseContent`. Apply `truncateLarkMarkdownMiddle(content, ANSWER_CARD_PREVIEW_LIMIT)` only when `options.initialContent === undefined`. This protects the source-aware Answer-page path, whose caller supplies canonical page text and owns `source_start`/continuation decisions.

Do not call the helper from `renderAnswerStreamPage`, answer-page workflows, reducers, SQLite store methods, or outbox code.

- [ ] **Step 6: Add pagination regression assertions and run focused renderer tests**

In `tests/answer-stream.test.ts`, retain/extend a multi-page source test so concatenating the rendered canonical pages still equals the source and page offsets advance independently of the preview helper. Then run:

```bash
npx vitest run tests/run-card.test.ts tests/answer-stream.test.ts
```

Expected: PASS. Main/Answer card previews show head-tail omission; stream pagination stays canonical and source-aware.

- [ ] **Step 7: Commit the renderer integration**

```bash
git add src/cards/run-card.ts tests/run-card.test.ts tests/answer-stream.test.ts
git diff --cached --check
git commit -m "feat: show bounded long-message previews in cards"
```

Keep unrelated changes unstaged. If the Git index remains unavailable, do not force a commit.

### Task 3: Verify scope and document the presentation boundary

**Files:**

- Modify: `docs/architecture.md: Answer streaming and pagination`
- Test: `tests/lark-markdown.test.ts`
- Test: `tests/run-card.test.ts`
- Test: `tests/answer-stream.test.ts`

**Interfaces:**

- Consumes: completed helper and renderer integration.
- Produces: a documented distinction between canonical persisted Answer text and bounded CardKit preview copies.

- [ ] **Step 1: Update the Answer streaming architecture prose**

In `docs/architecture.md` under `## Answer streaming and pagination`, add a concise paragraph saying that compact CardKit previews may retain head and tail around a deterministic omission marker, but canonical `RunCardView.answer` and `answer_pages.source_start` stay unchanged. State that this preview is not pagination and frozen/continuation page behavior remains unchanged.

- [ ] **Step 2: Run focused verification**

Run:

```bash
npx vitest run tests/lark-markdown.test.ts tests/run-card.test.ts tests/answer-stream.test.ts
npm run typecheck
npm run build
```

Expected: each command exits 0.

- [ ] **Step 3: Run the complete regression suite**

Run: `npm test`

Expected: all tests pass, including long-answer recovery and source-aware answer-page tests.

- [ ] **Step 4: Inspect scope and final diff**

Run:

```bash
git diff --check
git diff -- src/runtime/lark-markdown.ts src/cards/run-card.ts docs/architecture.md tests/lark-markdown.test.ts tests/run-card.test.ts tests/answer-stream.test.ts
git status --short
```

Expected: no whitespace errors; no change to SQLite/store, Answer-page lifecycle, outbox, or pre-existing session/durability files is staged.

- [ ] **Step 5: Commit the documentation after successful verification**

```bash
git add docs/architecture.md
git diff --cached --check
git commit -m "docs: describe bounded CardKit message previews"
```

If the previous feature commits were blocked by the read-only Git index, leave this coherent documentation patch uncommitted as well.

## Plan self-review

### Spec coverage

- The helper uses the exact approved budgets, head-tail structure, Chinese omission marker, newline preference, and hard-boundary fallback.
- Tasks 1–2 isolate the transform to rendered copies and explicitly prohibit mutation of durable state, fingerprints, page offsets, stream sequence, and delivery semantics.
- Task 2 covers main-card and Answer-card entry paths; it protects the supplied `initialContent` page path and leaves source-aware pagination untouched.
- Task 3 verifies all focused paths, static/build checks, the full suite, scope safety, and the durable/canonical-vs-preview documentation boundary.

### Placeholder scan

Searched this plan for `TBD`, `TODO`, `implement later`, `fill in details`, `appropriate error handling`, `handle edge cases`, and `similar to Task`; none occur. The steps specify exported function names, marker text, budgets, test inputs, assertions, and commands.

### Type consistency

- `truncateLarkMarkdownMiddle(source, maxLength)` is consistently the only new public function.
- `MAIN_CARD_PREVIEW_LIMIT` is consistently 2,000 and `ANSWER_CARD_PREVIEW_LIMIT` is consistently 9,000.
- The integration always consumes display strings and returns CardKit content, while canonical state remains owned by the existing reducers/store/page workflow.
