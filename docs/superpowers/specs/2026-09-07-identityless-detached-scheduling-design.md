# Identityless Detached Prompt Scheduling Design

## Goal

Remove process-local tracking for detached prompts that lack an exact transcript
identity while preserving the no-replay and fail-closed recovery contract.

## Options considered

1. Keep `legacyDetachedWithoutIdentity` in `PromptRunWorkflow`. This suppresses
   repeated observer attempts only within one process and makes the workflow
   compensate for an overly broad durable work query.
2. Automatically fail identityless detached prompts during startup. This clears
   the FIFO, but incorrectly decides an unknown runtime outcome without an
   operator action or authoritative terminal binding transition.
3. Filter observer hints at the durable scan boundary. This is selected because
   SQLite already owns durable work eligibility and has the exact identity fields
   needed to make the decision.

## Design

`scanDurablePromptWork()` emits `detached-observer-ready` only when both
`transcript_turn_id` and `transcript_turn_started_at` are present. An identityless
detached prompt remains durable, running, detached, and explicitly uncertain, but
is not repeatedly scheduled into an observer that cannot safely claim output.

`PromptRunWorkflow` removes `legacyDetachedWithoutIdentity`, its warning, and its
pruning loop. Transcript observer cache pruning remains part of the periodic safety
scan under a narrowly named maintenance callback. The observer retains a defensive
identity check so a stale or manually constructed hint still fails closed.

## Recovery behavior

This change does not replay or automatically settle uncertain work. An
identityless detached prompt can still leave the blocking state through existing
explicit or authoritative paths:

- `/swarm awake` may recover external turns using canonical transcript evidence;
- `/swarm skip` may explicitly fail the oldest detached prompt;
- a newer external turn may supersede identityless detached work atomically;
- terminal binding convergence fails detached work with the existing no-replay
  notice.

Ordinary queued prompts remain blocked until one of those paths resolves the
uncertain dispatched prompt.

## Tests

SQLite coverage proves an active identityless detached prompt produces no observer
hint while an exactly identified detached prompt still does. Workflow integration
coverage proves no transcript is opened, no prompt is replayed, and later FIFO work
stays queued. Full tests, typecheck, build, documentation audit, and diff checks run
before commit.
