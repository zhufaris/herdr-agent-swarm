# Linear Queue Feedback Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove redundant full-queue feedback projections caused by per-prompt queue-position events.

**Architecture:** Keep queue-position events for Run Card projection, but exclude them from the binding-level QueueFeedbackProjector trigger set. Existing lifecycle events remain the one refresh trigger for each queue transition.

**Tech Stack:** TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-08-29-linear-queue-feedback-refresh-design.md`

## Global Constraints

- Preserve `RunQueuePositionChanged` and its ConversationView projection.
- Preserve startup and timer-driven queue feedback convergence.
- Do not change queue estimate formulas or SQLite state.
- Keep unrelated dirty files out of the commit.

---

### Task 1: Remove the redundant feedback trigger

**Files:**
- Modify: `src/events/queue-feedback-projector.ts`
- Test: `tests/queue-feedback-projector.test.ts`

**Interfaces:**
- Preserves all public interfaces.
- Changes only the internal lifecycle event trigger set.

- [ ] Add a failing test that publishes `RunQueuePositionChanged` alone and asserts `loadQueueFeedbackInputs` is not called.
- [ ] Run `npx vitest run tests/queue-feedback-projector.test.ts` and confirm the new assertion fails.
- [ ] Remove `RunQueuePositionChanged` from `REFRESH_EVENTS`.
- [ ] Keep coverage proving the other five lifecycle events still trigger refresh and periodic convergence remains active.
- [ ] Run `npx vitest run tests/queue-feedback-projector.test.ts`, `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.
- [ ] Commit only the spec, plan, projector, and focused test as `perf: avoid repeated queue feedback scans`.
