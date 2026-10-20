# Pane identity and Worker lifecycle projection

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Primary and Worker cards do not consistently show the authoritative Git branch
and worktree identity. Worker Main already stores a branch in its view, but
runtime projection updates do not carry branch changes into an existing view;
Primary Topic/Pane cards expose a worktree name without a branch field.

The Primary worker summary also retains completed subagents in the active worker
list because it selects every active Worker instance, even when its latest task
is terminal and no queued/running/blocked work remains. Completed task history
must remain available in the Worker Main Card, but completed Workers must stop
appearing as active subagents.

## Solution

Introduce one provider-neutral `PaneIdentitySnapshot` containing workspace path,
worktree name, branch, pane ID and pane token. Authoritative workspace leases
and Herdr observations populate the snapshot; Primary Main, Turn/Pane cards,
Worker Main and pane-directory entries consume the same value rather than
reconstructing branch text independently.

Worker Main runtime projection updates carry the branch/worktree snapshot and
increment the view when identity changes. Active Worker summaries include only
Workers with current queued, preparing, running or blocked work, plus active
Workers with no terminal task yet; terminal task history stays in the Worker
Main recent-task section. Terminated/stopped Workers are removed from active
summaries without deleting durable task history or their canonical Worker
Thread.

## User Stories

### SCN-1: A Primary card shows the current pane identity

When the workspace lease or Herdr reconciliation discovers a worktree branch,
the Primary Main/Pane card displays the worktree and branch from the same
snapshot. A branch change updates the card without changing pane identity.

### SCN-2: A Worker Main card refreshes branch identity

When a Worker worktree lease changes after the Worker Main card already exists,
the next projection updates branch/worktree metadata and reserves one ordered
card update. Repeated identical identity observations produce no extra update.

### SCN-3: Completed Workers leave the active subagent list

When a Worker has a terminal latest task and no queued, preparing, running or
blocked task, the Primary card no longer lists it as an active subagent. The
Worker Main Card and recent task history remain navigable and durable.

### SCN-4: Active Worker status remains live

Queued, running and blocked Workers remain listed with their current state and
queue information. A later task reactivates a previously idle Worker without
recreating its identity or losing completed history.

### SCN-5: Model wait and context statistics are observable

When the runtime provides model/context or queue timing data, Primary and Worker
cards expose bounded model usage and wait/first-visible timings. Missing provider
data renders as unavailable rather than an inferred token count. Durable status
and latency diagnostics retain the same bounded values for later diagnosis.

## Implementation Decisions

### Domain Model

`PaneIdentitySnapshot` is an immutable value inside each projected revision, but
the snapshot itself is mutable session state. It contains `workspace`,
`worktreeName`, `branch`, `paneId` and `paneToken`. Workspace lease state is
authoritative for Git worktree branch/cwd; Herdr is authoritative for live pane
ID/token and runtime state. Identity changes increment the owning session/card
view revision and trigger one durable card update; identical observations are
no-ops. A missing branch remains explicit null and is rendered as unavailable,
never inferred from the deployment branch.

Worker lifecycle selection is a projection policy, not destructive cleanup:
terminal Worker Tasks remain durable, while the active subagent summary is
derived from current runnable work and active runtime lifecycle.

`ModelUsageSnapshot` is a separate mutable session projection containing model,
context remaining percentage, optional input/output token counts, queued/first
visible/completed timestamps and derived wait/first-visible durations. Herdr and
TraeX are authoritative for values they actually report; provider queue token
counts are not invented when unavailable. The snapshot is bounded, redacted at
the existing runtime boundary and updates the owning card/status view only when
its values change.

### Architecture

The identity snapshot is assembled at the card-context boundary and passed
through Topic/Worker Main projections and presentation ports. `WorkerMainView`
runtime changes include branch/worktree fields and compare them for idempotent
view updates. Primary TopicView and pane-directory entry contracts receive the
same identity fields. SQL selection remains bounded and deterministic: active
task phases outrank terminal history, while terminal history is read only for
recent-task display.

### Behavior & Failure Modes

Identity changes are durable view revisions and use existing outbox idempotency
and delivery fences. A failed card update leaves the durable view and retryable
outbox intent intact. A completed Worker is hidden from active summaries only
when no current task is runnable; a blocked or queued task prevents removal.
Worker termination freezes its Worker Main view but does not delete history.

### Compatibility & Migration

No schema migration is required. Existing nullable branch/worktree values remain
readable. Existing Worker Main and pane cards keep their current identity fields
and gain the shared branch/worktree projection. Historical completed tasks are
not rewritten or deleted.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, SCN-4, SCN-5

Use pure selector/reducer tests for identity equality, branch changes and
terminal Worker filtering. Use card-context integration tests to prove a lease
branch change reaches Primary/Worker card payloads, repeated identical identity
does not reserve another update, and completed Workers disappear while recent
history remains. Run existing worker-main, topic-view, pane-directory,
card-context and lifecycle suites plus typecheck, build, architecture check and
the full Vitest suite. Add bounded ModelUsageSnapshot reducer/card/status tests
for reported and unavailable token/wait data.

## Out of Scope

Do not change Herdr pane lifecycle commands, Git worktree creation/removal
policy, Worker task retention, Feishu transport, or deployment behavior. Do not
infer identity from the deployment build branch or delete historical Worker
cards.

## Further Notes

Workspace: existing isolated worktree
`<repo-root>/.trae/worktrees/fix/stop-active-turn-deploy`.
Starting revision: `46236e81882842233e3e75c8dc2f7334d178230c`.
Baseline captured in this request: typecheck record `12e271046c7e4cb2a929809a4e9b749a`,
build record `25d8140ed4a644a9bd700b2c5ff029b6`, full-test record
`77e2fcdee7a74a4586ddcef1b8f895be`.

Gate 1 design choice: selected unified `PaneIdentitySnapshot` (option B).
The model observability extension reopened Gate 2/3 and was approved in this
request. Implementation is authorized only through the ticket plan below.
