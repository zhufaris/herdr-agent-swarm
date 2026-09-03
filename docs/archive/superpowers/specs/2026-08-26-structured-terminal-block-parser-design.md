# Structured Terminal Block Parser Design

## Goal

Make TraeX terminal output classification reliable before it becomes Answer
Markdown. The parser must preserve code-shaped output across terminal wrapping,
screen redraws, and observation boundaries without guessing that arbitrary user
text is shell or diff content.

The first supported structured tool blocks are TraeX `Edited` output and
explicit command output from `Ran` or `Bash` markers. Existing Answer delivery,
9,000-character pagination, canonical source offsets, frozen-page behavior, and
durable outbox semantics remain unchanged.

## Why the current approach is insufficient

`normalizeTerminalForLark` currently mixes four responsibilities: recognizing
TraeX UI markers, reconstructing terminal-wrapped headings, joining prose, and
emitting Markdown fences. Each new output variation adds another regex and an
implicit parser state. This has already produced two failure modes:

- numbered diff rows arrived as unfenced prose;
- compact `Edited` previews lost newlines before the Markdown renderer saw them.

The Markdown renderer can safely recognize complete numbered diff runs, but it
cannot reconstruct line boundaries that the terminal normalizer has already
removed. It also cannot reliably infer whether unmarked text is a shell command.

## Chosen architecture

Introduce a pure TraeX terminal block parser between terminal delta extraction
and Markdown serialization. It produces typed blocks instead of modifying an
output string in place.

```ts
type TerminalBlock =
  | { kind: "prose"; lines: string[] }
  | { kind: "diff"; title: string | null; lines: string[] }
  | { kind: "command"; title: string; command: string | null; output: string[] }
  | { kind: "status"; lines: string[] };

type TerminalContinuation =
  | { kind: "none" }
  | { kind: "diff"; title: string | null }
  | { kind: "command"; title: string; command: string | null };
```

The public `parseTerminalStreamDelta(previous, current, promptEcho)` contract
continues to return safe Markdown text, snapshot, update mode, and telemetry.
Internally it performs these stages:

1. Strip terminal control sequences.
2. Compute the append delta or replacement window using the existing overlap
   algorithm.
3. Derive a bounded continuation from the previous terminal snapshot.
4. Parse the new lines into `TerminalBlock` values.
5. Serialize blocks to conservative Markdown.
6. Apply reasoning removal, secret redaction, and the existing size bound.

The continuation is derived from the authoritative previous snapshot on every
call. It is not stored in SQLite or shared mutable process state, so restart and
redraw behavior remains deterministic.

## Recognition rules

Classification uses only explicit TraeX markers. Unmarked content remains prose.

### Diff blocks

- A heading beginning with `◆ Edited` starts a diff block.
- Its body accepts numbered context rows, `+` or `-` change rows, and `⋮` folded
  context rows.
- A new `◆`, status marker, composer, terminal separator, or unrelated line ends
  the block.
- If an observation starts with compatible rows and the previous snapshot ended
  inside `◆ Edited`, the rows continue that diff block.
- Existing Markdown fences inside ordinary prose are preserved and are never
  nested by this parser.
- Consecutive numbered `+/-` rows without an `Edited` heading remain supported by
  the source-aware renderer as a conservative fallback for previously persisted
  Answers and older TraeX formats.

### Command blocks

- A heading beginning with `◆ Ran` or an explicit `• Bash` marker starts a command
  block.
- Text after the `Ran` or `Bash` marker is the command. Consecutive `│` heading
  continuation rows are joined to that command before rendering.
- A non-empty command is rendered in a `bash` fence. A marker with no command
  text remains a title and does not emit an empty fence.
- Tool output is rendered separately in a `text` fence. It is not labeled as
  Bash because stdout, JSON, compiler diagnostics, and test reports are not shell
  source.
- `└` begins tool output. Its decoration is removed from the first output line;
  subsequent output whitespace and line breaks are preserved. `│` decoration is
  removed only while reconstructing the command heading.
- A command block may continue across observations using a continuation derived
  from the previous snapshot.
- Text without `Ran` or `Bash` markers is never inferred to be a command.

### Prose and status blocks

- User-facing `◆` answer prose continues through the existing narrow-terminal
  unwrap behavior.
- Native progress frames and status lines keep their existing classification.
- Terminal chrome, prompt echoes, subagent console rows, and secret-shaped content
  retain their current filtering rules.

## Markdown serialization

Serialization is deterministic and presentation-only:

- `prose` uses `normalizeLarkPreview`;
- `diff` emits its title followed by a `diff` fence;
- `command` emits its title, an optional `bash` fence, and an optional `text`
  output fence;
- `status` preserves line boundaries without inventing code semantics.

The serializer emits balanced fences for every delta. This deliberately closes
a block at an observation boundary and reopens it in the next delta. The durable
Answer therefore remains valid Markdown when append events are concatenated,
while the source-aware page renderer can still close and reopen fences at page
boundaries.

## Module boundaries

Create a focused runtime module, `src/runtime/traex-terminal-blocks.ts`, containing
the block types, continuation derivation, parsing, and serialization.
`traex-output-parser.ts` retains overlap calculation, telemetry, safety filtering,
and its public API. `lark-markdown.ts` remains transport-oriented and retains the
fallback recognition needed for historical canonical Answers.

No coordinator, event, SQLite schema, or CardKit payload contract changes are
required.

## Failure and fallback behavior

- Unknown markers and malformed tool blocks degrade to prose with original line
  breaks retained.
- An incomplete explicit tool block is closed in the emitted Markdown copy; no
  content waits for a future observation.
- A redraw without reliable overlap continues to use `replace-all`, so a mistaken
  continuation cannot append a duplicate tool block.
- Safety filtering runs after serialization and must redact command arguments and
  output exactly as it does today.
- Parser failures must not throw through the turn observer. The pure parser avoids
  exceptional operations; unsupported input is returned as prose.

## Testing strategy

Add table-driven unit fixtures for:

- complete and cross-observation `Edited` blocks;
- context, added, removed, and folded diff rows;
- `Ran` and `Bash` commands with output;
- command output containing JSON, test reports, and diff-like text;
- wrapped headings and decorated `│`/`└` rows;
- existing fenced Markdown and ordinary signed prose;
- redraw and truncated-window behavior;
- secret redaction inside commands and output.

Keep integration assertions for accumulated Answer content, CardKit payloads,
continuation pages, and frozen-page immutability. Add a captured regression fixture
based on `datasage_fabric2onetable / task-jz33`, with secrets and identifiers
removed, so both the original numbered diff failure and the compact Edit newline
failure remain reproducible.

Acceptance requires the focused parser/Markdown/CardKit suite, TypeScript
typecheck, build, and the full Vitest suite. Deployment verification must confirm
the expected commit/build identity, ready Lark and Herdr components, and a real or
captured payload containing balanced `bash`, `text`, and `diff` fences.

## Non-goals

- Guessing commands from shell-like unmarked prose.
- Syntax highlighting arbitrary stdout as Bash.
- Changing persisted Answer offsets or rewriting frozen cards.
- Persisting parser continuation state.
- Replacing terminal fallback with a new Herdr or TraeX protocol in this change.

The block parser keeps an input seam that can later accept native structured tool
events. When those events are complete and stable, terminal classification can
become a fallback without changing downstream block serialization.
