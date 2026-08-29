# Bounded Worktree Name Cache Design

## Status

Approved for implementation under the operator's standing instruction to use
the recommended design without another confirmation gate.

## Problem

`WorktreeNameResolver` caches successful and failed Git-root lookups by cwd with
a TTL, but expired entries are removed only when the same cwd is requested
again. A long-lived bridge that observes continually changing pane directories
can therefore grow the process-level Map without bound.

## Design

Keep the existing 30-second TTL and negative caching. Add a configurable maximum
entry count with a default of 256. On a cache miss, remove all expired entries.
On a live hit, move the entry to the end of the Map without extending its TTL,
making insertion order an LRU order. After inserting a resolved value, evict
oldest entries until the cache is within its limit. Clamp the configured limit
to at least one entry.

No timer or lifecycle hook is added. Cleanup cost occurs only when resolution
already enters the cache path, and the maximum scan is bounded by the cache
capacity. Git command behavior and path-redaction behavior remain unchanged.

## Testing

Use an injected clock and a capacity of two to prove live hits avoid Git, an LRU
hit protects the recently used entry, the oldest entry is re-resolved after
overflow, and expired entries do not consume capacity. Retain the existing
negative-cache test.

## Deployment

This is process-local and needs no migration. Do not restart production while
unrelated runtime source remains uncommitted.
