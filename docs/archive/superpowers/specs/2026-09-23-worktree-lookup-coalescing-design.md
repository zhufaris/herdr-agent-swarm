# Worktree Lookup Coalescing

## Goal

Avoid launching duplicate `git rev-parse` subprocesses when concurrent runtime
reconciliation resolves the same Pane working directory before the worktree-name
cache is populated.

## Current problem

`WorktreeNameResolver` caches completed positive and negative lookups with bounded
TTL/LRU behavior. A cache miss immediately starts a Git subprocess, and the result
is cached only after that subprocess settles. Concurrent bindings or Panes with the
same `cwd` can therefore execute identical lookups in parallel during cold startup
or after expiry.

## Chosen design

Add a private in-flight map keyed by exact `cwd`. The first cache miss starts one
lookup Promise. Later callers for that `cwd` await the same Promise. The entry is
removed in `finally` after success or failure, while the existing result cache keeps
its current TTL, negative-cache, LRU, and capacity semantics.

Different working directories remain fully concurrent. The in-flight map cannot
grow beyond the number of distinct concurrently requested directories and retains
no settled Promise. No timeout or cancellation policy changes: the existing command
runner timeout remains authoritative.

## Behavioral boundaries

- Empty working directories still return `null` without a subprocess.
- Git roots still render only their basename; host paths remain hidden.
- Non-Git and temporarily unavailable directories still resolve to cached `null`.
- A failed shared lookup is not thrown to callers and does not poison the in-flight
  map. A later call after the negative-cache TTL may try again.
- No workflow, SQLite, Herdr, Agent, CardKit, or external command contract changes.

## Verification

- Two concurrent calls for one cold `cwd` start exactly one command and receive the
  same result.
- Concurrent calls for different directories remain independent.
- Existing positive, negative, expiry, and LRU tests continue to pass.
- Typecheck, build, documentation audit, public audit, and full tests pass.
