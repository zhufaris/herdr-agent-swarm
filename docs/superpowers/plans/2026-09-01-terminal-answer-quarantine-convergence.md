# Terminal Answer Quarantine Convergence Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release stale Answer-lane quarantines that no longer protect pending delivery work while retaining their dead-letter audit records.

**Architecture:** Extend the existing transactional startup quarantine recovery after its targeted rebuild/rollback passes. Select only active Answer quarantines whose prompt and Run Card are terminal and whose lane has no pending replies, mark them released with a distinct action, and refresh the lane head. Keep startup logging and recovery return values explicit.

**Tech Stack:** TypeScript ESM, Node.js SQLite, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-terminal-answer-quarantine-convergence-design.md`

## Global Constraints

- Preserve every failed outbound reply as a dead letter with its original diagnostics.
- Never release a lane for a queued/running prompt, incomplete observation, non-terminal Run Card, or lane containing pending work.
- Never replay a TraeX prompt or synthesize historical Lark delivery.
- Keep recovery transactional and idempotent.
- Do not modify or commit `TODO.md` or `docs/herdr-agent-swarm-architecture.svg`.

---

### Task 1: Lock the terminal-lane recovery contract

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `tests/sqlite-store.test.ts`
- Modify: `tests/startup-view-converger.test.ts`

**Interfaces:**
- Extend `OutboxQuarantineAction` with `startup_terminalized`.
- Extend `StaleOutboxQuarantineRecovery` with `terminalizedQuarantines: number`.

- [ ] Add a store test that creates an active Answer quarantine, terminalizes its prompt and Run Card, leaves its lane empty, and expects startup recovery to release the quarantine while preserving the failed reply as `dead_letter`.
- [ ] In the same test, call recovery twice and assert the second result reports zero terminalized quarantines.
- [ ] Add negative cases where the prompt remains running and where its lane contains a pending successor; both quarantines must remain active.
- [ ] Update existing exact recovery-result assertions and startup workflow mocks with `terminalizedQuarantines: 0`.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts tests/startup-view-converger.test.ts` and confirm the new positive case fails before implementation.

### Task 2: Implement transactional terminal convergence

**Files:**
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/coordinator/startup-view-converger.ts`

**Interfaces:**
- `recoverStaleOutboxQuarantines(): StaleOutboxQuarantineRecovery` returns the new count.
- Released rows use action `startup_terminalized`; their outbound replies remain unchanged.

- [ ] After targeted startup recoveries, select active `answer_stream` or `immutable` quarantines joined to dead-letter replies, completed terminal prompts, and terminal Run Cards, excluding any lane with a pending reply.
- [ ] Release each selected quarantine with one conditional update and refresh that lane's head inside the existing transaction.
- [ ] Include the new count in startup wake/log decisions; terminalization alone should log recovery but need not wake delivery because the lane is proven empty.
- [ ] Run focused tests until all pass.
- [ ] Run `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Commit implementation and tests as `fix: converge terminal answer quarantines`.

### Task 3: Deploy and verify live convergence

**Files:**
- No source changes expected.

- [ ] Run `npm test` and `npm run docs:audit`.
- [ ] Run `./install.sh`.
- [ ] Restart through `npm run swarm:restart`; use `--force` only if detached observer state again prevents the safe gate from completing.
- [ ] Run `npm run swarm:status` and verify `status: ok`, readiness `ready`, `outboxQuarantines.active: 0`, and the historical dead-letter count remains nonzero.
- [ ] Confirm the deployed build identity matches the committed HEAD and report without pushing.
