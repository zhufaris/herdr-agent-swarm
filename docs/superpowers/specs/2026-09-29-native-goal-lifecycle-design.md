# Native Goal Lifecycle Design

## Purpose

Expose the Primary Agent's current long-running Goal in the active Answer Card
without confusing it with the turn-scoped Task List or coupling Herdr Agent
Swarm to TraeCode's tool wrapper.

The design adds one normalized Goal lifecycle to Herdr Core and one durable
`CurrentGoal` projection to the Primary Session context. Answer rendering reads
that projection as a snapshot. Goal state is never inferred from Feishu, card
content, terminal text, or generic tool-activity rendering.

## Domain language

**Goal**:
A user-directed objective that may span multiple Agent turns.

**Current Goal**:
The latest non-completed Goal known for one exact Primary Agent session. It is a
Primary Session projection, not a Prompt or Answer-page entity.

**Goal lifecycle event**:
A normalized Herdr Core event that states one Goal transition independently of
the source Agent's tool-call encoding.

**Task List**:
The current turn's ordered execution plan derived from native `planSteps`.
Task List remains separate from Goal in ownership, storage, and rendering.

## Decisions

1. Herdr Core is the translation boundary from Agent-native records to a
   provider-neutral Goal lifecycle event.
2. Herdr Agent Swarm does not parse `create_goal` or `update_goal` tool arguments.
3. `CurrentGoal` belongs to the Primary Session and survives Prompt completion,
   Answer pagination, bridge restart, and later turns in the same session.
4. Run Card and Answer Card models receive a read-only Goal snapshot. They do
   not own Goal lifecycle transitions.
5. Only `active`, `paused`, and `blocked` are current states. A `completed`
   transition clears `CurrentGoal` after the lifecycle fact is durably applied.
6. Goal renders immediately before Task List. Task List remains the final Answer
   section.
7. Frozen Answer pages are immutable. A Goal change converges only the current
   mutable page and later pages.

## Alternatives considered

### Parse Goal tools in Swarm

This is smaller initially, but it makes the Conversation Projection context know
TraeCode's `exec` wrapper and tool argument schema. It also makes replay,
truncation, and malformed arguments part of Swarm's domain behavior. Rejected.

### Add a generic session-state property bag

A generic `session_state_changed` event could carry Goal today and unrelated
state later. It weakens the language and validation boundary, makes ordering
rules field-dependent, and introduces extension machinery before a second use
case exists. Rejected under YAGNI.

### Add a native Goal lifecycle

This produces a small explicit contract, preserves the Core/Swarm boundary, and
lets both repositories validate transitions using domain names. Selected.

## Herdr Core contract

Herdr Core extends `ReplyPayload` with one event:

```text
GoalChanged {
  goal_id: String,
  objective: String,
  status: active | paused | blocked | completed,
  source_updated_at: u64
}
```

`goal_id` identifies one logical Goal within the native Agent session. Core
derives it deterministically from the successful native result's thread identity
and Goal creation time. `source_updated_at` is the native Goal's update time and
provides the first ordering fence. The Core decoder emits a stable journal key
from the originating call ID and normalized result, so re-reading the source is
idempotent.

The event keeps `session_id`, `turn_id`, `occurred_at`, cursor, and source
identity in the existing `AgentReplyEvent` envelope. A Goal may be created or
updated during a turn, but its lifetime is not bounded by that turn.

### Native producer and input normalization

TraeX 0.207.1 already appends a typed `thread_goal_updated` event after native
Goal state changes. Its payload contains `threadId` and a complete `goal`
snapshot with `threadId`, `objective`, `status`, `createdAt`, `updatedAt`, token
usage, and elapsed time. Herdr Core derives `goal_id` from the Goal thread ID and
creation time, and maps `updatedAt` to `source_updated_at`.

The TraeX decoder recognizes this typed event and maps it to `GoalChanged` beside
existing message, tool, and turn normalization. Failed or merely attempted
mutations do not produce `thread_goal_updated`, so Core never needs to infer
success from a tool result. Unsupported Agents emit no Goal event.

The same transcript may also contain orchestration calls inside a generic
`custom_tool_call` named `exec`; `create_goal` and `update_goal` then exist only
inside JavaScript input and their result is folded into generic exec output.
That representation is not a Goal protocol. Neither Herdr Core nor Swarm may
parse the JavaScript or scrape its human-readable output.

Ordinary ToolCall and ToolResult events remain available for the Answer
timeline. Goal normalization is an additional semantic event, not a replacement
for activity reporting.

Malformed Goal records fail closed at the decoder boundary. Core must not emit
a partial Goal, silently reinterpret an unknown state, or downgrade it to a
generic tool activity. Objective text passes through the existing bounded text
and secret-redaction policy before journal persistence.

For the first implementation, TraeX's typed `thread_goal_updated` event is the
supported source. Generic command text, terminal output, human-readable result
text, and calls nested inside an `exec` wrapper are not Goal sources.

## Primary Session model

Swarm introduces these provider-neutral values:

```text
GoalStatus = active | paused | blocked

CurrentGoal {
  goalId: string
  objective: string
  status: GoalStatus
  sourceUpdatedAt: number
  occurredAt: string
  sourceId: string
  sourceCursor: string
  sourceEventId: string
}
```

The Primary Session aggregate applies `GoalChanged` using the following rules:

- A non-completed event becomes the current Goal when its source update time and
  canonical event order are newer than the stored state for the same `goalId`.
- A new `goalId` replaces the prior current Goal when the event is newer by the
  canonical Core event order.
- A completed event clears the current Goal only when it targets the current
  `goalId` and is newer than the stored transition.
