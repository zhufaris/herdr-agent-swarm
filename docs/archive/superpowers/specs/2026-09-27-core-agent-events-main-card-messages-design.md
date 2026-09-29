# Core Agent Events and Main Card Recent Messages

## Goal

Make Herdr Core Agent Events the only reply-observation authority used by
Herdr Agent Swarm, then use the resulting structured message boundaries to show
the five most recent Agent replies on the Primary Main Card.

The migration covers every reply source that Swarm can currently observe
structurally: TraeX and Pi, for both Primary and Worker turns. Codex and Claude
Code remain unavailable for structured reply capture until Herdr Core supports
their native transcripts. Swarm must not compensate by reading terminal output.

## Authority boundaries

- Herdr Core reads native Agent transcripts, validates the Pane, terminal,
  Agent kind, and session identity, redacts and bounds content, and persists a
  cursor-addressed Agent Event journal.
- Swarm consumes only `herdr agent events attach`, `sources`, and `read` for
  reply messages, tool calls, tool results, and turn lifecycle.
- Herdr snapshot and targeted Agent operations remain authoritative for Pane
  identity, runtime state, foreground process, and control. They do not supply
  reply text.
- SQLite remains authoritative for Swarm workflow state, consumed projections,
  Answer timelines, Main Card state, outbox intent, and delivery checkpoints.
- Lark remains a presentation target and is never used to reconstruct state.

Swarm does not use terminal scrollback, `herdr read pane`, or another screen
capture path for Agent replies. It also does not silently fall back to direct
JSONL parsing.

## Selected approach

Harden Herdr Core before making an event-only Swarm release. This is preferred
over switching immediately because live Core sources currently demonstrate
`unsupported_response_item`, `unsupported_record`, and `record_too_large`
failures. It is also preferred over an Events-first fallback design because a
fallback would retain two competing reply authorities and reintroduce duplicate
or differently parsed output.

The alternatives rejected by this design are:

1. Switch Swarm before repairing Core. A valid but unfamiliar transcript item
   could stop the only reply path.
2. Keep `events`, `jsonl`, and `shadow` runtime modes. This reduces rollout risk
   but preserves configuration and behavioral divergence indefinitely.

## Herdr Core event-source behavior

Herdr Core continues to expose the generic versioned event payloads:

- `turn_started`
- `message`
- `tool_call`
- `tool_result`
- `turn_completed`
- `turn_aborted`
- `branch_changed`
- `source_error`
- `record_skipped`

The transcript decoder must distinguish unsupported content from a broken
source. An unknown but structurally bounded top-level record or response item
emits a deterministic `record_skipped` event and advances the checkpoint. An
oversized record is consumed without retaining its full body, emits
`record_skipped` with code `record_too_large`, and permits later records to be
read. Known non-visible metadata remains ignored.

Identity failures remain terminal for the old source. A changed terminal,
session, or transcript identity must stop that source rather than joining two
sessions into one event stream. Swarm may attach a new correctly fenced source
after observing the new Herdr identity.

Message, argument, and result bounds plus secret redaction remain mandatory.
Skipping one unsupported record must not expose the raw record in an error,
journal entry, or log.

## Swarm event-only reader

`HerdrEventsReader` becomes the sole `AgentTranscriptReaderPort`
implementation assembled in production. It resolves the validated transcript
descriptor only to register a source with Herdr Core; Swarm never opens or
parses the file contents.

The `HERDR_REPLY_OBSERVATION` setting and the `jsonl` and `shadow` reader modes
are removed. Direct TraeX and Pi transcript projectors may remain only as small
descriptor locators if Core still requires `session_id` and `path` during
attach. Parsing reply records in those classes is removed once no tests or
runtime call sites depend on it.

Both Primary and Worker observers consume the same normalized Core event
projection. A Core source error causes observation to fail closed: the turn is
kept detached or uncertain, prior durable output is retained, and the prompt is
never replayed automatically.

## Task-list projection

Herdr Core keeps `tool_call` generic. A tool call named `update_plan` contains
the structured plan snapshot in its arguments; an `exec` wrapper containing a
well-formed `tools.update_plan(...)` call is handled by the same bounded parser
already used for TraeX transcripts.

Swarm extracts that parser into a pure shared module and applies it to Core
`tool_call` events. A valid snapshot atomically replaces the prior plan and is
projected to `TopicViewState.liveStatus.planSteps`. `update_plan` itself is not
shown as a normal current activity. Invalid or truncated plan arguments do not
replace the last valid plan and do not fail the reply stream.

When a turn has no valid plan snapshot, the Main Card shows the existing compact
current-request status rather than inventing a task list. Core Events do not yet
provide reasoning-derived status titles or token counters; those optional
fields remain absent unless a future version adds explicit generic events.

## Recent Agent message projection

`TopicViewState` gains a bounded `recentAgentMessages` collection:

```ts
interface MainCardAgentMessage {
  messageId: string;
  turnId: string;
  channel: "commentary" | "final";
  markdown: string;
  occurredAt: string;
}
```

Only Core `message` events populate this collection. Tool calls and tool results
remain in the Answer timeline and current-activity projection. User requests
remain represented by the current-task section and are not repeated in recent
messages.

