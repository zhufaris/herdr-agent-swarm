# `/stop` Esc Control and Explicit `/steer` Design

## Goal

Make stop control reliable when TraeX is visible in Herdr but Herdr cannot
classify the pane as a named working agent, and give users an explicit command
for steering an active turn.

## Behavior

- Exact, case-insensitive `/stop` is a local control command. For an active
  binding with an attached pane and an active supervised turn, the bridge sends
  the Herdr `Esc` key to that pane. It does not create a `prompt_jobs` row,
  enter the ordinary FIFO, or depend on Herdr's structured agent state.
- `/stop` is rejected when there is no active supervised turn or the binding is
  not attached and active. The rejection is user-visible and durable through
  the existing standalone feedback path.
- `/steer <text>` is an explicit steering command. It is accepted only with a
  non-empty text payload and an active supervised turn, creates a steering
  prompt attached to that turn, and uses the existing serialized steering
  worker. It never falls back to an ordinary FIFO turn.
- Existing ordinary text behavior remains unchanged. This change does not
  reinterpret arbitrary text as steering.

## Boundaries and failure handling

The command parser owns syntax recognition. `SyncCoordinator` owns binding and
active-turn eligibility. The Herdr adapter owns the transport operation: a
dedicated `sendEscape` port method issues `pane send-keys <pane> Esc`.

`/stop` has no uncertain prompt-delivery state because it is not persisted as a
prompt. If sending Esc fails, the bridge returns a clear failure and leaves the
supervised turn untouched for observation; it must not replay or enqueue a
replacement command.

`/steer` retains the existing durable prompt lifecycle, ordering, and uncertain
delivery handling. A failed or ambiguous steering injection is not replayed
automatically.

## Tests and documentation

- Command parser tests cover exact `/stop`, `/steer text`, empty `/steer`, and
  non-command text.
- Herdr adapter tests verify Esc is sent without checking named-agent state.
- Coordinator integration tests verify `/stop` bypasses queued prompts and
  `/steer text` is delivered through steering while ordinary text remains FIFO.
- User documentation describes `/stop`, `/steer <text>`, and ordinary text as
  separate behaviors.

## Non-goals

This change does not add remote process termination, approval handling, or a
new persistent command table. Herdr remains the local authority for the pane
and TraeX interaction.
