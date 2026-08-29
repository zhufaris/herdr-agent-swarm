# Reconciler Observation State Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove stale pane observations after authoritative full reconciliation without weakening partial-pass safety or live-pane deduplication.

**Architecture:** `HerdrRuntimeReconciler` will use its complete full-pass pane set to prune process-local observation maps after pane processing. Scoped or incomplete passes retain all prior entries, and the unused revision map is deleted.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, existing Herdr and SQLite test fakes

**Spec:** `docs/superpowers/specs/2026-08-29-reconciler-observation-state-pruning-design.md`

## Global Constraints

- Prune only after a full reconciliation with results for every configured workspace.
- Never prune after a workspace-scoped request or incomplete fallback scan.
- Retain every observation belonging to a pane present in the complete snapshot.
- Do not add Herdr calls, background timers, persisted cache state, or Lark work.
- Preserve monotonic state filtering for continuously live pane identities.

---

### Task 1: Prune Disappeared Pane Observations

**Files:**
- Modify: `src/coordinator/herdr-runtime-reconciler.ts`
- Test: `tests/herdr-runtime-reconciler.test.ts`

**Interfaces:**
- Consumes: `HerdrRuntimeReconciler.reconcile(workspaceIds?: readonly string[]): Promise<void>` and complete `panesByWorkspace` results.
- Produces: no new public API; internal pruning of terminal output, agent state, tab, and worktree observations.

- [ ] **Step 1: Write the failing pane-ID reuse test**

Create an active binding on pane `w1:p1` with terminal `term-1`, state `idle`, and sequence 10. Reconcile once, return an empty successful full snapshot, then create a new active binding for the same pane and terminal. Return state `working` at sequence 1 and assert the new binding records `working`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/herdr-runtime-reconciler.test.ts -t "forgets observations for panes absent from a complete snapshot"`

Expected: FAIL because the stale sequence-10 observation forces the reused pane back to `idle`.

- [ ] **Step 3: Implement complete-snapshot pruning**

After all panes have been processed, detect a complete full pass with `requestedWorkspaceIds === undefined` and one `panesByWorkspace` entry per configured workspace. Build the live pane-ID set and delete absent keys from `observedTerminalOutputs`, `observedAgentStates`, `observedTabIds`, and `observedWorktreeNames`. Add one private helper that deletes keys absent from a supplied read-only set.

- [ ] **Step 4: Remove dead revision observations**

Delete `observedOutputRevisions` and both writes to it. Keep the explanatory comment that content fingerprinting, not snapshot revision, is the deduplication boundary.

- [ ] **Step 5: Run focused verification**

Run: `npx vitest run tests/herdr-runtime-reconciler.test.ts`

Expected: the complete reconciler test file passes, including unavailable-snapshot and scoped-reconciliation coverage.

- [ ] **Step 6: Run repository verification**

Run: `npm run typecheck`

Expected: TypeScript exits successfully.

Run: `npm test`

Expected: all Vitest files and tests pass.

Run: `npm run build`

Expected: clean compilation and build-identity generation succeed.

Run: `git diff --check -- src/coordinator/herdr-runtime-reconciler.ts tests/herdr-runtime-reconciler.test.ts`

Expected: no whitespace errors.

- [ ] **Step 7: Commit the implementation**

```bash
git add src/coordinator/herdr-runtime-reconciler.ts tests/herdr-runtime-reconciler.test.ts
git commit -m "perf: prune stale reconciler observations"
```
