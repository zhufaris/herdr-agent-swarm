# Command Target Inline Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render compact Command call targets as Markdown inline code in Answer Cards.

**Architecture:** Keep classification, redaction, and target bounding inside the pure tool activity projector. Add a category-specific presentation helper so only Command targets receive Markdown code delimiters, while result entries and all other categories remain unchanged.

**Tech Stack:** TypeScript, Node.js ESM, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-typed-tool-activity-projection-design.md`

## Global Constraints

- Command targets remain single-line, secret-free, and bounded to 160 characters before presentation.
- Embedded backticks cannot break the inline-code span.
- Other activity categories and all result entries retain their current format.
- Assistant `output_text`, transcript offsets, persistence, pagination, and outbox behavior do not change.

---

### Task 1: Render Command targets as inline code

**Files:**
- Modify: `tests/tool-activity-projector.test.ts`
- Modify: `src/runtime/tool-activity-projector.ts`
- Modify: `tests/traex-transcript.test.ts`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: `projectToolCall(name: string, argumentsJson: string): ProjectedToolCall`.
- Produces: Command call entries shaped as <code>▶ Command · `&lt;safe target&gt;`</code>.

- [x] **Step 1: Write failing projector and cursor assertions**

Assert that `exec_command` and nested `exec` calls wrap the safe command target in Markdown inline-code delimiters, embedded backticks are neutralized, secrets remain absent, and Read targets remain plain text.

- [x] **Step 2: Run the focused tests and confirm red**

Run: `npx vitest run tests/tool-activity-projector.test.ts tests/traex-transcript.test.ts`

Expected: Command call expectations fail because current entries have no inline-code delimiters.

- [x] **Step 3: Implement category-specific call presentation**

Add a pure renderer used by `projectToolCall`: Command targets are surrounded by one Markdown backtick after the existing redaction and escaping pass; all other targets are returned unchanged.

- [x] **Step 4: Update architecture documentation**

Document that only Command call targets use Markdown inline code and that result summaries are unchanged.

- [x] **Step 5: Run focused and full verification**

Run:

```bash
npx vitest run tests/tool-activity-projector.test.ts tests/traex-transcript.test.ts
npm run typecheck
npm run build
npm test
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 6: Commit and deploy**

```bash
git add docs/architecture.md docs/superpowers/plans/2026-08-27-command-target-inline-code.md src/runtime/tool-activity-projector.ts tests/tool-activity-projector.test.ts tests/traex-transcript.test.ts
git commit -m "feat: render command targets as inline code"
npm run build
herdr plugin action invoke restart --plugin herdr-lark-bridge
```

Verify the expected and observed commit/build identity match, readiness is `ready`, startup recovery is `completed`, Lark and Herdr are connected, and pending outbox is zero.
