# Instance Reconciliation Workspace Snapshot Reuse Plan

## Objective

Reuse one Herdr pane snapshot and pane map per workspace within each instance
reconciliation execution while preserving project order, project-scoped instance
queries, retry behavior, and runtime identity decisions.

## Work packages

### 1. Characterize shared-workspace behavior

- Add a public-seam test with two projects sharing one workspace but using
  different working directories.
- Assert one `listPanes()` call and successful reconciliation of both projects'
  instances.
- Run the test red against the current per-project snapshot loop.

### 2. Add execution-local snapshot reuse

- Introduce a `workspaceId`-keyed promise cache inside `reconcileOnce()`.
- On first access, load panes and construct the read-only pane map.
- Reuse the same promise and map for later projects in that workspace.
- Keep pane-scoped handling and project iteration order unchanged.

### 3. Cover scoping and retry boundaries

- Prove distinct workspaces are each loaded once.
- Prove a workspace-scoped request covers every project in that workspace and
  does not read other workspaces.
- Prove a failed read is retried with a fresh `listPanes()` call on the next
  reconciliation execution.

### 4. Verify and finish

- Run the focused reconciler and priority-runner tests.
- Run typecheck, build, documentation and architecture checks, public audit, and
  the full Vitest suite.
- Review the final diff against the approved design, archive the completed design
  and plan, and commit without pushing, installing, or restarting.
