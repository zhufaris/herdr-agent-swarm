# Answer Card Empty-Output Command Folding Design

## Status

Draft for written-spec review. This document narrows one presentation defect in
Primary Answer Cards: a completed command with no displayable output appears as
plain text while neighboring completed commands are expandable.

## Problem

The transcript projector emits the same canonical command grammar for every
completed command:

````text
◆ **Ran**

```bash
<command>
```
````

It adds a `text` fence only when safe displayable output remains after status
lines, transport metadata, and secrets are removed. Outputs such as
`Script completed` intentionally normalize to an empty string.

The final Answer renderer currently creates a `collapsible_panel` only when the
parsed command has non-empty output. A completed command without output is
therefore rendered as compact Markdown. This happens disproportionately to the
last tool call because a successful terminal command often precedes the final
assistant response and has no useful stdout. The panel position is not the root
cause.

## Desired Behavior

Finalized Answer Cards apply one consistent rule to completed command activity:

| Command state | Final presentation | Expanded detail |
| --- | --- | --- |
| Completed with output | Collapsed panel | Command and bounded output |
| Completed without output | Collapsed panel | Command plus `命令已完成，无可展示输出。` |
| Failed | Collapsed panel | Command and bounded failure detail when available |
| Running | Compact Markdown row | No panel because the operation is not terminal |
| Malformed or assistant-authored lookalike | Markdown | Preserve content; do not infer a command |

The panel remains collapsed by default. Its title retains the normalized command
and terminal state. Streaming cards continue to show compact Markdown rows; the
panel is introduced only by the existing final structured-card update.

## Design

`final-answer-content.ts` remains the only owner of the final structured
transformation. `parseCommandBlock` already distinguishes the heading state and
returns the parsed command with optional output. Extend its render model with an
explicit command lifecycle, or an equivalent terminal predicate, so rendering
does not use output presence as a proxy for completion.

`renderBlock` creates a panel for every terminal command. If output is empty, it
adds the fixed empty-output message after the command fence. A running command
continues to render `block.compact`. This preserves the current behavior for a
command observed before its result and prevents an interactive empty shell from
being presented as completed work.

The existing serialized-payload guard remains authoritative. If adding a panel
would exceed the card payload limit, that command alone falls back to its compact
Markdown row. This is a delivery-safety fallback, not the normal empty-output
presentation.

No canonical Answer text is rewritten. No schema, page boundary, stream
sequence, CardKit finalization, outbox key, or retry behavior changes. Redaction
and the existing command and output limits apply before panel construction.

## Failure and Compatibility Behavior

- Partial command blocks remain Markdown and are never swallowed.
- A terminal heading with no output is safe to render because the command itself
  has already passed through the existing command sanitation and length bound.
- A final-card delivery retry repeats only the idempotent `card_update`; it does
  not repeat the command or TraeX prompt.
- Existing delivered cards are not rewritten. New finalizations use the corrected
  renderer, including recovery of already-durable finalization intents that are
  rendered after deployment.
- The fix does not add a footer or depend on a panel's position in the card.

## Testing

Focused renderer tests must prove:

- a terminal successful command without output becomes a collapsed panel;
- the panel contains the bounded command and the fixed empty-output message;
- the same command marked `运行中` remains compact Markdown;
- a failed command without displayable detail is still terminal and expandable;
- malformed and incomplete command blocks remain Markdown;
- payload exhaustion still degrades only the affected command to Markdown;
- a no-output command at the end of the Answer has the same result as one between
  prose blocks.

Run the focused final-answer, Answer stream, and Answer workflow tests, followed
by `npm run typecheck` and `npm run build`. The change is presentation-only and
does not require a live TraeX smoke test.

## Non-goals

- Changing which tool outputs are safe to expose.
- Folding non-command Read, Search, Edit, Skill, Agent, Wait, or generic Tool
  activity.
- Reordering Answer elements or changing the 9,000-character page policy.
- Retrofitting already-delivered Lark cards.
- Changing Worker card behavior.
