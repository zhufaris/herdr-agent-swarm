# Topic View Durable Authority Design

## Goal

Prevent lifecycle projection from overwriting newer Worker context written to a
Primary Main Card view. SQLite must remain the only authoritative current Topic
View; process-local state may accelerate delivery but cannot be another writable
projection source.

## Decision

Remove the process-local Topic View LRU from `ConversationViewProjector`. For
every Bridge lifecycle event, the projector loads the current Topic View from
SQLite, reduces the event over that durable state, and saves the result before
returning to the event loop.

The existing per-Binding keyed work queue still orders lifecycle events. The
load/reduce/save sequence contains no asynchronous boundary, so another
process-local workflow cannot interleave between its read and write. The
single-instance lease remains the cross-process writer fence.

Answer-length caching remains bounded and process-local because it is only a
scheduling optimization; it is not canonical card content. Cache diagnostics
retain the existing shape with `topicViews: 0` for compatibility.

## Version and delivery semantics

- `viewVersion` continues to advance only through the existing reducer.
- `workerDependencyRevision`, Worker summaries, and overflow count are preserved
  when later lifecycle events are reduced.
- Main Card scheduling and delivery identity do not change.
- Terminal lifecycle events no longer require cache eviction because no Topic
  View cache exists.
- Startup and restart behavior remain based on SQLite projections.

## Verification

An integration test first publishes a lifecycle event, then applies a real
Primary card-context rebuild containing Worker summaries, then publishes another
lifecycle event. It asserts that the summaries and dependency revision survive
and the view version advances monotonically. Existing event ordering, terminal
projection, Main Card scheduling, and cache-diagnostic tests remain green.

The final gate is focused event/card-context integration tests, typecheck, build,
architecture checks, the complete Vitest suite, and `git diff --check`.

## Non-goals

- Adding a multi-process projection CAS protocol.
- Changing Worker context invalidation or rendering.
- Removing the Answer-length scheduling cache.
- Installing or restarting the service.
