# Answer Card Initial Content Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avoid scanning the accumulated answer when a continuation card already has canonical page content.

**Architecture:** Select supplied `initialContent` before invoking answer normalization, while preserving the existing fallback renderer for all other calls.

**Tech Stack:** TypeScript, Vitest, Lark CardKit JSON

**Spec:** `docs/superpowers/specs/2026-08-29-answer-card-initial-content-fast-path-design.md`

## Global Constraints

- Preserve card output outside the `initialContent` path.
- Treat an empty supplied string as authoritative.
- Do not modify the dirty `src/runtime/lark-markdown.ts`.
- Keep unrelated dirty files out of the commit.

---

### Task 1: Short-circuit answer derivation

**Files:**
- Modify: `src/cards/run-card.ts`
- Modify: `tests/run-card.test.ts`

**Interfaces:**
- Preserves: `renderRequestAnswerCard(input, options)`.

- [ ] Add a failing test using throwing getters for `answer`, `answerSegments`, and `answerDraft`, with supplied `initialContent`.
- [ ] Run `npx vitest run tests/run-card.test.ts` and confirm failure.
- [ ] Move answer derivation into the `initialContent === undefined` branch.
- [ ] Add an assertion that empty supplied content is retained.
- [ ] Run focused tests, typecheck, build, full tests, and `git diff --check`.
- [ ] Commit only the spec, plan, renderer, and test as `perf: skip answer scan for prepared pages`.
