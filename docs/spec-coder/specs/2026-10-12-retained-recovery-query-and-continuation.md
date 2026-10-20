# Retained Recovery Continuation

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Retained Session Activity recovery is now bounded to two pages per startup
pass, but production evidence shows each 129-row candidate page still takes
approximately 0.47–0.49 seconds in a read-only SQLite run. `EXPLAIN QUERY PLAN`
shows the query begins with every `tool_result` in each retained producer's
session and only afterward joins its `tool_call`, even though the three relevant
multi-agent call names are sparse. Each candidate also executes identity and
already-projected probes before the final ordered limit.

The two-page bound currently signals continuation by throwing
`Retained multi-agent Session Activity recovery requires another bounded full
rescan`. Startup therefore records a normal yield as
`startup-recovery-stage-failed`; background passes emit repeated
`startup-retained-session-activity-recovery-bounded` warnings. Final status
recovers to completed, but logs and intermediate diagnostics incorrectly model
progress as failure.

## Solution

Replace exception-driven expected continuation with a structured
  `StartupViewConvergenceResult` containing `failedBindingIds` and
  `fullRescanRequired`. Initial startup records the stage as completed and asks
  the existing `StartupViewRecovery` to continue. Background full rescans keep
  `fullRescanPending` when more retained pages remain, while `lastFailure`
  remains reserved for actual failed Bindings or thrown errors. Remove the
  warning emitted for each expected page-budget yield; bounded progress remains
  observable through startup-view diagnostics.

The structured-continuation approach was auto-selected under explicit
autonomous authority. Query-only alternatives were rejected after the
implementation benchmark: the full source call-first query regressed to
585–615 ms and result-first two-phase loading improved only to 461–483 ms,
within noise versus the 470–492 ms baseline. A meaningful query improvement
would require a separately justified index/schema trade-off. Retaining
exception-driven continuation preserves recovery but misclassifies normal
backpressure and produces warning noise.

## User Stories

### SCN-2: Initial bounded continuation is not a startup failure

When two recovery pages are consumed and more remain, `view-convergence`
completes successfully with `fullRescanRequired=true`. Startup recovery queues
one existing full rescan and does not log a failed stage or set a failure
message merely because the page budget was reached.

### SCN-3: Background continuation remains lossless and observable

Each background full rescan resumes from the current retained cursor. If more
pages remain, `fullRescanPending` stays true and another bounded retry is
scheduled. When the final page completes, pending state clears. Actual Binding
failures and thrown errors still retain backoff and failure diagnostics.

## Implementation Decisions

### INV-2: A page-budget yield is progress, not failure

`StartupViewConverger.converge()` returns a structured immutable result. More
retained pages set `fullRescanRequired=true`; failed per-Binding projection
remains in `failedBindingIds`. Worker/Turn Card convergence failures and
unexpected exceptions still reject normally.

### INV-3: StartupViewRecovery remains the only retry owner

`StartupViewRecovery` consumes the structured full-rescan result. It requeues
`fullRescanPending` without setting `lastFailure` for expected continuation,
increments bounded retry diagnostics, and schedules through its existing timer.
It still backs off on failed Bindings and thrown errors and preserves bounded
pending-ID behavior.

### ARCH-2: Deepen the existing startup convergence result

The structured result replaces an overloaded exception rather than adding a
new queue, callback, worker, or persistence record. `StartupRecoveryWorkflow`
coordinates the initial result; `StartupViewRecovery` owns background retries.
Composition and source dependency direction remain unchanged.

## Testing Decisions

References: SCN-2, SCN-3, INV-2, INV-3, ARCH-2

- Update `StartupViewConverger` tests so page-budget continuation returns
  `{fullRescanRequired:true}` rather than throwing, and final pages return
  false with the same cursor progression.
- Add `StartupViewRecovery` tests proving structured full-rescan continuation
  stays in `retry_wait` with `lastFailure=null`, schedules the next pass, and
  clears after completion. Preserve failed-Binding and thrown-error behavior.
- Add `StartupRecoveryWorkflow` coverage proving initial bounded continuation
  leaves `view-convergence` completed, starts normal background recovery, and
  does not emit a startup-stage failure.
- Run affected suites, typecheck, build, architecture/docs checks, full Vitest,
  and delivery artifact validation. After deployment compare startup stage
  duration, retry diagnostics, warning events, backlog, and delivery latency.

## Out of Scope

No retained-recovery SQL reordering, schema migration, expression index,
retained cursor format change, page-size or two-page budget change, Session
Activity projection semantics, new retry worker/timer/table, global startup
redesign, Delivery replay, or unrelated SQLite query optimization is included.

## Further Notes

Workspace mode: in-place work inside the existing isolated clean worktree
`/tmp/herdr-agent-swarm-main-ring-stability-20261012`, branch `main`, starting
revision `68c60e2eff00bcda683f8f712803a35fe3d85a61`. The original user checkout
remains untouched. Locked dependencies were present and `npm ls --depth=0`
passed.

Fresh baseline records for request `round-20261012-retained-recovery-query`:

```spec-coder-verification
{"record_id":"df4c37324083438dba05d13169032a82","command":["/usr/bin/npx","vitest","run","tests/session-activity-store.test.ts","tests/startup-view-converger.test.ts","tests/startup-view-recovery.test.ts","tests/startup-recovery-workflow.test.ts"],"exit_code":0,"status":"captured","observed_at":"2026-10-12T20:16:36.874575+00:00","result":"4 files and 74 tests passed"}
```

```spec-coder-verification
{"record_id":"fe101eb8069940728c74aafc5a971b97","command":["/usr/bin/npm","run","typecheck"],"exit_code":0,"status":"captured","observed_at":"2026-10-12T20:16:53.236638+00:00"}
```

```spec-coder-verification
{"record_id":"ab166ba06ab24fe5a00360e94969e4ed","command":["/usr/bin/npm","run","build"],"exit_code":0,"status":"captured","observed_at":"2026-10-12T20:17:06.706956+00:00","build_id":"sha256:3468e33c8d9dd3170e5cbc66377ffaaaf5f8601476888d05bd334c57b6e00d51"}
```

The production benchmark used read-only SQLite connections and emitted only
IDs, JSON lengths, timings, query plans, and result hashes. All variants
produced equal result hashes. Simplified call-first evidence appeared faster,
but the full source query benchmark proved a regression; the source change was
discarded before any commit. This evidence reopened Gate 1 and auto-selected
structured continuation as the only remaining grounded recommendation. No
glossary or ADR change is warranted.
