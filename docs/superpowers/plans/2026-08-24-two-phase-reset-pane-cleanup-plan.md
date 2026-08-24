# Two-phase Reset and Retired-pane Cleanup Implementation Plan

## Goal

Make `/new` preserve the existing topic binding until a replacement TraeX
runtime is ready, then atomically cut over and durably converge safe cleanup of
the retired pane without replaying prompts or blindly replaying a close command.

## Slice 1: candidate identity and additive schema

1. Add reset-candidate linkage and reserved Lark-scope fields to bindings, with
   a versioned additive migration and uniqueness constraints for one unfinished
   candidate per predecessor/scope.
2. Add `retired_pane_cleanup_operations` with pending, waiting, executing,
   succeeded, and retained states; include expected pane identity, attempt/detail
   fields, and indexes for bounded due-work scans.
3. Add domain types and capability-focused store ports for candidate creation,
   atomic cutover, cleanup claim/finish/recovery, and diagnostics.
4. Add SQLite tests for migration/reopen, duplicate candidate idempotency, write
   fencing, compare-and-set claims, and cleanup uniqueness.

## Slice 2: two-phase provisioning and atomic cutover

1. Replace `resetTopicBinding` with candidate creation that does not move topic
   ownership, cancel prompts, detach observers, or dismiss old outbox work.
2. Provision the candidate through pane creation and TraeX startup using the
   existing durable checkpoints, then perform a fresh targeted runtime
   observation before cutover.
3. Implement one fenced SQLite cutover transaction that revalidates old and
   candidate identities, archives/releases the old binding, cancels queued work,
   detaches running work, dismisses pending old delivery, assigns the topic to
   the candidate, activates it, persists its initial projection/outbox intent,
   and creates one cleanup operation.
4. Serialize reset cutover and prompt acceptance for one Lark scope so a
   concurrent message belongs wholly to the old or replacement binding.
5. Preserve uncertain external-create semantics: never auto-create another pane
   after an ambiguous result; expose inspection/attach guidance.
6. Add integration tests for successful cutover, create/start failure preserving
   the old binding, duplicate `/new`, concurrent message acceptance, and delayed
   old-observer completion.

## Slice 3: durable retired-pane cleanup workflow

1. Add `RetiredPaneCleanupWorkflow` with startup scan, coalesced wake-up, bounded
   periodic safety scan, compare-and-set claim, and graceful shutdown.
2. Evaluate durable prompt state and a fresh `observeRuntime` result before each
   close; verify workspace, project directory, pane ID, terminal ID, TraeX
   presence, and idle/done agent state.
3. Move busy operations to `waiting_busy`; terminate unverifiable or mismatched
   operations as `retained`; never call close in either unsafe case.
4. Mark an operation executing before the external call. After close, observe
   pane absence before atomically closing the old binding and succeeding the
   operation.
5. Recover executing operations by observation first. Treat absence as success;
   re-run full safety evaluation before any second close attempt.
6. Connect Herdr runtime-change hints to cleanup wake-up without making plugin
   events authoritative.
7. Add tests for idle/done close, busy waiting, identity mismatch, unknown state,
   close timeout, crash-after-close, restart from executing, duplicate wakes, and
   cleanup failure isolation from the replacement binding.

## Slice 4: Lark UX, diagnostics, and documentation

1. Add a dedicated reset result card for provisioning, cutover success, old-pane
   closed, retained-busy, retained-safety, and replacement failure states.
2. Update `/new` help and `docs/feishu-group-usage.md` to describe safe automatic
   close and preservation behavior accurately.
3. Add cleanup counts, oldest active cleanup age, and latest outcome to the
   operational summary and `/status`; long-lived work degrades status but does
   not independently fail readiness.
4. Add structured logs and audits keyed by reset candidate, old/replacement
   binding, cleanup operation, pane, and outcome, excluding prompt/card payloads.
5. Remove the current inline `closeRetiredPaneAfterReset` implementation only
   after the durable worker path has equivalent focused coverage.

## Slice 5: verification and deployment

1. Run focused store, provisioning, pane lifecycle, prompt concurrency,
   reconciliation, pane-close, health, card, and runtime shutdown tests.
2. Run `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.
3. Review migrations against a copied SQLite fixture including WAL/SHM state; do
   not modify the live database directly.
4. Commit implementation in thematic commits: schema/domain, cutover, cleanup
   worker, then cards/docs. Preserve unrelated pre-existing worktree changes.
5. Build the actual systemd checkout, restart through the Herdr plugin, and wait
   for `/ready` plus healthy cleanup/outbox diagnostics.
6. Perform only a non-mutating real-user smoke observation. A live `/new` or pane
   close requires a separately identified disposable session.

## Acceptance boundary

The feature is complete only when every interruption point has a deterministic
recovery test, no test observes prompt replay, failed replacement provisioning
leaves the old topic usable, cleanup cannot close a busy or identity-mismatched
pane, and the managed runtime reports ready on the generated build.
