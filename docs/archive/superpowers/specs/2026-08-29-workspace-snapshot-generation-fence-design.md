# Workspace Snapshot Generation Fence Design

## Status

Approved for implementation. The user authorized the recommended approach to
proceed without per-batch confirmation.

## Problem

`WorkspaceSnapshotCache.invalidate()` removes cached data after a pane mutation
or socket event, but it cannot stop a snapshot request that was already in
flight. That older request can finish later and repopulate the cache with the
pre-mutation pane list. Calls made after invalidation can also coalesce onto the
stale in-flight request. The stale result may then hide a created, renamed, or
closed pane for the full cache TTL.

Both workspace-scoped refreshes and `listAllPanes()` have this race.

## Goals

1. Prevent any refresh started before invalidation from repopulating cache.
2. Prevent reads started after invalidation from coalescing onto stale work.
3. Preserve coalescing among callers in the same generation.
4. Preserve defensive copies, TTL behavior, fallback behavior, and the Herdr
   port contract.
5. Avoid cancellation requirements in the underlying Herdr adapter.

## Selected design

The cache owns monotonic generations:

- one global generation for all-workspace snapshots;
- one reset generation that changes on `invalidateAll()`;
- one generation per workspace for targeted invalidation.

Each in-flight refresh is stored with the generations captured when it began. A
caller coalesces only when the stored generation still matches the current
generation. If invalidation happens while a request is unresolved, a later
caller starts a new refresh. Completion caches the result only when its captured
generation is still current. An old refresh clears the in-flight slot only when
that slot still refers to the same refresh, so it cannot erase a newer request.

Any targeted invalidation advances both that workspace generation and the
all-workspace generation. `invalidateAll()` advances the reset and
all-workspace generations. A completed all-workspace request is committed as one
snapshot only when its global generation is unchanged; otherwise none of its
workspace projections are cached.

The original caller may still receive the result of the request it initiated.
The fence controls shared cache publication and post-invalidation coalescing; it
does not pretend to cancel an external request already in progress.

## Alternatives rejected

- Delete only the cached snapshot: this is the current behavior and permits
  stale repopulation.
- Delete the in-flight promise without a generation: the old promise can still
  publish on completion, and its `finally` can delete a newer promise.
- Abort Herdr snapshot commands: the port has no cancellation contract and the
  cache does not need cancellation to guarantee publication safety.
- Serialize mutations behind refreshes: increases mutation latency and still
  returns stale observations at the wrong boundary.

## Tests and acceptance

- A workspace refresh started before `invalidate(workspaceId)` does not cache
  its result.
- A post-invalidation read starts a new refresh instead of joining the old one.
- The old refresh settling does not remove the new in-flight refresh.
- An all-workspace refresh invalidated by a targeted mutation does not rebuild
  `allSnapshot`, workspace snapshots, or pane-to-workspace indexes.
- Existing same-generation coalescing, TTL, mutation invalidation, fallback,
  and defensive-copy tests continue to pass.
- Focused tests, typecheck, build, and the full Vitest suite pass.

## Non-goals

- Cancelling Herdr CLI or socket requests.
- Persisting cache generations across process restarts.
- Changing the cache TTL or health/readiness caching.
- Deploying while unrelated uncommitted runtime source would be included in the
  build.
