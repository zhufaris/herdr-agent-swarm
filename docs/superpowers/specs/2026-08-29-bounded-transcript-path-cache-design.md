# Bounded Transcript Path Cache Design

## Context

`TraexTranscriptReader` caches the validated filesystem path for every TraeX
session ID it opens. Cache hits are safely revalidated, and missing paths are
removed, but valid historical sessions remain forever. A long-running bridge
that sees many sessions therefore grows `pathsBySessionId` without a bound.

## Decision

Keep the existing validation-on-hit behavior and bound the path cache with
least-recently-used eviction. The default capacity is 256 session IDs and may
be overridden with `maxCachedPaths` for deterministic tests. A valid hit moves
its existing entry to the newest position. A newly discovered path replaces
any prior entry and evicts oldest keys until the capacity is satisfied. Invalid
capacities normalize to at least one entry.

No TTL is added: every hit already validates that the resolved path remains
inside the configured sessions root and contains the requested session ID.
This keeps active sessions hot while bounding memory without creating periodic
directory rescans. Missing, ambiguous, or invalid discoveries are not cached.

## Alternatives

- TTL-only expiry still allows memory to grow with session churn until entries
  are revisited or a background sweep runs.
- Clearing the cache at turn completion requires a new lifecycle coupling and
  loses reuse when a session serves later turns.
- Caching negative discoveries would reduce scans but risks hiding newly
  created transcript files and is outside this change.

## Test Strategy

Use `TraexTranscriptReader.open()` as the seam in a new isolated test file.
Cache two sessions with capacity two, touch the first, then open a third. Add a
duplicate transcript for both original sessions. The recently used first
session must still open through its cached exact path, while the evicted second
session must rescan and report `ambiguous_transcript`. Also retain the existing
transcript suite and run typecheck, the full suite, and production build.
