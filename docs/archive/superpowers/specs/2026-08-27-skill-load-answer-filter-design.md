# Skill Load Answer Filtering Design

## Goal

Keep Answer Cards readable when TraeX loads a skill. Replace the tool call and
the corresponding `SKILL.md` contents with one concise activity line while
preserving ordinary tool calls, ordinary file reads, and assistant answers.

## User-visible behavior

A recognized skill load renders as:

`已加载技能：brainstorming`

The shell command, serialized tool arguments, and `SKILL.md` contents are not
included in the Answer Card. Multiple skill files read by one call produce one
line per distinct skill, in source order. Duplicate names in the same call are
shown once.

## Recognition boundary

Recognition happens while a typed TraeX transcript pairs a `function_call` with
its `function_call_output`. A call is a skill load only when its structured
arguments contain an absolute path ending in `/SKILL.md` beneath a recognized
TraeX skill root:

- `/data00/home/<user>/.trae/skills/`
- `/data00/home/<user>/.agents/skills/`
- `/data00/home/<user>/.trae/plugins/`

The displayed name is the directory immediately containing `SKILL.md`. Plugin
paths may contain version directories, but the containing skill directory is
still authoritative. Paths outside these roots, relative `SKILL.md` strings,
assistant prose mentioning `SKILL.md`, and output that merely resembles a skill
document are not filtered.

## Architecture

`FileTraexTranscriptCursor` stores a small render policy alongside each pending
function call. For a recognized skill load, the call emits the concise summary
and records that its paired output must be suppressed. For all other calls, the
existing call and result rendering is unchanged. Matching uses parsed argument
values rather than scanning output text, so normal documentation and code are
not accidentally removed.

The filter changes only the rendered typed delta. It does not alter the source
transcript, canonical session identity, cursor byte offset, item idempotency,
redaction, answer persistence, pagination, or outbox delivery.

## Error handling and safety

- Malformed arguments follow the existing generic rendering path.
- A recognized call suppresses only the result with the same non-empty
  `call_id`.
- Unmatched results remain suppressed as today.
- If no valid skill path can be extracted, no special filtering occurs.
- Secret redaction and rendered-delta bounds remain the final output gates.

## Verification

- Test `exec` and non-`exec` calls containing recognized skill paths.
- Test multiple and duplicate skill paths in one call.
- Test that paired skill contents are absent and the summary is emitted once.
- Test false positives: ordinary files, relative paths, assistant prose, and a
  normal tool result containing the literal text `SKILL.md`.
- Run the transcript tests, prompt workflow tests, typecheck, build, full suite,
  and diff checks before deployment.

## Non-goals

- No filtering of terminal-mode output.
- No generic suppression of Markdown, code blocks, or long tool results.
- No change to skill execution, agent instructions, or TraeX session files.
