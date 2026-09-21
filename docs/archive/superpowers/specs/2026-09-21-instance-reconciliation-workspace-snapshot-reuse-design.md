# Instance Reconciliation Workspace Snapshot Reuse

## Goal

Avoid repeated Herdr pane-list reads, pane cloning, and pane-map construction when
multiple configured projects share one Herdr workspace, without changing project
isolation or runtime reconciliation behavior.

## Current problem

`InstanceRuntimeReconciler.reconcileOnce()` iterates configured projects in order.
For every project it calls `PaneHost.listPanes(project.workspaceId)` and builds a
new `Map<paneId, HerdrPane>`. Project routes may share a workspace as long as their
working directories differ, so one reconciliation pass can read and materialize
the same workspace snapshot repeatedly. The lower-level snapshot cache may avoid
some external Herdr calls within its TTL, but every call still clones the panes
and the reconciler still rebuilds the map.

## Selected design

Keep the existing project-order loop and per-project instance query. Add one
execution-local cache keyed by `workspaceId`. The first project for a workspace
calls `PaneHost.listPanes()` and constructs a read-only pane map. Later projects
in the same reconciliation execution reuse the same promise and map.

The cache is scoped to one `reconcileOnce()` call. A later periodic, requested, or
retry reconciliation always obtains a fresh snapshot through the existing
`PaneHost` behavior. Caching the promise ensures one in-flight read per workspace
even if the loop becomes concurrent later, while a rejected promise affects only
the current reconciliation execution and is never retained across executions.

Pane-scoped reconciliation is unchanged. It continues to use one all-pane
snapshot when `snapshotPanes()` is available and otherwise performs targeted
`inspectPane()` calls.

## Preserved behavior

- Projects remain processed in configuration order.
- `listAgentInstances(project.id)` remains project-scoped and runs once per
  eligible project.
- Workspace-scoped requests reconcile only projects whose `workspaceId` was
  requested.
- Instances already handled by a pane-scoped request are not reconciled twice in
  the same execution.
- Pending-runtime attachment, pane identity checks, native TraeX session refresh,
  termination, state observation, Worker wake-up, and card-context wake-up remain
  unchanged.
- A workspace read failure still fails the current reconciliation and is retried
  through the existing priority reconciliation runner.

## Testing

Tests use the public `InstanceRuntimeReconciler.reconcile()` and
`requestReconciliation()` seams with a fake `PaneHost` and reconciliation store.
They prove that:

1. two projects sharing a workspace cause one `listPanes()` call while both
   projects' instances are reconciled;
2. distinct workspaces are each read once;
3. a workspace-scoped request reads only the selected workspace and still
   reconciles every project routed through it; and
4. a failed workspace read is not cached across reconciliation executions.

Existing runtime identity, attachment, termination, observation, scheduling, and
priority-runner tests remain the regression suite.

## Non-goals

- No cross-execution or time-based cache.
- No change to `PaneHost`, `ProjectCatalog`, or store interfaces.
- No batching of project-scoped SQLite instance queries.
- No concurrency or project-order change.
- No change to durable state, delivery, retry, or no-replay behavior.
