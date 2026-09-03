# Final Answer Card Code Folding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Collapse oversized fenced code blocks only after a terminal Answer Card page has completed streaming.

**Architecture:** Live Answer pages retain their stable Markdown stream element. Once stream_finish delivery marks a terminal page finished, AnswerPageWorkflow recreates that bounded page from canonical content and atomically reserves one normal answer card_update only if the page contains an eligible code block. The durable outbox retries this visual upgrade independently.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, SQLite durable outbox, Lark CardKit 2.0.

**Spec:** docs/superpowers/specs/2026-08-27-answer-card-code-folding-design.md

## Global Constraints

- Fold only complete fenced code blocks over 80 lines or 6,000 characters.
- Do not alter stream content, stream finish sequence, page lifecycle, source offsets, continuation, or canonical answers.
- Upgrade only completed finished terminal pages; never frozen continuation pages or failed pages.
- Preserve a readable streamed card if the later visual update fails.
- Do not add schema, actions, prompt replay, or remote TraeX control.

---

### Task 1: Pure final-card fold renderer

**Files:**
- Modify: src/cards/run-card.ts
- Test: tests/run-card.test.ts

- [ ] Add tests covering 81-line TypeScript, 6,001-character one-line JSON, short code, multiple code blocks, and malformed fences.
- [ ] Run: npx vitest run tests/run-card.test.ts -t fold. Expected: FAIL before the final renderer exists.
- [ ] Add renderFinalAnswerCard(view, options) returning null when no eligible complete fence exists, otherwise a completed CardKit card that retains normal Markdown in order and places eligible blocks in collapsible_panel elements with expanded false.
- [ ] Preserve original fence language and code. Title known languages as Language 代码（已折叠 +N 行）, otherwise 代码块（已折叠 +N 行）.
- [ ] Run: npx vitest run tests/run-card.test.ts. Expected: PASS.

### Task 2: Durable final-upgrade reservation and convergence

**Files:**
- Modify: src/domain/ports.ts
- Modify: src/store/sqlite-store.ts
- Modify: src/coordinator/answer-page-workflow.ts
- Test: tests/answer-page-workflow.test.ts
- Test: tests/sqlite-store.test.ts

- [ ] Add failing tests proving a terminal page gets no update before stream_finish delivery, then gets exactly one answer card_update after finished state, and repeated convergence is idempotent.
- [ ] Run: npx vitest run tests/answer-page-workflow.test.ts tests/sqlite-store.test.ts -t fold. Expected: FAIL.
- [ ] Expose finished-page lookup and reserveFinalAnswerCardUpdate through AnswerPageStore. In one transaction verify finished page identity, deduplicate with a stable idempotency key, and enqueue a normal answer card_update to the same Answer message.
- [ ] Have AnswerPageWorkflow inspect a completed run's finished page, regenerate its bounded render with answerStreamContent and renderAnswerStreamPage, call renderFinalAnswerCard, and reserve only a non-null structured result.
- [ ] Run focused page and store tests. Expected: PASS with unchanged page sequence and lifecycle.

### Task 3: Delivery regression tests and deployment

**Files:**
- Test: tests/lark-outbox-dispatcher.test.ts
- Modify: docs/architecture.md only if final code needs a presentation-boundary clarification.

- [ ] Add an outbox test that a final Answer card update calls LarkPort.updateCard and an injected delivery failure retries it without stream content, stream finish, or answer-page mutation.
- [ ] Run focused CardKit, Answer-page, store, and outbox tests.
- [ ] Run: npm run typecheck && npm run build && npm test && git diff --check. Expected: all exit 0.
- [ ] Check .git writeability before staging. If read-only, retain verified work uncommitted and report the blocker; otherwise create a focused commit.
- [ ] Restart after a successful build, then verify GET /status reports the new build identity and readiness.status is ready.
