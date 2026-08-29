# Project Space Routing Validation Design

## Problem

`/swarm new` creates a pane in the selected project's configured `workspaceId`.
The production registry currently maps `herdr-agent-swarm` to `wH`, while live
Herdr identifies `wH` as `herdr-lark-bridge` and `wN` as `herdr-agent-swarm`.
The bridge validates only that a workspace ID exists, so this drift is accepted
and every selected project is routed to the wrong Space.

## Design

- Keep `ProjectConfig.workspaceId` as the authoritative creation target.
- Treat `projectSpaceName(project)` as the expected Herdr workspace label.
- At startup, validate each configured project route by fetching its workspace
  and requiring both ID and label to match. Fail startup readiness before Lark
  ingress if either value differs.
- Keep callback routing unchanged: the selected `projectId` resolves to exactly
  that project's `workspaceId` and `cwd`.
- Correct the private production registry from `wH` to `wN`.
- Do not move or close existing panes created under the old mapping.

## Failure behavior

A mismatch reports the project ID, configured workspace ID, expected Space name,
and observed label. It contains no credentials. The service does not begin Lark
message handling with an invalid route.

## Verification

- Adapter tests cover matching and mismatched workspace labels.
- Startup integration verifies every project supplies its expected Space label.
- Existing multi-project selection coverage continues to prove the chosen project
  controls the `createPane(workspaceId, cwd)` call.
- Validate the private registry, run the full suite/typecheck/build, restart only
  with idle workers, and confirm the service is ready with `wN`.
