# Session Reconciler Module Implementation Plan

## Objective

Implement the approved `SessionReconciler` design in
`docs/superpowers/specs/2026-08-23-session-reconciler-module-design.md`. Move
reconciliation state and behavior behind a small lifecycle interface without
changing Pane discovery, orphan handling, terminal observation, prompt
execution, or shutdown semantics.

## Task 1: Establish the reconciler contract with tests

Create `tests/session-reconciler.test.ts` around the public interface. Start with
tests for overlapping-call single-flight, one workspace scan per pass,
idempotent timer lifecycle, and `stop()` waiting for an in-flight pass. Use real
`SqliteBindingStore` state and narrow fake ports so the tests exercise the module
seam rather than coordinator internals.

## Task 2: Move reconciliation state and the basic pass

Create `src/coordinator/session-reconciler.ts`. Move the timer, reconciliation
Promise, observed agent states, observed terminal outputs, skipped-Pane reasons,
workspace scans, and pass-local binding map into the new module. Implement
`captureBaselines`, `reconcile`, `start`, and `stop`, preserving current
single-flight and error-logging behavior.

## Task 3: Move missing-Pane and observation behavior

Move missing/unavailable Pane degradation, scoped run-card transitions, terminal
identity validation, agent-state publication, and changed local-output
publication. Add direct tests for unavailable workspaces, missing Panes, terminal
identity replacement, local output changes while idle, and busy bindings being
skipped. Preserve exact lifecycle events and user-facing notices.

## Task 4: Move discovery behavior behind narrow collaborators

Move registered-Pane matching, ambiguous/unregistered skip logging, and
interrupted-provisioning detection. Inject `discoverPane`, `scheduleBinding`, and
`isBindingBusy` collaborators. Change coordinator discovery to return the
created binding, then prove the pass-local Pane map is updated without another
complete store scan.

## Task 5: Integrate coordinator startup and shutdown

Construct one reconciler inside `SyncCoordinator`. Replace coordinator-owned
baseline capture, explicit reconcile calls, timer setup, observation maps, and
reconciliation shutdown waiting with the reconciler lifecycle methods. Keep
prompt/steering workers and active-run abort control in the coordinator. Remove
only code and imports made obsolete by the extraction.

## Task 6: Verify and deploy safely

Run direct reconciler tests plus existing discovery, lifecycle, concurrency,
store, projector, and shutdown tests. Then run the complete suite, typecheck,
build, and `git diff --check` from an isolated `HEAD + staged diff` snapshot if
unrelated worktree changes remain. Commit only the reconciler refactor. Deploy
from the verified commit only after `running=0` and `pendingOutbox=0`; restart
PM2 and verify `/ready`, Lark connectivity, lease ownership, and durable queue
counts. Never stage or modify `var/`.
