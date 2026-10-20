# Structured Answer Tool Events Design

## Goal

Remove the legacy `◆ Ran` Markdown representation of tool execution from new
Primary and Worker Answer output. Tool calls and results use only stable-ID
structured timeline items, so an Answer renders the correct activity icon from
its first visible update and does not spend extra Feishu edits replacing a
Markdown command block.

## Scope

- Apply to native Herdr Agent Events and the legacy TraeX transcript reader.
- Keep assistant prose and final answers in the Answer timeline.
- Keep tool calls, tool results, status, and state transitions exclusively in
  structured `timelineDeltas`.
- Remove the `◆ **Ran**` parser and command-block renderer from final Answer
  content.
- Do not migrate or rewrite already delivered cards or stored historical
  Answer text.
- Accept that an old transcript containing only rendered `◆ Ran` Markdown and
  no structured tool event will no longer expose that tool history.
- Do not change Answer pagination, the 9,000-character limit, prompt execution,
  outbox ordering, or edit-limit recovery.

## Data flow

```text
assistant message -> structured agent_message item -> Answer Markdown
tool call         -> structured tool item (running) -> icon panel
tool result       -> same tool ID (success/failure) -> panel upsert
final answer      -> structured final_answer item -> Answer Markdown
```

The transcript projectors may continue producing the legacy `toolActivities`
summary used by Main Card progress, but they must not append the textual output
of `projectToolCall` or `projectToolResult` to `answerDelta`. A tool result uses
the same `tool:<call_id>` identity and canonical sequence as its call, preserving
the current in-place state transition.

## Compatibility boundary

Compatibility remains at the persisted view boundary: existing Answer text is
readable and existing messages are left untouched. There is no compatibility
parser for new `◆ Ran` blocks. The renderer treats any such text as ordinary
Markdown rather than recognizing, folding, or decorating it as a command.

This intentionally removes semantic recovery for tool activity from text-only
legacy transcripts. The native structured event contract is the sole authority
for new tool rows.

## Failure behavior

- A tool call without a result remains a structured running item and is
  terminalized by the existing completion/failure reducer.
- A result without a known call is ignored rather than reconstructed from
  Markdown.
- Missing structured tool events do not cause text scraping or synthetic tool
  rows.
- Agent prose and final answers continue to render even when tool metadata is
  missing.

## Verification

- Projector tests assert tool calls and results do not contribute `◆ Ran` or
  tool output to `answerDelta`.
- Projector tests assert the same stable timeline item transitions from running
  to succeeded or failed.
- Herdr Agent Events tests assert native tool events remain fully represented in
  `timelineDeltas`.
- Card tests remove legacy command-block conversion expectations and assert
  literal `◆ Ran` input receives no special rendering.
- Replay tests assert one tool call produces one structured timeline item, not
  a Markdown copy plus an icon panel.
- Focused tests, typecheck, build, and the full suite must pass before release.
