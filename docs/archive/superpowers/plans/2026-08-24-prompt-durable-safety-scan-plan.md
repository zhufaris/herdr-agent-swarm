# Prompt Durable Safety Scan Plan

## Goal

Recover durable queued and detached prompt work independently of Herdr runtime
reconciliation while preserving all dispatch and no-replay invariants.

## Slices

- [x] Add `DurablePromptWorkScan` and `scanDurablePromptWork()` to the prompt
  store seam; atomically cancel terminal backlog and return identity-only hints.
- [x] Cover queued turns, queued steering, detached observers, Answer-card-gated
  work, terminal backlog, deduplication, and payload privacy at the store seam.
- [x] Replace `PromptRunWorkflow.start()` ad-hoc startup reads with an immediate
  and periodic safety scan; isolate scan failures and cancel the timer on stop.
- [x] Remove blanket prompt convergence and scans from
  `HerdrRuntimeReconciler`, retaining targeted runtime-change wake-ups.
- [x] Add sanitized prompt-worker diagnostics to `/status` without changing
  `/ready`.
- [x] Update architecture documentation and structural tests.
- [x] Run focused tests, full tests, typecheck, production build, and diff check.
- [x] Commit the focused implementation without restarting or deploying the
  managed service.

## TDD order

1. SQLite scan contract tests.
2. Prompt workflow lost-wake, failure-retry, and shutdown timer tests.
3. Reconciler ownership regression tests.
4. Health status and readiness-isolation tests.
5. Integration regressions for concurrency, steering, recovery, and shutdown.

## Acceptance evidence

- Durable work progresses after a missed scheduler wake without invoking Herdr
  reconciliation.
- A detached prompt is observed and never sent again.
- An ordinary queued prompt remains gated until its Answer Card checkpoint.
- Terminal-binding backlog cancellation and its run-card projection remain
  transactional.
- Stopping the workflow prevents later timer-driven scans and waits under the
  existing worker shutdown rules.
- Status contains counts and timestamps only, with no prompt, pane, Lark, or
  payload identifiers.
