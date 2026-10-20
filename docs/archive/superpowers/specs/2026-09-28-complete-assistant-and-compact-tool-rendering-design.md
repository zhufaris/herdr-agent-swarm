# Complete Assistant and Compact Tool Rendering Design

## Problem

The Answer timeline currently applies `progressPreview()` to every
`agent_message`. That transform keeps only the first three lines, so substantive
Assistant commentary such as Markdown tables is rendered as an omitted preview
even though the full Markdown remains durable in `answer_timeline_items`. A final
message can also repeat commentary text under a different message ID, because
timeline identity alone cannot detect equivalent content.

Tool activity has the opposite problem: it is intentionally secondary, but long
command strings dominate collapsed-panel headers. Skill results are removed only
during rendering, leaving unnecessary output in the durable timeline.

## Required behavior

### Assistant messages

- Render every public Assistant commentary message in full.
- Render the final answer in full.
- Do not add `omitted` markers to Assistant-authored Markdown. Card pagination
  may split the timeline between cards, but it must preserve the complete text.
- Preserve the existing `💬 进展` visual label for commentary without converting
  the message body into a three-line preview.
- Preserve Markdown structure, including tables, lists, headings, code fences,
  and leading blank lines.

### Duplicate commentary and final answers

When a final answer has exactly the same normalized Markdown as an earlier
commentary message in the same turn, render only the final-answer occurrence.
Normalization is limited to newline normalization and trailing line-ending
removal; it must not collapse meaningful whitespace or perform fuzzy matching.
Different or partially overlapping messages remain visible.

Deduplication is a render-only transform. Durable timeline rows and source IDs
remain unchanged for audit and recovery.

### Tool entries

- Keep Tool panels collapsed after success and expanded while running or failed.
- Keep Tool result previews at the first three and last three lines with the exact
  omitted-line count.
- Generate compact semantic labels instead of copying a full command into the
  panel header. Prefer the operation and its primary target, for example
  `Query · bridge.db`, `Test · sqlite-store.test.ts`, or `Build · project`.
- Preserve the full bounded command only inside the collapsed panel when it is
  useful.
- Keep existing secret redaction and payload-size limits.

### Skill entries

- Show only the Skill name and lifecycle state.
- Remove Skill command/result fields before the item enters the durable Answer
  timeline. The renderer continues to strip them defensively for legacy rows.

## Boundaries

This change does not reduce the general Tool-output persistence limit or alter
Herdr Core's record-size contract. Persistent Tool-result compaction needs a
separate durability and audit decision. It also does not change final-answer
pagination, cursor ordering, outbox idempotency, or recovery semantics.

## Verification

- A multiline Assistant commentary containing a Markdown table renders in full
  and contains no `omitted` marker.
- An identical commentary/final pair renders once as the final answer.
- Similar but non-identical commentary and final messages both render.
- Long Tool output still renders the first three and last three lines with the
  exact omitted count.
- Long shell and SQLite commands receive concise headers while the bounded command
  remains available inside the collapsed panel.
- Skill result text is absent from newly projected timeline items and from the
  rendered payload.
- Focused tests, typecheck, build, and the full test suite pass before deployment.
