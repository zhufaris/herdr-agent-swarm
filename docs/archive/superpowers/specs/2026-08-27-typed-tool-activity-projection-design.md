# Typed Tool Activity Projection Design

## Goal

Replace raw typed-transcript tool arguments and outputs in Answer Cards with a
small, consistent activity protocol. Preserve useful progress and failure
diagnostics without allowing tool payload size to dominate the answer.

This design supersedes the narrow presentation rules in
`2026-08-27-skill-load-answer-filter-design.md`. The already implemented skill
recognition remains useful, but becomes one policy in the general projector.

## Display protocol

Assistant `output_text` remains unchanged. Ordinary tool calls are silent until
their paired result arrives, then use one consistent field order:

- successful result: `✓ <Type> · <Target> [· <Useful summary>]`
- running result: `… <Type> · <Target> · 运行中`
- failed result: `✗ <Type> · <Target> · <Failure summary>` followed by a fenced
  tail of at most 20 non-empty output lines; the entire failure detail is capped
  at 4,000 characters after redaction.

Because Answer delivery is append-only, a tool that first reports a running
result and later completes may produce two entries. No initial call entry is
emitted, so ordinary synchronous tools produce exactly one activity line.

No successful tool result includes raw stdout, file contents, JSON payloads,
patch bodies, agent listings, or test logs. Generic completion words such as
`成功`, `已完成`, and `已读取` are omitted because the leading `✓` already carries
that meaning. Unknown tools use `Tool` as the type and their declared tool name
as the target.

## Tool categories

Classification uses the declared function name plus structured arguments. It
may inspect nested command-wrapper text for known tool invocations, but never
executes or evaluates it.

| Category | Result target | Optional successful summary |
| --- | --- | --- |
| Skill | distinct skill directory names | none |
| Read | bounded basename or relative path | line count when available |
| Search | bounded query and optional scope | match count when available |
| Edit | bounded path list | changed-file count when available |
| Command | bounded command label rendered as Markdown inline code | test/build facts when available |
| Wait | bounded session or task label | none |
| Agent | bounded agent/task name | meaningful terminal state when available |
| Tool | declared function name | none |

Targets are single-line, Markdown-escaped, and capped at 160 characters. Command
targets alone are wrapped as Markdown inline code, for example
<code>✓ Command · `npm test`</code>; other categories remain plain text. A
command target prefers the inner `exec_command.cmd`; otherwise it
uses the neutral fallback `command`, never the wrapper name `exec`. Embedded
backticks are escaped before wrapping.
Targets must not show environment values, prompt bodies, authorization tokens,
or full serialized arguments.

## Result status and summaries

The projector normalizes string and text-part-array outputs into one bounded
string. It derives status only from explicit structured evidence:

- JSON fields such as `exit_code`, `status`, or `error`;
- wrapper text such as `Script completed`, `Script failed`, `Process exited with
  code N`, or an explicit running `session_id`;
- known collaboration result status fields.

An explicit non-zero exit code, failed/error status, or `Script failed` is a
failure. An explicit running session is non-terminal and renders the same stored
target followed by `运行中`. All other matched results are treated as successful completion. The projector
does not infer failure from arbitrary words such as “error” inside file content
or test source.

For successful command results, deterministic recognizers may extract only
compact facts:

- Vitest/Jest-style `Test Files X passed` and `Tests Y passed`;
- generic `N passed`, `N failed`, or `N skipped` summaries;
- generated build identity;
- changed-file counts from patch or edit results.

If no recognizer matches, no summary field is appended. These recognizers never
copy the surrounding output.

## Skill policy

A skill load is recognized only from structured call arguments containing an
absolute path ending in `/SKILL.md` beneath one of these roots:

- `/path/to/<user>/.trae/skills/`
- `/path/to/<user>/.agents/skills/`
- `/path/to/<user>/.trae/plugins/`

The projector emits no call entry. When the exact paired result arrives it emits
one `✓ Skill · <names>` entry containing distinct skill names in source order. It
does not retain, summarize, truncate, count, fence, or otherwise render any part
of the skill output. A failed skill read emits the normal failed Skill entry and
the bounded diagnostic tail, because failure details are operational rather than
skill contents.

## Architecture

Create `src/runtime/tool-activity-projector.ts` as a pure deep module. Its public
surface accepts a function call, produces a stored projection descriptor plus an
empty call entry, and accepts that descriptor with a function result to produce
the result entry. It owns argument traversal, tool classification,
target bounding, result normalization, explicit status detection, compact
summary extraction, failure-tail selection, Markdown escaping, and final
per-entry bounds.

`FileTraexTranscriptCursor` remains responsible only for JSONL framing, schema
validation, item deduplication, and `call_id` pairing. Its `callsById` map stores
the projector descriptor. It never renders raw function arguments or output
directly.

The existing final `redactSecrets` and `boundMarkdown` gates remain in place for
the assembled delta. The projector also redacts before selecting a failure tail
so secrets cannot influence retained boundaries.

## Ordering and lifecycle

- All calls store a compact descriptor but emit no Answer content.
- A matched terminal result emits one compact result entry containing the stored
  target.
- A running result emits one running entry; a later terminal result may append a
  completion entry for the same target.
- Duplicate item IDs and duplicate call IDs remain suppressed.
- Unmatched, malformed, and unknown transcript items remain ignored.
- Call descriptors remain available across `readDelta()` calls.
- A result is marked emitted even when its policy intentionally produces no raw
  output.

## Invariants

- Raw successful tool output never enters the canonical Answer after this
  projector.
- Ordinary synchronous tools emit one activity line rather than separate call
  and result lines.
- Assistant output is not summarized, truncated by this policy, or reclassified.
- Failure detail is limited to the last 20 non-empty lines and 4,000 characters.
- Skill output is never retained on success.
- Tool activity cannot expose secrets, full prompts, environment values, or
  serialized orchestration payloads.
- Transcript byte offsets, item idempotency, turn source selection, answer
  persistence, pagination, and Lark outbox semantics do not change.

## Verification

- Table-driven unit tests cover every category and generic fallback.
- Tests cover string, text-part-array, unknown, running, success, and failure
  result shapes.
- Tests prove successful stdout and payload bodies are absent.
- Failure tests prove only the last 20 non-empty redacted lines survive and the
  result stays within 4,000 characters.
- Skill tests prove successful output is completely absent and failed reads keep
  only bounded diagnostics.
- False-positive tests preserve assistant prose and ordinary files mentioning
  `SKILL.md`.
- Cursor integration tests prove call/result ordering, cross-read pairing, and
  duplicate suppression.
- Prompt workflow, recovery, pagination, full tests, typecheck, build, and diff
  checks run before deployment.

## Non-goals

- No semantic summarization by an LLM.
- No persistent tool-event table or new CardKit element type.
- No remote controls, approvals, or changes to tool execution.
- No retroactive rewrite of answers already persisted before deployment.
- No terminal-mode classifier in this slice.
