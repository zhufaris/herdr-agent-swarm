# Bounded Native Read Negative Cache Design

## Context

`HerdrCliAdapter` prefers the native `agent.read` RPC and falls back to
`herdr pane read` when Herdr reports `agent_not_found`. The adapter currently
stores those negative results forever in an unbounded `Set`. That avoids an RPC
storm, but it also permanently disables native reads when a pane later becomes
an agent target or a pane identifier is reused. A long-running bridge can also
retain every rejected pane identifier it has observed.

## Decision

Replace the permanent set with a TTL-aware least-recently-used map. Each entry
records the time until which native reads are known to be unsupported. The
defaults are a 30-second TTL and 256 entries. Tests may inject a clock and
smaller limits through an optional final constructor argument; existing
constructor calls remain source-compatible.

Before a read, the adapter handles an entry as follows:

- an unexpired entry skips `agent.read`, moves to the newest LRU position, and
  uses the existing CLI fallback;
- an expired entry is removed, allowing the current read to retry `agent.read`;
- a new `agent_not_found` result is recorded with a fresh TTL;
- unrelated native failures continue to fall back without being cached.

When recording a negative result, expired entries are removed and the oldest
LRU entries are evicted until the configured capacity is satisfied. Cache hits
do not extend TTL, so continued traffic cannot suppress native recovery
forever. No timer or background cleanup task is added.

## Alternatives

1. Keep the permanent set. This preserves the current RPC reduction but keeps
   both the stale-capability and unbounded-memory defects.
2. Add only a TTL. This restores native reads eventually but leaves memory
   proportional to pane churn until entries happen to be revisited.
3. Clear failures from each Herdr snapshot. This couples read behavior to an
   unrelated observation path and can repeatedly retry panes that remain valid
   CLI-only targets.

The bounded TTL-aware LRU is selected because it restores capability
discovery, bounds memory, and preserves suppression during tight observer
loops.

## Compatibility and Failure Behavior

The native and CLI request formats do not change. The CLI remains the fallback
for every native read failure. Cache bookkeeping is in-memory optimization
state only and does not affect SQLite, workflow durability, replay behavior, or
Lark delivery. Invalid test-only limits are normalized to at least one entry
and a non-negative TTL.

## Test Strategy

Use `HerdrCliAdapter.readOutput()` as the behavioral seam:

- retain the existing assertion that repeated reads during the TTL issue only
  one failing native request;
- advance an injected clock beyond the TTL and prove a native read is retried
  and can recover without a CLI call;
- use a two-entry cache, touch one entry, add a third, and prove the least
  recently used negative result is retried while the recently used one remains
  suppressed.

Run the focused adapter suite, TypeScript checking, the full Vitest suite, and
the production build before committing the implementation.
