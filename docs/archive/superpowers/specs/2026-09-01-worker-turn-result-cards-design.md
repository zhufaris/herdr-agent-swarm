# Worker Turn Result Cards Design

## Goal

Make every task sent to a Worker visible and traceable from Feishu. A user can
submit several tasks, see each task move through its durable lifecycle, read the
complete Worker output, add guidance to the active task, and continue a finished
task without confusing it with other work assigned to the same Worker.

The design preserves the existing safety rule: if a prompt may have reached an
agent, neither a card-delivery failure nor a Bridge restart may submit it again.

## Product Model

Use one evolving task card per `InstanceTurn`. Do not use one permanent output
card per Worker, and do not create separate acknowledgement and result cards.

- `/to reviewer <text>` always creates a new ordinary turn and a new task card.
  Later turns remain in the Worker's FIFO queue.
- `/steer reviewer <text>` targets only the current active turn. It never creates
  an ordinary turn and never silently falls back to `/to`.
- Replying to a task card while that turn is active is contextual steering.
- Replying to a settled task card (`completed`, `failed`, or `cancelled`) creates
  a new `followup` turn linked to that card's turn. The follow-up receives its
  own task card and FIFO position.
- `/instance reviewer` remains a Worker directory/detail view. It shows current
  state and a compact recent-turn list, not complete result bodies.

Every task card is posted in the same Feishu topic as the `/to` command or
contextual follow-up. This keeps the request and result adjacent without creating
a noisy permanent topic for the Worker.

## Task Card Experience

The card title is `<Worker name> · Task <short turn ID>`. Its stable metadata is
the Worker name, full turn ID, submitting actor, request text, creation time, and
optional parent turn. Its mutable projection contains state, queue position,
start/finish time, bounded progress, error guidance, and output.

The same main card converges through these states:

1. `queued`: accepted durably, with its current FIFO position.
2. `claimed` or `dispatching`: preparing delivery to the Worker.
3. `running`: the exact agent turn has been observed after dispatch.
4. `blocked`: the Worker needs local attention or approval in Herdr.
5. `completed`: final output is shown.
6. `failed`, `cancelled`, or `dispatch-uncertain`: a terminal or safety state with
   an explicit explanation.

The main card contains the first result page. Long results use the existing
answer-page principles: continuation cards carry page 2 onward, a finished page
is immutable, and all operations for one task are ordered in a turn-specific
outbox lane. A terminal redraw may update only the still-active page. Results are
not truncated to the current 240-character Worker-detail preview.

The card exposes `View Worker`. `Continue this task` is explanatory rather than
a text-entry button: the user replies to the card and mentions the bot. Remote
stop and approval controls remain out of scope.

## Durable Model

`instance_turns` remains the source of truth for execution. Extend it with:

- `parent_turn_id`, nullable; transactional Store validation restricts it to a
  same-project, same-instance settled turn when `kind = 'followup'`;
- `source_message_id`, the inbound Feishu message that created the turn;
- exact runtime turn identity and start time needed to fence transcript output;
- an output cursor or equivalent durable observation checkpoint.

Add a dedicated Worker-turn card projection rather than placing delivery state
on `instance_turns`. The projection owns the topic root, main-card message/CardKit
identities, current page, render version, delivered version, and page records.
This keeps execution state independent from Feishu transport while allowing the
projection to survive restart.

Turn acceptance and initial card intent are one SQLite transaction. Each later
turn-state or output transition updates the turn/projection and reserves the
corresponding outbox intent atomically. Feishu delivery checkpoints only attach
message and card IDs to the projection; they do not mutate execution state.

Use a distinct `worker-turn:<turnId>` lane for ordered creates, streams, and
updates belonging to one task. Different turns remain independent, so a malformed
card for task A cannot quarantine task B. Existing independent `reply:<id>` lanes
remain correct for unrelated directory and rejection cards.

No migration attempts to manufacture cards for historical turns. Existing rows
remain readable in `/instance`; only turns accepted after the projection schema
is installed are guaranteed a live task card.

## Authoritative Output Capture

A successful driver dispatch is not a completed answer. The current
`DispatchReceipt.runtimeCursor` and recovery placeholder such as `observed:idle`
must not be rendered as Worker output.

For structured agents, add a Worker transcript observer analogous to the Primary
prompt observer. It must claim the exact transcript turn produced by the
dispatch, persist that identity on `InstanceTurn`, and accept deltas, lifecycle,
and completion only while pane identity and instance generation still match.
The observer incrementally appends sanitized output to the card projection and
persists the final answer in `instance_turns.result`. A conflicting or unowned
transcript turn is ignored.

For an agent kind without trustworthy structured output, the task card shows
delivery and runtime state but explicitly marks result capture as unavailable.
It must not scrape arbitrary terminal scrollback and present it as the answer.
Capability-aware rendering therefore distinguishes execution completion from
captured-result completion.

On restart, an exact owned transcript identity may be reopened and observed
without calling `submit`. Without exact identity, an ambiguous in-flight turn
stays `dispatch-uncertain`; it is not assigned output from a later agent turn.

## Message Routing

Feishu normalization must retain the direct parent message ID in addition to the
topic/root ID. The Store resolves that parent ID against delivered Worker task
cards. Topic membership alone is insufficient because several task cards can
exist in one topic.

