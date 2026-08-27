# Typed Tool Activity Projection Design

## Goal

Replace raw typed-transcript tool arguments and outputs in Answer Cards with a
small, consistent activity protocol. Preserve useful progress and failure
diagnostics without allowing tool payload size to dominate the answer.

This design supersedes the narrow presentation rules in
`2026-08-27-skill-load-answer-filter-design.md`. The already implemented skill
recognition remains useful, but becomes one policy in the general projector.

## Display protocol

Assistant `output_text` remains unchanged. Tool activity uses at most two compact
entries because Answer delivery is append-only and cannot replace an earlier
running line:

- call: `▶ <Type> · <Target>`
- successful result: `✓ <Type> · <Summary>`
- failed result: `✗ <Type> · <Summary>` followed by a fenced tail of at most 20
  non-empty output lines; the entire failure detail is capped at 4,000
  characters after redaction.

No successful tool result includes raw stdout, file contents, JSON payloads,
patch bodies, agent listings, or test logs. Unknown tools use `Tool` as the type,
their declared tool name as the target, and `已完成` as the successful summary.

## Tool categories

Classification uses the declared function name plus structured arguments. It
may inspect nested command-wrapper text for known tool invocations, but never
executes or evaluates it.

| Category | Call target | Successful summary |
| --- | --- | --- |
| Skill | distinct skill directory names | no call line; result emits `✓ Skill · <names> · 已加载` |
| Read | bounded basename or relative path | `已读取 · N 行` when count is available, otherwise `已读取` |
| Search | bounded query and optional scope | `发现 N 条` when count is available, otherwise `搜索完成` |
| Edit | bounded path list | `已更新` or `N 个文件已更新` |
| Command | bounded command label rendered as Markdown inline code | `成功` plus parsed test/build counts when available |
| Wait | bounded session or task label | `已完成` or `仍在运行` |
| Agent | bounded agent/task name | `已启动`, `已完成`, or `状态已更新` |
| Tool | declared function name | `已完成` |

Targets are single-line, Markdown-escaped, and capped at 160 characters. Command
targets alone are wrapped as Markdown inline code, for example
<code>▶ Command · `npm test`</code>; other categories remain plain text. A
command target prefers the inner `exec_command.cmd`; otherwise it
uses the declared function name. Embedded backticks are escaped before wrapping.
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
failure. An explicit running session is non-terminal and renders `仍在运行`.
All other matched results are treated as successful completion. The projector
does not infer failure from arbitrary words such as “error” inside file content
or test source.

For successful command results, deterministic recognizers may extract only
compact facts:

- Vitest/Jest-style `Test Files X passed` and `Tests Y passed`;
- generic `N passed`, `N failed`, or `N skipped` summaries;
- generated build identity;
- changed-file counts from patch or edit results.

If no recognizer matches, the summary is `成功`. These recognizers never copy
the surrounding output.

## Skill policy

A skill load is recognized only from structured call arguments containing an
absolute path ending in `/SKILL.md` beneath one of these roots:

- `/data00/home/<user>/.trae/skills/`
- `/data00/home/<user>/.agents/skills/`
- `/data00/home/<user>/.trae/plugins/`

The projector emits no call entry. When the exact paired result arrives it emits
one successful Skill entry containing distinct skill names in source order. It
does not retain, summarize, truncate, count, fence, or otherwise render any part
of the skill output. A failed skill read emits the normal failed Skill entry and
the bounded diagnostic tail, because failure details are operational rather than
skill contents.

## Architecture

Create `src/runtime/tool-activity-projector.ts` as a pure deep module. Its public
surface accepts a function call, produces a stored projection descriptor plus an
optional call entry, and accepts that descriptor with a function result to
produce the result entry. It owns argument traversal, tool classification,
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

- Non-skill calls emit a compact call entry immediately.
- A matched result emits one compact result entry.
- Skill calls emit nothing until the matched result.
- Duplicate item IDs and duplicate call IDs remain suppressed.
- Unmatched, malformed, and unknown transcript items remain ignored.
- Call descriptors remain available across `readDelta()` calls.
- A result is marked emitted even when its policy intentionally produces no raw
  output.

## Invariants

- Raw successful tool output never enters the canonical Answer after this
  projector.
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
