# Priority Runtime Reconciliation Implementation Plan

**Goal:** Implement the approved priority-scoped reconciliation design so precise
Herdr pane hints converge Primary binding and Worker instance state before pending
workspace/full scans, while preserving per-domain single-writer execution, durable
SQLite authority, periodic recovery, and no-replay behavior.

## Task 1: Add the reusable priority scope runner test-first

- Add `tests/priority-reconciliation-runner.test.ts` covering priority order,
  same-scope ID coalescing, request completion, single-flight execution, failure
  isolation, periodic full requests, diagnostics, and shutdown with queued work.
- Add `src/runtime/priority-reconciliation-runner.ts` with the typed
  `panes | workspaces | all` scope, bounded `Set`/flag pending state, independent
  request waiters, one active executor, and one optional periodic timer.
- Keep the runner domain-free and payload-free. It must not import a store, Herdr
  adapter, card renderer, or coordinator.
- Extend reconciliation diagnostics with bounded scheduling fields and keep existing
  run/failure metrics compatible.
- Run the runner tests and typecheck. Commit this slice independently.

## Task 2: Migrate Primary binding reconciliation

- Replace `ReconciliationScheduler` plus the separate pane idle-wait path in
  `HerdrRuntimeReconciler` with one runner instance.
- Keep targeted pane convergence behavior and all logic in
  `BindingRuntimeConverger` unchanged.
- Retain the successful-workspace cooldown for event-driven workspace/full requests;
  never apply it to pane requests or explicit/periodic reconciliation.
- Extend `tests/herdr-runtime-reconciler.test.ts` to prove a pane request accepted
  during a full pass runs before pending workspace/full work, newer narrow requests
  are not absorbed, and terminal lifecycle eligibility remains intact.
- Delete `reconciliation-scheduler.ts` and obsolete scope policy only after repository
  search proves no consumers remain.
- Run focused Primary reconciliation and scope tests. Commit independently.

## Task 3: Migrate Worker instance reconciliation

- Replace the private pending/running/timer scope state machine in
  `InstanceRuntimeReconciler` with a separate priority runner instance.
- Preserve pending-runtime attachment, exact runtime identity checks, terminalization,
  observation writes, card-context wake-up, and queued-turn wake-up behavior.
- Use targeted pane inspection without introducing a new cache or cross-domain queue.
- Extend `tests/instance-runtime-reconciler.test.ts` for the same priority and failure
  behavior and prove the Primary and Worker runner instances remain independent.
- Run focused Worker reconciliation and Herdr event-router tests. Commit independently.

## Task 4: Prove local real-time convergence and update architecture

- Add a controlled integration test that sends a pane-scoped Herdr hint while both
  runners are idle and verifies the durable binding/instance state plus resulting
  card outbox intent within one second.
- Add a dropped-hint test showing periodic full reconciliation still converges.
- Expose pending counts, active scope kind, priority promotions, and accepted-to-start
  delay through existing `/status` reconciliation diagnostics without IDs or prompt
  text.
- Update `docs/architecture.md` and the production critical-path audit with the new
  scheduling boundary, latency evidence, and preserved recovery authority.
- Run event-router, health, card, outbox, no-replay, and reconciliation focused tests.
  Commit independently.

## Task 5: Full validation and completion audit

- Run `npm run typecheck`, `npm run architecture:check`, `npm run docs:audit`,
  `npm run build`, `git diff --check`, and `npm test` sequentially.
- Map every design verification item to a concrete test or runtime diagnostic and
  inspect the actual current files and Git state.
- Confirm no payload in-memory queue, cross-domain shared runner, concurrent same-domain
  writers, prompt replay path, or direct Lark call was introduced.
- Inspect outgoing commits but do not push. Record that hook-injected attribution must
  be removed from the complete outgoing range before any future push.

## Task 6: Install and validate production safely

- Run `./install.sh` after all repository gates pass.
- Inspect active prompts, observers, actionable outbox work, readiness, lease, and
  SQLite integrity before restart.
- Attempt only the normal `npm run swarm:restart` safety-gated path. Do not reuse any
  prior force authorization.
- After activation, verify expected/observed build identity, systemd/listener PID
  ownership, readiness, startup recovery, SQLite integrity, Herdr socket, Lark, and
  at least one complete reconciliation cycle.
