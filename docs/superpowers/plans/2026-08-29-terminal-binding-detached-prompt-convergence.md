# Terminal Binding Detached Prompt Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transactionally fail detached running turns that can no longer be observed because their binding is terminal, without replaying work or discarding audit history.

**Architecture:** Extend the durable scan result with a distinct convergence count, then make `SqliteBindingStore.scanDurablePromptWork()` update eligible prompt and Run Card rows inside its existing immediate transaction before producing wake-up hints. Surface the count in workflow diagnostics and structured logs so operators can distinguish queued cancellation from uncertain detached settlement.

**Tech Stack:** TypeScript, Node.js SQLite (`DatabaseSync`), Vitest, Pino, npm

**Spec:** `docs/superpowers/specs/2026-08-29-terminal-binding-detached-prompt-convergence-design.md`

## Global Constraints

- Never replay a prompt that may already have reached TraeX.
- Preserve prompt rows, Run Card rows, and `was_detached=1` audit provenance.
- Keep prompt and Run Card convergence in one `BEGIN IMMEDIATE` transaction.
- Do not modify the restart guard or infer durable state from Lark.
- Leave detached running turns on active, attached bindings observable.
- Do not change steering recovery semantics.

---

### Task 1: Durable transactional convergence

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: existing `SqliteBindingStore.scanDurablePromptWork(): DurablePromptWorkScan` and terminal-binding SQL predicate.
- Produces: `DurablePromptWorkScan { cancelled: number; failedDetached: number; hints: PromptWorkHint[] }`.

- [x] **Step 1: Write the failing store regression test**

Add one test beside `atomically cancels terminal backlog...` that creates Run Cards and detached running ordinary turns for each independently isolated terminal predicate: three legacy states (`archived`, `orphaned`, `failed`), three lifecycles (`archived`, `closed`, `failed`), and orphaned attachment. Add an active/active/attached detached turn as the negative control. Assert the first scan returns `failedDetached: 7`, only the active observer hint, and terminal prompt/card fields exactly as specified; assert the second scan returns `failedDetached: 0` and leaves card versions unchanged.

- [x] **Step 2: Run the test and verify the contract fails**

Run: `npx vitest run tests/sqlite-store.test.ts -t "terminalizes detached running turns owned by terminal bindings"`

Expected: FAIL because `failedDetached` is absent and terminal detached rows remain running.

- [x] **Step 3: Extend the result contract**

Change `DurablePromptWorkScan` in `src/domain/types.ts` to:

```ts
export interface DurablePromptWorkScan {
  cancelled: number;
  failedDetached: number;
  hints: PromptWorkHint[];
}
```

- [x] **Step 4: Implement the atomic prompt and card transition**

In `scanDurablePromptWork()`, select matching detached prompt IDs using the existing terminal-binding predicate, update their matching Run Cards to failed with the bounded no-replay notice and timestamps, then update only those prompts to `failed/completed` while preserving `was_detached`. Keep all statements before hint generation and inside the existing transaction. Return the number of prompt rows changed as `failedDetached`.

- [x] **Step 5: Run the focused store test**

Run: `npx vitest run tests/sqlite-store.test.ts -t "terminalizes detached running turns owned by terminal bindings"`

Expected: PASS.

### Task 2: Workflow diagnostics and scheduling semantics

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `tests/prompt-run-safety-scan.test.ts`
- Modify: `tests/health-server.test.ts`
- Modify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: `DurablePromptWorkScan.failedDetached`.
- Produces: `PromptWorkerDiagnostics.lastDiscovered.failedDetached` and structured `prompt-backlog-converged` log fields.

- [x] **Step 1: Update test fixtures to the explicit scan result shape**

Add `failedDetached: 0` to every `scanDurablePromptWork` fixture and expected result. Extend `PromptWorkerDiagnostics.lastDiscovered` fixtures with `failedDetached: 0`.

- [x] **Step 2: Write the failing workflow regression test**

Add a safety-scan test whose store returns `{ cancelled: 0, failedDetached: 2, hints: [] }`. Assert `lastScanOutcome` is `work_found`, `lastDiscovered.failedDetached` is `2`, the next scan uses the base delay, and the info log records the separate detached convergence count.

- [x] **Step 3: Surface convergence in workflow diagnostics**

Extend `PromptWorkerDiagnostics.lastDiscovered`, initialization, success, and failure paths with `failedDetached`. Treat either `cancelled > 0` or `failedDetached > 0` as found work. Emit one bounded structured log without prompt identity or content.

- [x] **Step 4: Run focused behavioral tests**

Run: `npx vitest run tests/sqlite-store.test.ts tests/prompt-run-safety-scan.test.ts tests/health-server.test.ts`

Expected: all selected files PASS.

### Task 3: Verification and thematic commit

**Files:**
- Verify: all modified source, tests, design, and plan files

**Interfaces:**
- Consumes: the completed implementation and repository build commands.
- Produces: one independently reviewable implementation commit.

- [x] **Step 1: Run static and focused verification**

Run: `npm run typecheck`

Run: `npx vitest run tests/sqlite-store.test.ts tests/prompt-run-safety-scan.test.ts tests/health-server.test.ts`

- [x] **Step 2: Run full verification**

Run: `npm test`

Run: `npm run build`

Run: `git diff --check`

Expected: every command exits zero.

- [x] **Step 3: Audit the diff against the spec**

Confirm every terminal predicate is tested, the active control remains detached, no prompt is requeued, `was_detached` remains true, card and prompt updates share one transaction, the count is observable, and the restart guard is untouched.

- [ ] **Step 4: Commit the implementation batch**

```bash
git add src/domain/types.ts src/store/sqlite-store.ts src/coordinator/prompt-run-workflow.ts tests/sqlite-store.test.ts tests/prompt-run-safety-scan.test.ts tests/health-server.test.ts docs/superpowers/plans/2026-08-29-terminal-binding-detached-prompt-convergence.md
git commit -m "fix: converge terminal detached prompts"
```

### Task 4: Controlled rollout and live verification

**Files:**
- Read: plugin configuration and live SQLite path
- Do not edit: live SQLite directly

**Interfaces:**
- Consumes: committed build, Herdr plugin lifecycle action, loopback status endpoints, and SQLite read-only queries.
- Produces: a live bridge on the new build with stale running count zero.

- [ ] **Step 1: Capture pre-restart evidence**

Use the plugin status action and read-only SQLite queries to confirm no active worker, no queued prompt, no pending outbox work, and exactly the six known stale detached running prompt IDs.

- [ ] **Step 2: Perform the one-time authorized forced restart**

Run the supported Herdr plugin restart action with its force argument only after the implementation commit exists. Do not edit the database or stop the unit manually.

- [ ] **Step 3: Verify readiness and build identity**

Use plugin status and loopback endpoints to confirm `/ready` is ready and the live Git/build identities match the committed build.

- [ ] **Step 4: Verify durable convergence**

Read the six prompt and Run Card rows from SQLite. Confirm `failed/completed`, `was_detached=1`, failed card phase, finished timestamp, and exact no-replay notice. Confirm operational running count, active workers, queued prompts, and pending outbox are all zero.

- [ ] **Step 5: Verify the restart guard is clean**

Invoke the supported non-destructive restart preflight/dry-run if available; otherwise inspect plugin status plus the guard's exact durable inputs. Do not perform a second restart solely for this assertion.
