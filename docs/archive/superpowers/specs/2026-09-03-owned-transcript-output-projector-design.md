# Owned Transcript Output Projector Extraction

## Purpose

Make the three observation paths in `PromptRunWorkflow` interpret output from
an already-owned TraeX transcript turn consistently. Attached polling, detached
observation, and the final transcript drain currently each coordinate answer
chunk retention, terminal lifecycle retention, and `TurnOutputObserved` event
payload construction.

## Scope

Create a pure `owned-transcript-output-projector` that accepts an observation
already proven to belong to the current prompt plus an in-memory output state.
It returns:

- updated answer chunks and whether safe answer output was observed;
- a retained completed or aborted transcript lifecycle, when present; and
- an optional normalized `TurnOutputObserved` payload for answer output, tool
  activity, main status heading, plan steps, and token count.

Elapsed time remains computed at the application boundary from the clock and
the known turn start time. The projector receives that derived value, rather
than reading a clock.

## Boundaries

`PromptRunWorkflow` continues to own transcript opening and reads, duplicate
signature suppression, exact turn ownership/claiming, conflict logging, loop
control, lifecycle event publication, SQLite transitions, final answer choice,
and no-replay failure handling.

The new projector does not read from a cursor, call SQLite, publish events,
know a binding or prompt ID, decide transcript ownership, or decide whether a
turn is complete. It only transforms already-owned safe transcript output.

## Invariants

- Output is accumulated only after exact transcript ownership is established.
- Unowned output, including a conflicting later turn, remains ignored.
- A terminal lifecycle is retained only for `completed` or `aborted` states.
- Empty observations produce no event payload.
- Tool activity and main status are projected without leaking transcript
  reasoning or raw protocol data; they use the parser's existing safe fields.
- This refactor does not modify FIFO, dispatch confirmation, detached observer
  recovery, or terminal Prompt state transitions.

## Verification

Add direct projector tests for answer accumulation, terminal retention, empty
observations, tool activity, status heading, plans, token count, and elapsed
time. Retain focused transcript, prompt lifecycle, prompt safety scan, and
observer tests to prove integration behavior remains unchanged. Run typecheck,
build, and `git diff --check` before the implementation commit.
