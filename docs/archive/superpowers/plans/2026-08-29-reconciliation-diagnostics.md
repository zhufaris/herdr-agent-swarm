# Reconciliation Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded process-local reconciliation timing and lifecycle diagnostics to `/status`.

**Architecture:** Both existing reconcilers implement the shared `ReconciliationDiagnostics` contract and measure their own physical passes. The health server reads both snapshots with failure isolation and exposes them as one diagnostic section without changing readiness or durable workflow behavior.

**Tech Stack:** TypeScript, Node.js monotonic timing, Vitest, existing HTTP health server.

**Spec:** `docs/superpowers/specs/2026-08-29-reconciliation-diagnostics-design.md`

## Global Constraints

- Do not persist diagnostic history or add dependencies.
- Do not expose identifiers, terminal content, prompt text, or error text.
- Do not change reconciliation scheduling, recovery, or readiness semantics.
- Preserve all existing main-worktree Lark and Answer WIP during integration.

---

### Task 1: Shared diagnostics contract and instance reconciler

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/coordinator/instance-runtime-reconciler.ts`
- Test: `tests/instance-runtime-reconciler.test.ts`

**Interfaces:**
- Produces: `ReconciliationDiagnostics` and `InstanceRuntimeReconciler.snapshot(): ReconciliationDiagnostics & { ready: boolean; lastError: string | null }`.

- [ ] Add failing tests for idle, running, success, failure, coalesced request, and stopping snapshots.
- [ ] Run `npx vitest run tests/instance-runtime-reconciler.test.ts` and confirm the new assertions fail.
- [ ] Add the shared type and monotonic pass measurement while preserving the existing `ready` and `lastError` fields.
- [ ] Run `npx vitest run tests/instance-runtime-reconciler.test.ts` and confirm it passes.
- [ ] Commit the shared contract and instance diagnostics.

### Task 2: Binding reconciler diagnostics

**Files:**
- Modify: `src/coordinator/herdr-runtime-reconciler.ts`
- Test: `tests/herdr-runtime-reconciler.test.ts`

**Interfaces:**
- Consumes: `ReconciliationDiagnostics`.
- Produces: `HerdrRuntimeReconciler.snapshot(): ReconciliationDiagnostics`.

- [ ] Add failing tests proving joined callers increment coalescing without adding a physical run, and a queued follow-up scan adds a physical run.
- [ ] Add failing success, failure, running, and stopping snapshot assertions.
- [ ] Run `npx vitest run tests/herdr-runtime-reconciler.test.ts` and confirm the assertions fail.
- [ ] Instrument `reconcileOnce` with monotonic duration and finalize counters without swallowing its exception.
- [ ] Run the focused test and confirm it passes.
- [ ] Commit binding reconciliation diagnostics.

### Task 3: Health status integration

**Files:**
- Modify: `src/health/server.ts`
- Modify: `src/main.ts`
- Test: `tests/health-server.test.ts`

**Interfaces:**
- Consumes: two `{ snapshot(): ReconciliationDiagnostics }` capabilities.
- Produces: `/status.reconciliation.bindingRuntime` and `/status.reconciliation.instanceRuntime`.

- [ ] Add failing tests for the response shape, snapshot exception isolation, degraded status, and unchanged `/ready`.
- [ ] Add the optional binding reconciler capability and reuse the existing instance reconciler capability for diagnostics.
- [ ] Pass the binding reconciler from the composition root; keep `instanceRuntime` readiness behavior intact.
- [ ] Run `npx vitest run tests/health-server.test.ts tests/instance-runtime-reconciler.test.ts tests/herdr-runtime-reconciler.test.ts`.
- [ ] Commit health integration.

### Task 4: Final verification and safe integration

**Files:**
- Verify all changed files and the main-worktree boundary.

- [ ] Run the three focused test files.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check` and confirm the isolated worktree is clean.
- [ ] Integrate thematic commits into `main`, manually merging only overlapping `src/main.ts` wiring while preserving unrelated WIP.
- [ ] Repeat focused tests, full tests, typecheck, build, staged-boundary, and diff checks in the main worktree.
