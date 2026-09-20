# Startup Runtime Reconciliation Concurrency Implementation Plan

**Goal:** Implement and production-validate the bounded existing-binding
convergence design in
`docs/superpowers/specs/2026-09-19-startup-runtime-reconciliation-concurrency-design.md`.

## Task 1: Lock the ordering and concurrency contract with tests

- Extend `tests/herdr-runtime-reconciler.test.ts` with six existing bindings whose
  asynchronous convergence work is observable and controllable.
- Assert no more than four existing-binding operations run concurrently, all six
  eventually settle, and a rejected pane operation does not cancel another pane.
- Add a mixed existing/unbound case proving unbound discovery starts only after the
  existing-binding phase settles and remains serial in snapshot order.
- Preserve focused coverage for missing-pane handling, full/workspace scope,
  coalescing, and failure-log recovery.
- Run the focused test file and confirm the new concurrency assertion fails against
  the serial implementation for the intended reason.

## Task 2: Implement bounded existing-binding convergence

- Refactor `HerdrRuntimeReconciler.reconcileOnce()` into named private phase helpers
  rather than duplicating pane rules.
- Retain serial missing-pane transitions before snapshot-pane work.
- Classify snapshot panes once into existing-binding work and discovery candidates.
- Use the shared `mapWithConcurrency` helper with a limit of four for existing
  bindings only.
- Keep unknown-state runtime enrichment, binding convergence, and per-pane failure
  logging within each bounded operation.
- Keep candidate discovery serial and preserve snapshot order, project matching,
  interrupted-provisioning fencing, and skipped-pane diagnostics.
- Prune observation state only after both phases settle.

## Task 3: Add phase diagnostics without widening health authority

- Add an optional runtime reconciliation phase snapshot to the reconciler's own
  diagnostics, not to SQLite or a new persistence layer.
- Record finite non-negative snapshot, missing-pane, existing-binding, and discovery
  durations plus the two phase counts.
- Expose the fields through the existing `/status` reconciliation object.
- Add tests for populated diagnostics after success and stable behavior after a
  contained pane failure.

## Task 4: Verify repository behavior

- Run `npx vitest run tests/herdr-runtime-reconciler.test.ts`.
- Run `npm run typecheck`, `npm run build`, and `npm run architecture:check`.
- Run `npm test` because reconciliation ordering affects startup, event-driven
  convergence, Prompt observation, and durable card projection.
- Run `git diff --check` and inspect the complete diff for unintended readiness,
  SQLite, outbox, or Prompt replay changes.
- Commit implementation and tests as an independently reviewable A-stage commit.

## Task 5: Install and production-validate A

- Run `./install.sh` after all gates pass.
- Inspect active Prompt, Worker, instance, and outbox work before activation.
- Use only the normal `npm run swarm:restart` safety gate; do not use `--force`.
- Verify expected and observed build identity, user-systemd ownership, readiness,
  SQLite quick check, Herdr socket, and Lark connectivity.
- Read the new build's structured startup logs and require
  `runtime-reconciliation < 2,000 ms`.
- If the target is missed, use the phase diagnostics to continue A rather than
  declaring it complete.

## Task 6: Continue B then C

- After A passes production validation, design and implement B: avoidable Lark HTTP
  400 and dead-letter reduction.
- After B passes production validation, design and implement C: evidence-backed code
  simplification and duplicate lifecycle/scan removal.
- Keep each stage independently tested and committed.
