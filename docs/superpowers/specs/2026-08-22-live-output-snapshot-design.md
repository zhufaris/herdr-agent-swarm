# Live Output Snapshot Design

## Goal

Keep the request card and project main card aligned with the latest visible
TraeX output while a turn is running. Terminal refreshes such as elapsed time,
token count, and the current task list must update existing card content rather
than accumulate repeated copies.

## Behavior

Each `TurnOutputObserved` event carries the complete safe, user-visible output
snapshot for the current turn. The run-card reducer replaces its live answer
with that snapshot. The project-card projection mirrors the same latest value.
Receiving the same snapshot twice is a no-op and does not increment the view
version or schedule another card update.

Structured `<herdr_progress>` steps remain snapshot data: the newest valid plan
replaces the previous plan as a whole. A new turn clears both live output and
progress. `TurnCompleted` replaces the live snapshot with the final extracted
answer, preserving the existing completion behavior.

## Data Contract

Rename the live payload from `answerDelta` to `answerSnapshot` across the parser,
bridge event, card-projector change, and reducers. The name makes replacement
semantics explicit and prevents future callers from treating terminal snapshots
as append-only text.

`parseTraexOutput(previousRaw, currentRaw, workspaceRoot)` may still use the
previous terminal sample to reject unsafe changes and suppress unchanged
observations, but its visible answer result is derived from the complete latest
answer block. It must never return a repeated fragment merely because terminal
rendering changed around that block.

## Compatibility and Safety

The change affects only live display state. Persisted final answers, request
queueing, steering, structured progress, output safety filtering, and the
2,500-character project-card preview limit remain unchanged. Existing persisted
run cards need no migration because the stored `answer` column already represents
the current materialized view rather than an event log.

## Verification

Parser tests cover a TraeX status frame whose timer and token count change while
the task list remains structurally the same. Reducer tests apply two successive
snapshots and assert that only the newest one is stored, then apply an identical
snapshot and assert object identity and `viewVersion` remain unchanged. Topic-view
tests assert the project-card preview also replaces rather than appends. Existing
completion tests continue to prove that the final answer supersedes the live
snapshot.

### Message semantics

The bridge treats visible state according to its lifecycle semantics:

- Snapshot state is replaced in place: live TraeX output, structured steps,
  queue position, agent state, and approval notices.
- Terminal state supersedes live state: final answers, failures, and steering
  delivery acknowledgements.
- Historical records remain independent: the original request, each request's
  own card, completed answers from earlier turns, audits, and failure records.

Structured progress and live prose are separate snapshots. Updating one must not
erase the other. Tool activity, reasoning, command JSON, and credential-shaped
content remain filtered. Non-text inbound Feishu messages remain outside this
change and continue to be ignored.
