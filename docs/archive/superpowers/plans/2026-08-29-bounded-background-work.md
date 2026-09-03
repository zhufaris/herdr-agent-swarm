# Bounded Background Work and Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contain background delivery failures and guarantee a bounded shutdown without violating SQLite writer ownership.

**Architecture:** Add local failure launchers and bounded retry state to the outbox and card schedulers. Propagate the shared shutdown abort signal into the integrity worker and return an explicit shutdown outcome when writers fail to settle.

**Tech Stack:** TypeScript, Node.js worker threads, SQLite, Vitest, systemd lifecycle

**Spec:** `docs/superpowers/specs/2026-08-29-bounded-background-work-design.md`

## Global Constraints

- Do not replay TraeX prompts.
- Do not change outbox lane ordering or CardKit stream sequence.
- Do not close SQLite or release its lease while a writer may still be active.
- Keep existing dirty Lark/Markdown work out of every commit.
- Use focused tests before the full repository verification.

---

### Task 1: Contain outbox and card scheduler failures

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/events/lark-outbox-dispatcher.ts`
- Modify: `src/events/card-update-scheduler.ts`
- Modify: `src/events/conversation-view-projector.ts`
- Modify: `src/health/server.ts`
- Test: `tests/lark-outbox-dispatcher.test.ts`
- Test: `tests/card-update-scheduler.test.ts`
- Test: `tests/health-server.test.ts`

**Interfaces:**
- Produces: extended `OutboxDispatcherDiagnostics` failure counters/timestamps.
- Produces: `CardUpdateScheduler` optional `onError` callback and bounded retry behavior.

- [ ] Add failing tests for scan rejection containment, retry, diagnostics recovery, scheduler retry, stop cancellation, and `/status` degradation.
- [ ] Run focused tests and confirm the new assertions fail.
- [ ] Add one private outbox scan launcher and route every fire-and-forget entry through it.
- [ ] Add bounded exponential scan retry and diagnostics reset on success.
- [ ] Add one card flush launcher; retain the latest version after failure and retry with a bounded delay.
- [ ] Wire the scheduler error callback to the conversation projector logger.
- [ ] Degrade `/status` when the latest outbox scan failed.
- [ ] Run the three focused test files and typecheck.
- [ ] Commit only Task 1 files as `fix: contain background delivery failures`.

### Task 2: Bound integrity worker and runtime shutdown

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/runtime/sqlite-integrity-worker.ts`
- Modify: `src/runtime/sqlite-integrity-auditor.ts`
- Modify: `src/runtime/shutdown.ts`
- Modify: `src/main.ts`
- Test: `tests/sqlite-integrity-auditor.test.ts`
- Test: `tests/runtime-shutdown.test.ts`
- Test: `tests/architecture-boundaries.test.ts`

**Interfaces:**
- Changes: `DatabaseIntegrityStore.inspectIntegrity(limit, signal?)`.
- Changes: `SqliteIntegrityAuditor.stop(context?)`.
- Produces: `BridgeRuntimeShutdown.shutdown(signal)` outcome identifying completed versus ownership-retained shutdown.

- [ ] Add failing tests for abort propagation, bounded worker termination, auditor participation in shared shutdown, and bounded ownership-retained return.
- [ ] Run focused tests and confirm the new assertions fail.
- [ ] Forward an optional abort signal through the integrity port and terminate the worker on abort.
- [ ] Let the auditor cancel its current inspection and settle inside the shared shutdown budget.
- [ ] Add the auditor to `BridgeRuntimeShutdown` and return without releasing ownership after the final settlement allowance.
- [ ] Update `main.ts` to use the shutdown outcome and robust startup-failure cleanup.
- [ ] Run the focused tests and typecheck.
- [ ] Commit only Task 2 files as `fix: bound integrity audit shutdown`.

### Task 3: Repository verification and deployment decision

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: both implementation commits.
- Produces: fresh test/build evidence and a safe restart decision.

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check` and verify unrelated dirty files remain unstaged.
- [ ] Inspect port 8788 `/status`; restart only `herdr-agent-swarm.service` when ordinary and instance workers are idle and outbox work has drained.
- [ ] Verify `/ready`, expected/observed build identity, service restart count, and recent logs after restart.
