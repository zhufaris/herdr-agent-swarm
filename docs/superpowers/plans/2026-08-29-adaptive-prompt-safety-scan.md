# Adaptive Prompt Safety Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace the fixed five-second prompt safety interval with a single observable timeout that backs off while idle and resets on work, failure, or workflow wake.

**Architecture:** PromptRunWorkflow owns one timeout and a consecutive-idle counter. Every scan chooses and arms the next delay; scoped wake handling remains immediate and only resets the future safety timeout. Diagnostics expose the selected delay and next scan timestamp.

**Tech Stack:** TypeScript, Vitest fake timers, Node.js timers

**Spec:** docs/superpowers/specs/2026-08-29-adaptive-prompt-safety-scan-design.md

## Global Constraints

- Base delay remains safetyScanIntervalMs with a 5,000 ms production default.
- Idle delays are base, 2x, 4x, then capped at 6x.
- Work found, cancellation, scan failure, or any wake resets delay to base.
- Keep exactly one unref'd timeout; stop must prevent re-arming.
- Do not change SQLite queue, claim, concurrency, or no-replay semantics.
- Preserve unrelated dirty-worktree changes.

---

### Task 1: Specify adaptive scheduling with fake timers

**Files:**
- Modify: tests/prompt-run-safety-scan.test.ts
- Modify: tests/health-server.test.ts

**Interfaces:**
- Consumes: PromptRunWorkflow.start, requestSafetyScan, wake, stop, snapshot.
- Produces: deterministic tests for delay progression, reset rules, timer cardinality, shutdown, and status serialization.

- [ ] Add a fake-timer test asserting startup scans immediately and reports base delay plus nextSafetyScanAt.
- [ ] Advance consecutive idle timers and assert delays base, 2x, 4x, then 6x with no earlier scans.
- [ ] Return a work hint after an idle delay and assert the following delay resets to base and scoped claim runs.
- [ ] Make a scan throw after idle backoff and assert retry delay is base and error details remain absent from snapshot.
- [ ] Call wake during the capped idle delay and assert scoped scheduling is immediate, the old timeout is replaced, and only one scan fires at the new base deadline.
- [ ] Call start and wake repeatedly, then stop; assert timer count never exceeds one and no later scan occurs.
- [ ] Extend the health test fixture and assertion with currentSafetyScanDelayMs and nextSafetyScanAt.
- [ ] Run npx vitest run tests/prompt-run-safety-scan.test.ts tests/health-server.test.ts and confirm new assertions fail before implementation.

---

### Task 2: Implement the single adaptive timeout

**Files:**
- Modify: src/coordinator/prompt-run-workflow.ts
- Modify: src/domain/types.ts
- Modify: tests/prompt-run-safety-scan.test.ts
- Modify: tests/health-server.test.ts

**Interfaces:**
- Consumes: safetyScanIntervalMs and PromptWorkHint.
- Produces: PromptWorkerDiagnostics.currentSafetyScanDelayMs and nextSafetyScanAt.

- [ ] Replace safetyTimer's interval ownership with one timeout handle and add consecutiveIdleScans, currentSafetyScanDelayMs, and nextSafetyScanAt state.
- [ ] Implement a private armSafetyScan(delayMs) that clears any prior timeout, records diagnostics, creates one unref'd timeout, nulls its handle when fired, and invokes requestSafetyScan.
- [ ] Make requestSafetyScan classify idle, work_found, and failed outcomes, update the idle counter, and arm base * min(2^(idleCount-1), 6) for idle or base for work/failure.
- [ ] Make wake preserve every existing branch and reset the future timeout to base after scoped scheduling.
- [ ] Make stop set stopping before clearing the timeout, null nextSafetyScanAt, and preserve existing worker settlement.
- [ ] Extend PromptWorkerDiagnostics and health fixtures with the two aggregate scheduling fields.
- [ ] Run npx vitest run tests/prompt-run-safety-scan.test.ts tests/health-server.test.ts tests/concurrency-controls.integration.test.ts tests/steering-integration.test.ts.
- [ ] Run npm run typecheck, npm run build, and git diff --check.
- [ ] Review that setInterval is absent from PromptRunWorkflow and no queue/claim SQL changed.
- [ ] Commit only these files as feat: adapt prompt safety scan cadence.

---

### Task 3: Full verification and safe deployment

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: committed adaptive scheduler and standalone lifecycle commands.
- Produces: full-suite evidence and deployed identity.

- [ ] Run npm test and require every test to pass.
- [ ] Run npm run build after the final commit and record its build ID.
- [ ] Run npm run swarm:restart without --force; if the current turn blocks it, schedule one safe delayed retry that still uses the normal gate.
- [ ] Run npm run swarm:status and verify active service, ready readiness, matching expected/observed identity, and populated promptWorker scheduling diagnostics.
- [ ] Record that live Lark traffic was not synthesized.