- Duplicate and stale events are no-ops.
- An event from another native session or binding generation cannot mutate the
  projection.

Canonical event order is `(sourceUpdatedAt, occurredAt, cursor, eventId)`. The
cursor is source-local and is compared only after exact source/session identity
has been established. When startup recovery encounters an older historical
source for the same session, an equal normalized Goal snapshot is idempotent;
an ambiguous conflicting snapshot at the same source update time is rejected
rather than guessed.

## Persistence and transaction boundary

SQLite stores CurrentGoal as part of the Primary Session projection, keyed by
binding ID and binding generation. The record includes native session identity
and the last applied event order needed to reject stale delivery.

Applying a Goal event is one fenced transaction that:

1. verifies the binding generation and native session identity;
2. applies or rejects the lifecycle transition;
3. advances the Primary Session projection revision when visible state changes;
4. schedules convergence for the current mutable Answer page.

The transaction does not write Feishu state directly. Existing Answer
convergence and the durable outbox remain responsible for CardKit delivery.
Lease fencing and startup recovery include the new projection table or columns.

No historical Goal ledger is required in Swarm for this milestone. Herdr Core's
event journal remains the lifecycle fact source; Swarm persists only the current
projection and its ordering fence.

## Event and projection flow

```text
TraeX thread_goal_updated event
  -> Herdr Core Agent decoder
  -> normalized GoalChanged event
  -> Swarm HerdrEventsReader validation
  -> Primary Session goal transition
  -> durable CurrentGoal projection
  -> Answer-page convergence request
  -> current mutable CardKit Answer page
```

`HerdrEventsReader` surfaces Goal changes as structured observation data. It does
not mutate cards or SQLite. The conversation projector routes the observation to
the Primary Session projection and then supplies the resulting Goal snapshot to
the Answer view reducer.

Task List continues through its existing independent path:

```text
native update_plan -> planSteps -> RunCardView.taskList -> Task List section
```

## Answer Card rendering

When CurrentGoal exists, the active Answer page renders:

```text
🎯 Goal · In progress
<objective>

📋 Task List
<turn-scoped plan steps>
```

Status labels are:

- `active`: `In progress`
- `paused`: `Paused`
- `blocked`: `Blocked`

Goal objective uses the same bounded Markdown-safe rendering policy as other
user-visible text. It is not duplicated in the Answer title, `Reply to` line,
timeline, or Task List. A completed Goal has no persistent Goal section.

If pagination freezes a page, later Goal transitions do not patch that page.
The current mutable page uses the latest CurrentGoal snapshot. A newly created
continuation page starts with the latest snapshot as well.

## Recovery and failure behavior

- If Core does not support Goal events, Swarm behaves exactly as today and
  renders no Goal section.
- If Swarm receives an unknown Goal status or invalid payload, the event batch
  fails validation and does not partially update the projection.
- If a Goal projection transaction succeeds but CardKit delivery fails, the
  durable outbox retries delivery without replaying the Agent turn.
- On restart, startup recovery loads CurrentGoal and converges only mutable
  Answer surfaces.
- Re-reading Core events is safe because event identity, normalized source update
  time, binding generation, and native session identity fence duplicate or stale
  updates.
- Branch changes do not clear CurrentGoal. A later native Goal event must
  explicitly replace, pause, block, or complete it.

## Security and privacy

- Goal objective text is bounded and redacted in Herdr Core before persistence.
- Swarm validates length and enum values again at its external adapter boundary.
- Logs use Goal ID, source update time, binding ID, and event ID for correlation;
  they do not log the objective.
- Goal content never enters command arguments generated by Swarm.

## Testing strategy

### Herdr Core

- schema serialization and generated API schema for every Goal status;
- TraeX `thread_goal_updated` normalization and stable journal keys;
- generic exec input and output never becoming Goal events;
- duplicate transitions, malformed records, truncation, and redaction;
- Goal events retaining session/turn envelope identity.

### Herdr Agent Swarm

- Zod validation of Goal events in `HerdrEventsReader`;
- Primary Session transition tests for create, replace, pause, block, complete,
  duplicate, stale, wrong generation, and wrong session;
- SQLite migration, lease-fence, persistence, and restart recovery tests;
- Answer rendering order: Goal, then final Task List;
- absence after completion and absence when Core emits no Goal;
- pagination tests proving frozen pages are unchanged;
- outbox retry tests proving delivery retry does not replay a Prompt.

### Cross-repository acceptance

With an exact native Primary session, create a Goal, advance it across turns,
pause or block it, then complete it. Verify the Core event stream, durable Swarm
projection, and delivered CardKit payload at every transition without exposing
the objective in logs.

## Rollout

1. Require TraeX 0.207.1 or newer, which emits `thread_goal_updated`.
2. Release Herdr Core with the additive `GoalChanged` event.
3. Release Swarm support; older Core versions remain compatible because absence
   of the event means absence of the Goal section.
4. Install Core before Swarm runtime validation.
5. Restart Swarm only through the supported lifecycle and active-work safety
   gate.

No feature flag is needed: the behavior is additive, event-driven, and inert
when the Core producer is unavailable.

## Non-goals

- Editing, creating, pausing, or completing Goals from Feishu.
- Displaying completed Goal history.
- Deriving Goal progress from Task List completion.
- Inferring Goal state from tool panels, terminal text, or Answer prose.
- Adding Goal state to Worker sessions in this milestone.
- Replacing Task List with Goal or merging their persistence models.
- Parsing JavaScript passed to `exec` or scraping generic tool output as a Goal
  source.