The reducer applies these rules:

1. `turn_started` clears the previous turn's recent messages.
2. Messages are ordered by the Core event cursor/sequence, never by local
   arrival time.
3. Repeated `messageId` updates the existing entry instead of appending it.
4. An adjacent final message whose normalized content equals the last
   commentary message replaces that commentary entry instead of duplicating it.
5. SQLite retains at most the latest ten entries; the Main Card renders the
   latest five.
6. Completed-turn messages remain visible until the next turn starts.

`topic_views.state_json` already persists the complete Topic View. Loading an
older row normalizes a missing `recentAgentMessages` field to an empty list, so
the change does not require a new SQLite column.

## Primary Main Card layout

The Primary Main Card renders sections in this order:

1. `当前任务` and the complete bounded task list.
2. `最新消息 · N`, containing at most five Agent replies.
3. `当前活动`, containing only the newest active non-plan tool activity.
4. `Workers`, including compact status, navigation, and creation controls.
5. Runtime identity and metrics as the final footer.

Commentary messages use a compact Agent marker and the final message uses a
completion marker. Each message remains a separate Markdown block so code
fences and paragraphs are not confused with message boundaries. Each item has
an individual character bound, followed by a total section bound. Oversized
content retains a useful beginning and ending around an explicit omission
marker.

The current six-line `answer` tail heuristic is removed from the Primary Main
Card. If there are no Agent messages, the section is omitted. If a tool is
active, `当前活动` remains visible even when there is no Agent message. Completed
tools do not appear in that compact section and do not duplicate the Answer
timeline.

Worker Main Cards retain their existing task-summary layout, but their reply
and tool data is fed exclusively by the same Core Events source. Full ordered
Agent and Tool history remains in Primary Answer and Worker Task Cards.

## Recovery and delivery

Core event cursors and event identities provide replay ordering. Swarm retains
its existing timeline idempotency and outbox transactions; replaying a cursor
range must not duplicate messages, tool panels, or Main Card entries.

If Core becomes unavailable or a source enters an identity error:

- preserve the last durable Answer, task list, and recent messages;
- mark the observer detached or uncertain according to the existing lifecycle;
- avoid clearing or replacing a card with terminal-derived text;
- do not dispatch the prompt again;
- resume from the durable cursor after the same source recovers, or attach a
  newly identity-fenced source after Herdr reports a new session.

Startup recovery reconstructs cards from SQLite first and reads Core history
only for the exact persisted turn identity. It never scans terminal scrollback.

## Delivery sequence

Deployment is ordered to avoid exposing an event-only consumer to a decoder
that cannot sustain the required stream:

1. Implement and test Core decoder/source resilience in an isolated
   `herdr-core` worktree.
2. Build and install Herdr Core, using its supported live-handoff path so active
   panes and sessions remain attached.
3. Verify new and existing event sources can progress past unknown and oversized
   records without leaking record bodies.
4. Implement and test the Swarm event-only reader, plan projection, recent
   message state, and Main Card layout in an isolated Swarm worktree.
5. Build and install an immutable Swarm release.
6. Inspect the active-work safety gate before restart. Use normal restart when
   safe; a forced restart requires a separate explicit operator instruction.
7. Verify installed identities, readiness, event cursor advancement, Primary
   and Worker Answer tool panels, task-list projection, and the five-message
   Main Card rendering.

No repository is pushed as part of this work.

## Test plan

Herdr Core tests cover:

- unknown response items and unknown bounded records emitting
  `record_skipped` while later messages remain readable;
- oversized records advancing the source without unbounded allocation;
- custom and function tool calls retaining names, arguments, results, and
  stable call identities;
- identity changes remaining terminal and unable to cross-contaminate sources;
- cursor replay and subscription producing no duplicate events.

Swarm tests cover:

- configuration and composition expose only the Core Events reply path;
- Primary and Worker observers use exact Pane/session-fenced sources;
- Core message events populate and update bounded recent-message state;
- final/commentary duplicate suppression;
- `update_plan` and wrapped `tools.update_plan` projection;
- invalid or truncated plans retaining the last valid task list;
- Main Card section order, five-message limit, Markdown bounds, and omission
  behavior;
- only active non-plan tools appearing under `当前活动`;
- old Topic View JSON loading with an empty recent-message default;
- restart recovery preserving cards and never replaying a prompt when Core is
  unavailable.

Focused tests, TypeScript checking, architecture checks, documentation audit,
the complete Swarm Vitest suite, Rust formatting/lints/tests, and both release
builds must pass before installation.

## Acceptance criteria

- The installed Swarm has no direct reply JSONL or terminal-scrollback path and
  no observation-mode switch.
- Primary and Worker reply messages, tools, and lifecycle come from Herdr Core
  Agent Events.
- A valid `update_plan` event produces the full current task list.
- The Primary Main Card renders at most five distinct Agent replies and does not
  infer message boundaries from lines.
- Main Card order is task list, recent messages, active activity, Workers, then
  runtime footer.
- Unsupported or oversized transcript records do not permanently stop a Core
  source; identity violations still fail closed.
- Restart and cursor replay do not duplicate output or resend prompts.
