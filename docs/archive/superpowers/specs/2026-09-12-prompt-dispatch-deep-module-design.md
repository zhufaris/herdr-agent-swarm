# Prompt Dispatch Deep Module Design

## Goal

Move Primary FIFO dispatch, exact turn ownership, and attached terminal
settlement out of `SqlitePromptStore` into one deep SQLite module while
preserving no-replay and projection behavior.

## Problem

The remaining runtime cluster determines whether a queued Prompt may execute and
whether a later observation belongs to that exact execution. Its implementation
currently shares a general store with queue feedback, startup view repair, model
preference commands, and session cancellation. The runtime cluster owns:

- atomic FIFO/priority claim against an active idle Binding;
- pinning a pending model revision to the claimed Prompt;
- recording prompt submission acceptance;
- preparing, accepting, or safely rolling back the model command fence;
- claiming the exact native transcript turn after the dispatch timestamp;
- completing or failing the Prompt and freezing its final Worker context.

These transitions are one safety protocol. Splitting them across shallow
repositories would make callers coordinate whether an effect may have reached
TraeX, which would weaken the no-replay invariant.

## Selected module

Introduce `SqlitePromptDispatchStore` over the shared `SqliteContext`. It owns
`claimNextDispatchablePrompt`, `markPromptDispatched`,
`markModelPromptPrepared`, `markModelPromptAccepted`,
`rollbackPreparedModelPrompt`, `claimPromptTranscriptTurn`, `updatePrompt`,
`completeTurn`, and `failPrompt`. It also owns `getPrompt` and
`getActiveOrdinaryPrompt`, the identity queries needed by dispatch and exact-turn
consumers.

The module receives existing Binding transition, projection, card-context, and
outbox collaborators. Terminal settlement remains a single transaction across
Prompt state, Binding state/fingerprint, Run Card, Topic View, and frozen Worker
summary. Model dispatch state remains atomic across the Prompt and model
preference rows.

`SqlitePromptCapabilityStore`, external-turn observation, turn control, instance
tools, outbox lookup, and the test compatibility kernel delegate these operations
to the graph-owned dispatch module. Application ports remain unchanged for this
slice.

## Alternatives

### Separate claim, model dispatch, transcript ownership, and settlement

This would create several small classes but expose one safety state machine
through multiple interfaces. The deletion test fails: removing any one class
would spread its fence choreography into callers.

### Keep terminal settlement with projection storage

Run Card projection is part of settlement, but Prompt execution owns when a turn
is terminal and which exact Prompt is affected. Moving that decision to a generic
projection module would invert dependency direction.

### Move queue feedback and model preference commands too

Those are adjacent but not part of the execution protocol. Queue feedback is a
read/projection concern; accepting a future model preference is a control command.
They stay out so the dispatch interface expresses only the lifecycle of one
execution.

## Invariants

- At most one ordinary Prompt is running per Binding.
- Claim order remains priority first, then creation order and row order.
- Binding must be active, attached, pane-backed, and observed idle/done at claim.
- A model revision is pinned to exactly one claimed Prompt and all prepare/accept/
  rollback transitions retain their compare-and-swap fences.
- A Prompt is considered dispatched only after a valid canonical timestamp.
- Transcript ownership rejects starts before dispatch tolerance and conflicts
  with another native turn identity.
- Completion/failure updates Prompt, Binding, Run Card, Topic View, and frozen
  Worker context atomically.
- Work that may have reached TraeX is never requeued by this module.
- The module creates no connection and no migration.

## Testing

Add an architecture test requiring the runtime methods to leave
`prompt-store.ts`, live in `prompt-dispatch-store.ts`, and be delegated from all
capability adapters. Existing tests cover FIFO/priority order, model fences,
submission timestamps, transcript ownership, completion/failure projection,
Worker context freezing, steering, and concurrency. Run focused tests,
typecheck, build, the full suite, and `git diff --check`.

## Non-goals

- No changes to coordinator logic, Herdr commands, recovery, external adoption,
  queue feedback, model preference input, cards, schema, or visible text.
- No installation or production restart.
