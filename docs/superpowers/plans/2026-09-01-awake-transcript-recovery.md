# Awake Transcript Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/swarm awake` to recover missed Herdr transcript turns into new Answer Cards without replaying TraeX prompts.

**Architecture:** Extend the transcript port with an exact-turn-boundary cursor, then let the existing prompt workflow serialize a manual recovery drain through the external-turn projector. Persist all adoption and delivery intent through the existing SQLite transactions and outbox.

**Tech Stack:** TypeScript ESM, Node.js, SQLite, Vitest, Herdr CLI, Lark CardKit

**Spec:** `docs/superpowers/specs/2026-09-01-awake-transcript-recovery-design.md`

## Global Constraints

- Never submit or replay a TraeX prompt during awake recovery.
- Preserve exact session, pane, generation, turn ID, and turn-start fences.
- Create a separate immutable Answer Card for every recovered external turn.
- Keep repeated `/swarm awake` requests idempotent.
- Preserve unrelated worktree changes and never edit live SQLite directly.

---

### Task 1: Exact transcript recovery cursor

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/runtime/traex-transcript.ts`
- Test: `tests/traex-transcript.test.ts`

**Interfaces:**
- Produces: `TraexTranscriptReaderPort.openAfterTurn(session, turnId, startedAt)` returning a cursor immediately after the exact completed turn.

- [ ] Add a failing test whose later completed turn exists before the reader opens.
- [ ] Run `npx vitest run tests/traex-transcript.test.ts`.
- [ ] Implement validated bounded boundary discovery and cursor creation.
- [ ] Re-run the focused test.

### Task 2: Serialized awake recovery workflow

**Files:**
- Modify: `src/coordinator/external-turn-observer.ts`
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Test: `tests/pane-thread-lifecycle-integration.test.ts`

**Interfaces:**
- Consumes: `openAfterTurn(...)`.
- Produces: `PromptRunWorkflowPort.awake(bindingId)` with a typed accepted/no-op outcome.

- [ ] Add a failing restart-style integration test with two missed completed turns and queued Feishu work.
- [ ] Run the focused integration test and confirm no Herdr prompt call occurs.
- [ ] Implement ordered supersession/adoption and wake the FIFO after EOF.
- [ ] Re-run the focused integration test.

### Task 3: Command surface and operator documentation

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/commands.ts`
- Modify: `src/coordinator/inbound-router.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `docs/feishu-group-usage.md`
- Test: `tests/commands.test.ts`
- Test: nearest inbound-router integration test

**Interfaces:**
- Consumes: `PromptRunWorkflowPort.awake(bindingId)`.
- Produces: `/swarm awake` with creator authorization and a durable feedback card.

- [ ] Add parser and routing tests, including argument rejection.
- [ ] Implement command routing and user feedback.
- [ ] Add the command to help and the operator guide.
- [ ] Run focused command and routing tests.

### Task 4: Verification and deployment

**Files:**
- Verify all modified source, tests, and docs.

- [ ] Run focused Vitest files.
- [ ] Run `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.
- [ ] Run `./install.sh` to stage the immutable release.
- [ ] Inspect active work and restart with the supported force flag when required.
- [ ] Verify `npm run swarm:status`, service logs, and `/ready` on the configured port.

