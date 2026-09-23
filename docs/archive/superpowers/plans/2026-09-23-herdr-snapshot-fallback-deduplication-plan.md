# Herdr Snapshot Fallback Deduplication Implementation Plan

## Objective

Carry one collection-scoped global-failure hint through the Herdr read stack so
workspace fallback does not retry the same failed operation.

## Work packages

### 1. Reproduce the amplified fallback

- Build a focused collector test with a Herdr port that records one failed global
  call and per-workspace reads.
- Assert each fallback call requests direct workspace mode and a later collection
  still retries the global operation.
- Run the test red against the current collector.

### 2. Thread the narrow read hint

- Extend `HerdrPort.listPanes` options with `skipAllWorkspaceSnapshot`.
- Set it only in `HerdrSnapshotCollector` after its own global snapshot fails.
- Preserve it through `HerdrCircuitBreaker` and `WorkspaceSnapshotCache`.
- Make `HerdrCliAdapter.listPanes` bypass only its global-first attempt when set.

### 3. Verify and commit

- Run collector, cache, adapter, and circuit-breaker focused tests.
- Run typecheck, build, docs audit, public audit, and all tests.
- Archive the completed design and plan, review the diff, and commit without
  deployment or push.