For an operator-authored reply that mentions the bot:

- if the direct parent maps to the current-generation active turn, submit an
  idempotent `steer` operation against that exact turn;
- if it maps to a settled turn, atomically create a `followup` with
  `parent_turn_id` and its initial card intent;
- if it maps to a queued or `dispatch-uncertain` turn, reject the ambiguous
  mutation and instruct the user to use `/to` only after the unresolved work is
  cleared;
- if no exact delivered-card mapping exists, do not guess from the selected
  Worker or topic; continue through existing command/ordinary-message routing.

Explicit `/to` and `/steer` remain available and take precedence over contextual
reply inference. Inbound message ID or card-action ID supplies idempotency.

Steering records a bounded event on the parent turn so its task card can state
that supplemental guidance was accepted. It does not create another result card.
If there is no unique active turn, steering returns `not-active` and recommends
`/to`; it never changes intent automatically.

## Projection and Event Flow

Introduce a Worker-turn projector subscribed to durable instance-turn changes.
All state writers continue to use Store transitions; the interaction workflow,
scheduler, supervisor, and transcript observer do not call Lark directly.

The flow is:

1. The interaction workflow atomically accepts the turn and reserves its queued
   task-card create intent, then wakes the scheduler.
2. The publisher creates the card in the command's topic and checkpoints the
   returned message/CardKit IDs.
3. Scheduler and supervisor transitions update the durable projection and reserve
   versioned card updates.
4. The transcript observer appends owned, sanitized output and reserves bounded
   stream updates or continuation pages.
5. Completion freezes output pages, renders the terminal task state, and wakes
   the next FIFO turn.

Queue-position changes are batched when a preceding task completes so queued
cards converge without generating one transport request per internal event.
Outbox coalescing may replace stale pending renders, but delivered versions and
CardKit stream sequence remain monotonic.

## Worker Detail Card

`/instance <worker>` continues to show runtime identity, capabilities, state,
queue depth, and controls. Replace the single truncated `RECENT RESULT` field
with a bounded recent-turn list containing short turn ID, state, creation time,
request summary, result summary, and whether the result was captured.

Where the Lark interaction surface supports a safe callback, selecting a recent
turn renders or refreshes that turn's detail card. The detail view must use the
durable turn/card projection; it does not rerun or re-observe the task merely to
display history.

## Failure and Recovery Semantics

- A task-card delivery failure retries or quarantines only the
  `worker-turn:<turnId>` lane. It never repeats the Worker prompt.
- `dispatch-uncertain` says the prompt may have reached the Worker and automatic
  replay is disabled. Later FIFO work remains behind that unresolved generation.
- Human interruption updates the active turn to an explicit interrupted terminal
  state only after the runtime outcome is durably known. If it is not known, the
  turn remains uncertain. Queued tasks do not bypass it.
- A missing or mismatched pane detaches observation and preserves the no-replay
  fence. Output from another generation cannot update an old card.
- If the initial card has not yet been delivered, state changes update/coalesce
  its pending projection. Once its message identity is known, updates target only
  that card.
- Duplicate inbound messages, callbacks, lifecycle events, and transcript chunks
  converge through stable idempotency keys and view versions.
- Card rendering and errors use the existing redaction and bounded-content paths.
  Reasoning/protocol data and known secret shapes never enter persisted output.

## Scope

This feature includes per-turn cards, complete trusted output capture, FIFO task
submission, explicit and contextual steering, contextual follow-up, recent-turn
navigation, durable recovery, and output pagination.

It does not add a permanent Worker topic, remote approval, force retry, task
reordering, editing a queued task, replaying uncertain work, or backfilling cards
for historical turns.

## Testing and Acceptance

Store and integration tests must prove:

1. `/to reviewer A`, B, and C atomically create three turns and three independent
   card projections while execution remains FIFO.
2. Repeated delivery of one inbound `/to` creates neither a duplicate turn nor a
   duplicate task card.
3. Each lifecycle transition updates only its turn's card and preserves monotonic
   render and stream versions.
4. A failure or quarantine for A's card lane does not block B or any unrelated
   reply; no card retry invokes `AgentRuntimeDriver.submit`.
5. Owned transcript deltas render incrementally and exact completion persists the
   sanitized full result. Conflicting turns and arbitrary terminal text are ignored.
6. Restart resumes card projection and exact transcript observation without
   submitting the prompt again. Missing identity remains uncertain.
7. Explicit `/steer` affects only the unique active turn and creates no new turn;
   no-active and unsupported cases return explicit guidance.
8. A direct reply to an active task card steers that turn. A direct reply to a
   settled card creates one idempotent follow-up with the correct parent. A reply
   to a queued or uncertain card is rejected without mutation.
9. A reply whose direct parent is absent or unmapped is never guessed from the
   topic root.
10. Long output freezes completed pages and continues in ordered page cards.
11. Human interruption, generation replacement, and `dispatch-uncertain` retain
    the no-replay fence and cannot leak output between turns.
12. `/instance reviewer` shows recent task summaries without truncating or
    overwriting the canonical results stored by each turn.

Before handoff, run focused Lark normalization, instance routing/messaging, Store,
scheduler/supervisor, transcript, publisher, card, and pagination tests, followed
by `npm test`, `npm run typecheck`, and `npm run build`.
