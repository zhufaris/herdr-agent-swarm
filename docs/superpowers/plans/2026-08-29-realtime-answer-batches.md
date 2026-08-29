# Realtime Answer Batches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first Answer content immediately and subsequent output in small, durable batches.

**Architecture:** Keep canonical content and delivery ordering unchanged. Adjust only the projector scheduling policy and CardKit presentation configuration, with focused regression tests around both seams.

**Tech Stack:** TypeScript, Node.js, Vitest, SQLite durable outbox, Lark CardKit

**Spec:** `docs/superpowers/specs/2026-08-29-realtime-answer-batches-design.md`

## Global Constraints

- Preserve cumulative canonical Answer snapshots and monotonically increasing CardKit sequences.
- Preserve the 9,000-character page limit and never patch frozen pages.
- Keep every Lark delivery behind the durable outbox.
- Do not increase retries or bypass lane ordering when Lark rate-limits delivery.

---

### Task 1: Project Answer updates in realtime batches

**Files:**
- Modify: `src/events/conversation-view-projector.ts`
- Test: `tests/event-card-integration.test.ts`

**Interfaces:**
- Consumes: `CardUpdateScheduler.schedule(promptId, viewVersion, immediate)`
- Produces: first-content immediate scheduling, 500 ms maximum coalescing, and an 80-character early-flush threshold

- [ ] Add a failing integration test that emits a short first `TurnOutputObserved` delta and asserts delivery before advancing the debounce timer.
- [ ] Add a failing integration test that verifies later short deltas coalesce while an 80-character increment flushes early.
- [ ] Change `ANSWER_STREAM_INTERVAL_MS` to `500` and `ANSWER_STREAM_MIN_DELTA_CHARS` to `80`.
- [ ] Treat `previousLength === 0 && contentLength > 0` as immediate.
- [ ] Run `npx vitest run tests/event-card-integration.test.ts tests/card-update-scheduler.test.ts`.

### Task 2: Render batches without native character-by-character playback

**Files:**
- Modify: `src/cards/run-card.ts`
- Test: `tests/run-card.test.ts`

**Interfaces:**
- Consumes: `renderRequestAnswerCard(view, { streaming: true })`
- Produces: CardKit streaming cards without `streaming_config`; content API updates remain cumulative

- [ ] Change the running-card expectation to require `streaming_mode: true` and no `streaming_config`.
- [ ] Run the focused test and confirm it fails against the current renderer.
- [ ] Remove `streaming_config` while retaining `streaming_mode`.
- [ ] Run `npx vitest run tests/run-card.test.ts tests/lark-adapter.test.ts`.

### Task 3: Verify, commit, build, and deploy

**Files:**
- Verify all files above plus existing outbox and Answer-page tests.

**Interfaces:**
- Consumes: repository build and Herdr plugin service actions
- Produces: committed build running under `herdr-lark-bridge.service`

- [ ] Run `npm run typecheck`, `npm test`, `git diff --check`, and `npm run build`.
- [ ] Commit only the realtime Answer files without staging unrelated worktree changes.
- [ ] Rebuild after the commit so build identity contains the committed SHA.
- [ ] Confirm `activeTurnWorkers=0`, restart through the Herdr plugin, and verify `/health`, `/status`, PID stability, outbox depth, and build identity.
