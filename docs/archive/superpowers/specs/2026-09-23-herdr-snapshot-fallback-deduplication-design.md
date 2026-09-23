# Herdr Snapshot Fallback Deduplication

## Goal

Avoid repeating a known-failed all-workspace Herdr snapshot for every configured
workspace during one reconciliation collection.

## Current problem

`HerdrSnapshotCollector.collect()` first requests one all-workspace snapshot. If
that fails, it falls back to `listPanes(workspaceId)` with bounded concurrency.
Both `WorkspaceSnapshotCache.listPanes()` and `HerdrCliAdapter.listPanes()` normally
prefer the all-workspace snapshot before a workspace-specific CLI query. The same
failed global operation can therefore be attempted again at multiple layers for
every workspace, multiplying socket/CLI pressure while Herdr is degraded.

## Chosen design

Extend the existing optional `HerdrPort.listPanes` read options with an internal
`skipAllWorkspaceSnapshot` hint. After `collect()` has direct evidence that the
global snapshot failed, each fallback workspace read sets this hint. The cache
retains its generation, in-flight coalescing, cloning, and completed workspace
snapshot behavior but skips its global-first branch. The adapter skips its own
global-first branch and executes the workspace-specific Pane query directly.

Normal `listPanes` calls do not set the hint and preserve global snapshot reuse.
The next collection still starts with a fresh all-workspace snapshot attempt, so
one failure never becomes a negative cache or suppresses recovery detection.

## Boundaries

- The hint is internal and optional; existing callers and fakes remain compatible.
- Fallback concurrency remains capped at four.
- Workspace results still pass through adapter parsing/enrichment and cache fences.
- Partial workspace failures retain existing diagnostics and do not invalidate
  successful workspace results.
- No Prompt, Agent, SQLite, CardKit, Gateway, or retry semantics change.

## Verification

- With an all-workspace failure and multiple workspaces, one collection issues one
  global attempt and exactly one direct query per workspace.
- A later collection tries the global snapshot again and observes recovery.
- Normal cache calls still prefer and coalesce all-workspace snapshots.
- Typecheck, build, audits, and the complete test suite pass.
