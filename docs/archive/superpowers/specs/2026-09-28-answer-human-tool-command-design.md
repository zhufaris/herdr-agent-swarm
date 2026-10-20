# Answer Human Messages and Tool Commands Design

## Goal

Make an Answer card reflect the safe, exact-turn public timeline seen in Herdr:

- show verified human messages entered in the Herdr pane;
- distinguish public Agent commentary from the final answer without calling it
  "progress"; and
- retain an actual command whenever the matching Tool result is visible.

The change is presentation and projection work. It must not weaken transcript
ownership, prompt FIFO, CardKit pagination offsets, frozen-page behavior, or
outbox delivery semantics.

## Canonical timeline types

Add `human_message` as a first-class `AnswerTimelineItem`. It contains a stable
transcript-derived ID, canonical sequence, and redacted Markdown text. It is not
an `agent_message` with an emoji embedded in its Markdown.

The renderer presents these public records as follows. A verified Human Message
after the page's starting item is also a hard Answer-page boundary: the current
page freezes, and a new Answer post begins with that Human Message.

| Timeline kind | Card and rich-post appearance |
| --- | --- |
| `human_message` | `👤`, followed by the message |
| `agent_message` | `🤖`, followed by the message |
| `final_answer` | Full Markdown, no prefix |
| `tool` | Existing collapsed Tool panel, with a fenced Markdown command and compact result |

Thinking remains limited to safe headings. Raw reasoning, protocol text, Skill
output, and internal orchestration code remain excluded.

## Exact-turn human-message admission

The TraeX transcript projector already recognizes user records. It will emit a
`human_message` only when all of the following are true:

1. the record belongs to the active observation turn;
2. the outer observer has established exact-turn ownership;
3. the text is non-empty after existing redaction and bounded Markdown handling;
4. the record was not the initial Feishu Prompt used to start that turn; and
5. its transcript message ID has not already been emitted.

The initial Feishu Prompt remains the request context shown elsewhere in the card
and is intentionally not duplicated in Answer. A local Herdr human message that
cannot be proved to belong to the exact turn is discarded. A verified later
message stays in the same durable Prompt and exact turn, but starts a new Answer
post whose title replies to that message. This preserves the existing fail-closed
ownership boundary without replaying or splitting the TraeX turn.

## Agent-message presentation

`agent_message` is public Assistant commentary. Rendering adds only an `🤖`
marker; it no longer adds `💬 进展` or a "progress" label. Final-answer
deduplication remains unchanged: an intermediate message byte-identical to the
final answer is suppressed, and the final answer retains its full Markdown.

The shared preparation transform is the one place that applies this marker so
CardKit and rich-text pages cannot drift.

## Tool command capture

Tool results must not be rendered as free-standing output when a safe command is
available. Projection uses two bounded sources:

1. Direct structured function-call arguments provide the primary descriptor.
2. Exact `CommandExecution` transcript events provide authoritative command
   completion data and supplement calls that lack a displayable command.

For the TraeX wrapper `functions.exec`, scan its input only for static
`tools.exec_command(...)` calls. This scanner does not evaluate JavaScript and
does not show the wrapper source. It supports multiple calls, including the
`Promise.all` form, producing independently ordered command entries where exact
command activity is available. If the surrounding output cannot be attributed to
one specific command, it remains a compact aggregate result and is never claimed
as the outcome of a different command.

The projector deduplicates command rows using stable source IDs first, then a
strictly bounded normalized command/time association only within the same exact
turn. No record from a later local pane action or another ordinary turn may fill a
missing command. Unrecognized wrapper source keeps the existing safe fallback:
no outer JavaScript is exposed or mislabeled as a command.

## Rendering and compatibility

Timeline ordering remains canonical by sequence and stable ID. Human, Agent, Tool,
thinking, and final rows therefore interleave in transcript order. The existing
Answer timeline cursor and CardKit page offsets continue to operate over the
canonical rows. A later Human Message advances that cursor to a fresh Answer post;
it does not rewrite persisted source content or create another Prompt.

Tool commands are rendered inside a fenced `bash` Markdown block in both CardKit
and rich-text Answers. Embedded fences are neutralized before wrapping. Tool
results keep current safety and compactness rules: remove only the recognized
execution wrapper, retain the first three and final three lines, and state the
exact omitted count. Skill output remains hidden.

## Plan and tool activity unification

`update_plan` is a Main Card task-status snapshot, not an Answer-card tool
activity. Empty snapshots are ignored. The active plan step is carried only as
bounded context on later visible Answer tools, so one command can read as
`Command · Run tests · Validate rendering` without a duplicate `Step` panel.

Internal transport and polling tools such as `write_stdin` remain excluded. A
visible but unclassified tool uses the neutral `Tool` category; it must never be
misrepresented as a task `Step`. This normalization is projection-only and does
not change persisted cursor ownership, timeline ordering, or delivery semantics.

## Verification

Focused tests must cover:

- a verified local human message appearing once as `human_message`;
- initial Feishu Prompt, duplicate transcript input, and unowned/other-turn input
  being absent;
- `🤖` commentary and an unprefixed full final answer in both rendering paths;
- a direct command/result pair rendering both fields;
- a complex `functions.exec` / `Promise.all` payload preserving all recognized
  nested commands without exposing its JavaScript wrapper;
- a `CommandExecution` record filling a missing wrapper command only for the same
  exact turn;
- compact Tool-result behavior and existing pagination/outbox regressions.

Run affected Vitest files, the full Vitest suite because the canonical timeline
contract changes, `npm run typecheck`, and `npm run build`.
