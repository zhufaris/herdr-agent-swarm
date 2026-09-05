# Pending Worker Runtime Adoption Design

## Goal

Recover a Worker when `herdr agent start` returned an error or uncertain result
after TraeX actually started in the reserved pane. The reconciler must attach the
already-running runtime so `/to <worker>` can accept work, without starting a
second agent or weakening durable instance identity.

## Observed failure

Worker provisioning persists the pane allocation before invoking the external
agent start command. If that command reports failure after TraeX has started,
the durable instance remains in this state:

```text
desiredState: running
observedState: failed
provisioningCheckpoint: pane-allocated
pendingRuntimeRef: { workspaceId, paneId, generation }
runtimeRef: null
```

The current runtime reconciler immediately skips instances without a
`runtimeRef`. Consequently it never observes or adopts the live agent in the
recorded pending pane, and `/to` correctly rejects the incomplete durable state
as `Target instance is not running`.

## Decision

Extend `InstanceRuntimeReconciler` to reconcile a narrowly eligible pending
runtime before its existing attached-runtime path. An instance is eligible only
when all of the following durable facts hold:

- its role is `worker`;
- its worker session lifecycle is `active`;
- its desired state is `running`;
- it has no `runtimeRef`;
- it has a current-generation `pendingRuntimeRef`;
- its provisioning checkpoint is `pane-allocated` or `runtime-started`.

The reconciler may adopt the pending pane only when the current Herdr snapshot
proves all of these runtime facts:

- the pane exists at the exact pending pane ID;
- the pane belongs to both the pending and configured Herdr workspace;
- the pane cwd exactly matches the instance workspace lease cwd;
- the observed agent kind matches the configured Worker kind through the
  existing compatibility predicate;
- the pane exposes an exact agent session identity.

On a complete match, the reconciler calls the existing transactional
`attachAgentInstanceRuntime` operation with the current instance generation,
pending pane identity, and observed native session ID. That operation promotes
the pending reference to `runtimeRef`, advances provisioning to `verified`,
clears the prior start error, and records the observed runtime as idle through
the normal observation path. If queued turns exist after attachment, the
reconciler wakes that Worker. Card context is also refreshed.

The reconciler never invokes `agent start` while adopting a pending runtime.
This preserves the no-duplicate-start boundary after an uncertain external
command result.

## Failure behavior

Adoption fails closed. A missing pane, workspace mismatch, cwd mismatch, agent
kind mismatch, missing session identity, stale generation, or failed atomic
attach leaves the instance and its pending reference unchanged. Periodic or
event-driven reconciliation can retry after runtime evidence changes.

The reconciler does not terminate the Worker merely because a pending pane is
temporarily absent or incomplete. Existing termination behavior for a previously
attached `runtimeRef` remains unchanged. No pane, process, worktree, queued turn,
or instance record is deleted by this recovery path.

## Tests

Add focused reconciliation tests proving that:

1. A matching idle TraeX process in the exact pending pane is atomically adopted,
   becomes an attached idle runtime, clears the failure, and wakes queued work.
2. Herdr's `codex` runtime label remains compatible with a `traex` Worker during
   pending adoption.
3. Missing session identity prevents adoption.
4. Workspace, cwd, agent-kind, pane-ID, and generation mismatches prevent
   adoption without altering the pending state.
5. The recovery path never calls an agent-start operation.

Verification includes the focused instance reconciliation and messaging suites,
TypeScript type checking, build generation, the full Vitest suite, and a live
read-only check that the existing `test` Worker converges to a `runtimeRef` after
deployment without changing its pane or session identity.

## Scope

This change repairs uncertain Worker startup recovery only. It does not relax
`/to` authorization, make Herdr the durable source of truth, adopt arbitrary
unrecorded panes, retry agent startup, change Worker naming, or delete/recreate
the existing Worker workspace.
