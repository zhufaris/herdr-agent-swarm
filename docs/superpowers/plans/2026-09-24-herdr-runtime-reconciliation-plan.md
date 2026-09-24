# Herdr Runtime Reconciliation Implementation Plan

## Objective

Implement the approved reconciliation seam while preserving authoritative Herdr
observation, generation-fenced SQLite convergence, scope priority, failure isolation,
and no-replay behavior.

## Step 1: Characterize one reconciliation pass

Add `tests/binding-reconciliation-pass.test.ts` with a tracer test through the
new pass interface. Cover an existing Binding and a newly discovered Pane in one
full snapshot, including immediate pass-local ownership of the discovered Pane.

## Step 2: Extract the authoritative pass

Create `src/coordinator/binding-reconciliation-pass.ts`. Move baseline capture,
targeted Pane observation, full/workspace snapshot planning, missing-Pane handling,
existing-Binding enrichment/convergence, discovery, skipped-Pane warning state,
pruning, failure isolation, and phase measurements from the facade. Reuse the
existing `HerdrSnapshotCollector` and `BindingRuntimeConverger`.

## Step 3: Reduce the lifecycle facade

Construct the pass inside `HerdrRuntimeReconciler`. Keep its public interface,
cooldown admission, `PriorityReconciliationRunner`, periodic lifecycle, shutdown,
last-reconciled workspace timestamps, and diagnostic snapshot. Delegate baseline
capture and scope execution without inspecting Pane/Binding collections.

## Step 4: Enforce and document the seam

Update architecture tests to assert that snapshot collection, discovery, Pane maps,
bounded Binding concurrency, and failure gates live in the pass, while runner,
cooldown, start/stop, and last-reconciled state remain in the facade. Update
`docs/architecture.md` and mark seam 8 complete in the boundary inventory.

## Step 5: Verify

Run the pass tracer, complete Herdr reconciler suite, real-time event integration,
architecture tests, typecheck, build, architecture check, docs audit, full tests,
and `git diff --check`. Commit design, plan, and implementation separately;
do not install, restart, or push.
