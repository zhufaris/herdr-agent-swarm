# Herdr Prompt Queue Ownership Design

## Status

Approved. Ordinary Feishu messages are submitted to Herdr immediately as
queued next-turn input. Explicit steering remains the only path that mutates an
active turn.

## Problem

Swarm currently persists an ordinary Feishu message immediately but refuses to
dispatch it while the bound Herdr agent is `working` or `blocked`. The prompt
therefore remains in the Swarm FIFO until the current turn settles.

Herdr already serializes terminal input and accepts `agent prompt` while an
agent is working. However, its agent-event stream currently discards TraeX
`role=user` records. Swarm therefore cannot correlate an early queued
submission with the later native turn, and cannot adopt a turn initiated
directly in Herdr because `requestText` is missing.

## Semantics

- An ordinary Feishu message means “run as a later turn in FIFO order.”
- `/swarm steer <text>` means “inject into this exact active turn.”
- An ordinary message may be submitted to Herdr while the agent is working.
- A blocked approval/question UI is not a prompt queue; ordinary messages stay
  durable in Swarm until the blocked state clears.
- Submission acceptance means the input was queued for the PTY. It does not
  mean a TraeX turn started or completed.
- Once submission may have reached the PTY, Swarm never automatically replays
  it.

## Herdr Core Contract

`agent.prompt` accepts an optional caller-generated `submission_id` and exact
native-session precondition. The response echoes the `submission_id` only
after the terminal actor accepts the complete text-plus-Enter submission.

Core stores a bounded pending-submission record containing:

- submission ID;
- terminal, agent kind, and native session identity;
- a digest of the normalized prompt text;
- FIFO sequence; and
- accepted timestamp.

The prompt body is not duplicated into Core runtime state.

The canonical agent-event payload union gains:

```json
{
  "type": "human_message",
  "message_id": "...",
  "text": "continue",
  "truncated": false,
  "submission_id": "optional-caller-id"
}
```

When the event collector observes a native user message, it matches the oldest
pending submission for the same exact runtime identity and prompt digest. A
match consumes that pending record and attaches its `submission_id`. An
unmatched native user message is still emitted with no submission ID, allowing
Swarm to adopt work initiated directly in Herdr.

Pending submission state is durable. After a Core restart, accepted entries are
observed and correlated but never resent. Session or foreground-process
replacement makes unmatched entries uncertain and prevents them from binding
to the replacement runtime.

## Swarm Flow

1. Persist the inbound Feishu event, prompt job, Answer placeholder, and outbox
   intent atomically.
2. Claim the ordinary prompt in binding FIFO order.
3. Verify binding generation, pane, terminal, agent kind, and native session.
4. Submit it immediately with `submission_id = promptId`, even if the agent is
   `working`; do not submit while `blocked` or runtime identity is unknown.
5. After Herdr acknowledges queue acceptance, mark the prompt as dispatched and
   detached from a concrete turn. This state is not replayable.
6. On `human_message`, bind the matching `submission_id` to its real `turn_id`.
7. Observe assistant/tool/lifecycle events into the prompt's existing Answer.

If `human_message.submission_id` is absent, `ExternalTurnObserver` creates one
Herdr-originated prompt and Answer using the event text. The original human
message establishes ownership and title context but is not rendered as a
duplicate body block.

## Ordering and Concurrency

- Swarm retains one claim lane per binding and submits ordinary prompts in
  SQLite FIFO order.
- Herdr retains submission order per terminal.
- A later accepted submission cannot attach to an earlier native user event.
- Explicit steering has a separate exact-turn lane and never consumes an
  ordinary queued submission.
- Model preference remains pinned to the corresponding Swarm prompt before
  submission and follows that prompt when the native turn ID arrives.

## Failure Handling

- Failure before Herdr accepts the submission returns the prompt to queued.
- Connection loss after possible acceptance marks delivery uncertain and does
  not replay.
- A mismatched submission ID, session, turn, or digest is ignored and logged.
- A native user event without a submission ID is treated as Herdr-originated,
  not guessed against a Swarm prompt.
- Existing Core versions without the optional contract retain the current
  wait-until-idle behavior; Swarm must feature-detect support before early
  submission.

## Presentation

- The original Feishu message remains the human-visible request record.
- No standalone `Human message` card is created.
- The initial human message is not duplicated inside the Answer body.
- A Herdr-originated turn creates an Answer card using the native human message
  as request/title context.
- Later native human messages within the same turn may update compact context
  metadata but do not render duplicate prose blocks.

## Tests

Herdr Core tests cover working-state queue acceptance, blocked-state rejection,
FIFO order, idempotent submission IDs, restart/no-replay behavior, exact-session
fences, human-message decoding, matching, and unmatched local input.

Swarm tests cover immediate working-state dispatch, compatibility fallback,
accepted-but-unbound recovery, submission-to-turn binding, external Herdr turn
adoption, duplicate event delivery, model-revision pinning, Answer projection,
and no standalone Human Message card.
