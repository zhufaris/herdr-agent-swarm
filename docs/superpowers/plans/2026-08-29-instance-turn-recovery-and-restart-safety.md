# Instance Turn Recovery and Restart Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover multi-agent instance turns after shutdown without replay, fence active stops, and include instance work in status and restart safety.

**Architecture:** SQLite records the dispatch boundary and owns atomic recovery and stop reservations. A new `InstanceTurnSupervisor` observes turns that may already have reached Herdr, while `InstanceWorkScheduler` dispatches only work known not to have started and exposes bounded diagnostics.

**Tech Stack:** TypeScript ESM, Node.js 22.5+, SQLite, Pino, Vitest, Herdr pane adapter.

**Spec:** `docs/superpowers/specs/2026-08-29-instance-turn-recovery-and-restart-safety-design.md`

## Global Constraints

- Never automatically replay a prompt after an external driver call may have begun.
- Preserve SQLite as the single transaction owner and generation-fence every transition.
- Do not modify or stage unrelated Lark/Answer work from the main worktree.
- Keep diagnostics bounded and exclude prompt text, terminal output, identities, and secrets.
- Use ESM imports with `.js` specifiers and the repository's compact TypeScript style.

---

### Task 1: Durable instance-turn recovery protocol

**Files:**
- Modify: `src/domain/agent-runtime.ts`
- Modify: `src/domain/instance-turn.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Produces: `AgentRuntimeDriver.submit(runtime, text, onDispatched?)`.
- Produces: `InstanceStore.recoverInterruptedInstanceTurns()` returning requeued and observable turn IDs.
- Produces: generation-scoped active/count queries and atomic stop reservation/finalization methods.

- [ ] Add failing Store tests for claimed-to-queued recovery, no-replay recovery states, generation-scoped claims, and active stop rejection.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts` and confirm the new assertions fail.
- [ ] Implement transactional recovery and lifecycle methods with generation fences.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts` and confirm it passes.
- [ ] Commit the Store protocol as `feat: add durable instance turn recovery protocol`.

### Task 2: Scheduler failure fencing and detached supervisor

**Files:**
- Modify: `src/runtime/agents/terminal-agent-driver.ts`
- Modify: `src/runtime/agents/traex-driver.ts`
- Modify: `src/events/instance-work-scheduler.ts`
- Create: `src/coordinator/instance-turn-supervisor.ts`
- Modify: `src/coordinator/instance-runtime-reconciler.ts`
- Modify: `src/main.ts`
- Test: `tests/instance-messaging.integration.test.ts`
- Create: `tests/instance-turn-supervisor.test.ts`
- Test: `tests/instance-runtime-reconciler.test.ts`

**Interfaces:**
- Consumes: Task 1 recovery methods and dispatch callback.
- Produces: `InstanceTurnSupervisor.prepareRecovery()`, `reconcile()`, `start(intervalMs)`, `stop()`, and `snapshot()`.
- Produces: scheduler `snapshot()` and bounded failure diagnostics.

- [ ] Add failing tests proving dispatch callback persistence, thrown driver fencing, no unhandled drain rejection, observer-only recovery, ambiguous idle retention, and per-instance error isolation.
- [ ] Run the three focused Vitest files and confirm the new assertions fail.
- [ ] Implement dispatch callbacks and scheduler exception handling.
- [ ] Implement the supervisor and connect reconciler wake-up hints without calling `submit` during recovery.
- [ ] Wire startup, periodic reconciliation, and shutdown in `src/main.ts`.
- [ ] Run the focused tests and confirm they pass.
- [ ] Commit runtime recovery as `feat: recover active instance turns without replay`.

### Task 3: Stop fencing, diagnostics, and restart guard

**Files:**
- Modify: `src/coordinator/instance-control-workflow.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/health/server.ts`
- Modify: `src/cli/plugin-lifecycle.ts`
- Modify: `src/runtime/shutdown.ts`
- Modify: `src/main.ts`
- Test: `tests/instance-control.integration.test.ts`
- Test: `tests/health-server.test.ts`
- Test: `tests/plugin-lifecycle.test.ts`
- Test: `tests/runtime-shutdown.test.ts`

**Interfaces:**
- Consumes: Task 1 atomic stop methods and Task 2 snapshots.
- Produces: `InstanceWorkerDiagnostics` under `/status.instanceWorker`.
- Produces: restart rejection when any instance dispatch, observer, active turn, or uncertain turn is present.

- [ ] Add failing tests for active stop rejection, release rollback, status degradation, restart blocking, force bypass, and deadline-aware worker shutdown.
- [ ] Run the four focused Vitest files and confirm the new assertions fail.
- [ ] Implement stop reservation/finalization and failure rollback.
- [ ] Publish combined instance diagnostics and extend restart preflight.
- [ ] Pass shutdown context to the instance worker aggregate.
- [ ] Run focused tests and confirm they pass.
- [ ] Commit operational protection as `feat: guard instance work lifecycle operations`.

### Task 4: Verification and documentation alignment

**Files:**
- Modify: `README.md` only if operator behavior needs clarification.
- Modify: `docs/architecture.md` only if recovery ownership is not already explicit.

**Interfaces:**
- Consumes: all prior task behavior.
- Produces: implementation-backed operator guidance and fresh verification evidence.

- [ ] Run `npx vitest run tests/sqlite-store.test.ts tests/instance-messaging.integration.test.ts tests/instance-turn-supervisor.test.ts tests/instance-runtime-reconciler.test.ts tests/instance-control.integration.test.ts tests/health-server.test.ts tests/plugin-lifecycle.test.ts tests/runtime-shutdown.test.ts`.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check` and inspect the final diff for prompt text or secret leakage.
- [ ] Update only documentation required by the implemented behavior.
- [ ] Commit documentation, if changed, as `docs: explain instance turn recovery`.
- [ ] Record commit IDs, test counts, and any integration conflict with main-worktree WIP.
