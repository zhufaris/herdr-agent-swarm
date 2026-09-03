# Workspace Snapshot Generation Fence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a Herdr workspace snapshot started before invalidation can neither repopulate the cache nor attract post-invalidation readers.

**Architecture:** Associate each in-flight refresh with captured cache generations. Invalidation advances generations, and refresh completion publishes only when its generation is current; identity-checked cleanup prevents an older refresh from removing a newer one.

**Tech Stack:** TypeScript, Vitest, Herdr port adapter

**Spec:** `docs/superpowers/specs/2026-08-29-workspace-snapshot-generation-fence-design.md`

## Global Constraints

- Do not change `HerdrPort` or require cancellation from the delegate.
- Preserve same-generation request coalescing and defensive copies.
- Never partially publish an invalidated all-workspace snapshot.
- Keep unrelated dirty Lark and Markdown files out of the commit.
- Do not deploy while unrelated runtime source remains uncommitted.

---

### Task 1: Fence workspace and all-workspace refresh publication

**Files:**
- Modify: `src/runtime/workspace-snapshot-cache.ts`
- Test: `tests/workspace-snapshot-cache.test.ts`

**Interfaces:**
- Preserves: `WorkspaceSnapshotCache` public methods and `HerdrPort` behavior.
- Adds internally: generation-tagged workspace and all-workspace refresh records.

- [ ] **Step 1: Write the failing workspace-race test**

  Start one deferred `listPanes("w1")`, invalidate `w1`, then start a second read. Resolve the old refresh first and the new refresh second. Assert two delegate calls, the old result is returned only to its original caller, the new result remains coalescible, and subsequent reads use only the new cached value.

- [ ] **Step 2: Run the focused test to verify red**

  Run: `npx vitest run tests/workspace-snapshot-cache.test.ts`

  Expected: FAIL because the post-invalidation read currently joins the old refresh or the old completion overwrites cache state.

- [ ] **Step 3: Implement workspace generation fencing**

  Replace the workspace refresh map value with `{ generation, promise }`. Advance the workspace and global generations on targeted invalidation. Coalesce only matching generations, publish only matching generations, and delete the refresh entry only by promise identity.

- [ ] **Step 4: Write the failing all-workspace race test**

  Start a deferred `listAllPanes()`, invalidate one workspace, and begin a new all-workspace read. Resolve both generations. Assert the old result does not populate all/workspace snapshots or pane indexes and cannot remove the newer refresh.

- [ ] **Step 5: Implement all-workspace generation fencing**

  Store `{ generation, resetGeneration, promise }` for the all-workspace refresh. Commit the complete snapshot only when both captured generations remain current; clear the slot only by identity. `invalidateAll()` advances reset and global generations.

- [ ] **Step 6: Run focused verification**

  Run: `npx vitest run tests/workspace-snapshot-cache.test.ts`

  Expected: all workspace cache tests pass.

- [ ] **Step 7: Run repository verification**

  Run: `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.

  Expected: all commands exit zero.

- [ ] **Step 8: Commit only this batch**

  Stage the spec correction, plan, cache implementation, and cache test only. Commit as `fix: fence stale workspace snapshots`.
