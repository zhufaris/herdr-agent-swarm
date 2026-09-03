# Completed Answer Card Rendering Design

## Goal

Make completed Feishu Answer Cards easier to scan without changing live stream
semantics or the durable answer protocol. The completed snapshot distinguishes
ordinary explanation, code, and command output; gives each large technical
block an independent disclosure panel; and gives readers a clear warning before
a live answer continues onto a new card.

## User-visible behavior

### Live Answer Cards

Live cards keep one stable Markdown element and the native CardKit typewriter
configuration. They remain structurally unchanged while mutable.

When the rendered current page is close enough to the 9,000-character page
limit that the next incremental update would create a continuation, the live
content appends one plain Markdown notice:

`… 本页接近显示上限，后续内容将继续显示在下一张 Answer Card。`

The notice is visual only. It is not added to canonical answer text, does not
change `source_start`, and is absent from the completed replacement snapshot.
It appears only when the page genuinely has more canonical content to render.

### Completed Answer Cards

After a page receives its durable `stream_finish`, the existing final
`card_update` replacement creates a structured snapshot of that same entity:

- prose and short fenced blocks remain Markdown elements in original order;
- each complete fenced block is independently classified as code, command,
  execution output, diff, JSON/configuration, or generic text;
- every block over 80 lines or 6,000 characters starts in its own collapsed
  `collapsible_panel`; short blocks remain expanded as Markdown;
- collapsed titles include a semantic label, total lines, and character count,
  for example `TypeScript 代码 · 132 行 · 8,411 字符` or
  `执行输出 · 423 行 · 12,084 字符`;
- non-collapsed command, diff, JSON/configuration, and output blocks retain
  their fence and source text, with no copy or rewrite of code characters.

The complete card body has three logical regions without inserting artificial
section headers into prose: explanation remains normal Markdown; fenced code
and commands are code-region elements; explicit `text` fences emitted for
TraeX stdout are execution-output elements. A region is represented by the
element type and title of an individual panel, not by moving surrounding prose
or grouping unrelated blocks.

## Classification

Classification operates only on complete, already-render-safe triple-backtick
fences in the completed bounded page copy. It does not parse or change canonical
Markdown.

| Fence language | Label |
| --- | --- |
| `bash`, `sh`, `shell`, `zsh` | 命令 |
| `text` | 执行输出 |
| `diff`, `patch` | 变更 Diff |
| `json`, `yaml`, `yml`, `toml`, `ini`, `conf` | 配置 / JSON |
| `ts`, `typescript`, `js`, `javascript`, `py`, `python`, `go`, `java`, `sql`, and other known programming languages | `<Language> 代码` |
| absent or unknown | 代码块 |

The exact threshold is unchanged: a block folds only when line count is greater
than 80 or code-character count is greater than 6,000. The title shows the full
line count and character count, not omitted counts. Malformed or unclosed fences
remain ordinary Markdown.

## Architecture

`src/runtime/answer-stream.ts` owns the render-only continuation hint. It will
derive whether the current canonical page has a next page from the same
source-aware page-rendering result used by the planner, then append a bounded
display suffix only to live stream payloads. The canonical source range and
page planner stay unchanged.

`src/cards/run-card.ts` owns pure completed-card rendering. Its existing narrow
fence splitter gains a deterministic block classifier and creates independent
Markdown or collapsed-panel elements. It receives the already bounded rendered
page and therefore cannot alter page boundaries.

`AnswerPageWorkflow`, SQLite, and the outbox do not gain lifecycle state or new
delivery kinds. The existing post-finish `card_update` remains the one durable,
idempotent upgrade. It simply carries the richer final card payload.

## Invariants

- The canonical answer, answer segments, source offsets, page limits, stream
  sequences, finish ordering, and continuation creation are unchanged.
- No disclosure panel or replacement-card update occurs before `stream_finish`
  marks the page finished.
- Frozen continuation pages and failed pages are excluded from final upgrades.
- The live continuation hint must never force an early page boundary, consume
  source characters, or create a new outbox intent.
- Each final visual update continues to target the existing Answer message and
  is retryable independently of all TraeX work.
- There are no new Lark actions, callbacks, remote approvals, stop controls,
  prompt replay paths, or schema migrations.

## Verification

- Unit-test live-page warning appearance only when a continuation exists and
  prove canonical source offsets/pages remain unchanged.
- Unit-test final semantic titles for code, command, stdout, diff, and JSON;
  check independent multiple panels, thresholds, short blocks, and malformed
  fences.
- Extend Answer-page workflow coverage to confirm final completion still
  reserves exactly one durable update with richer rendering.
- Run focused stream, card, workflow, SQLite, and outbox tests, followed by
  `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`.
- After build, restart the managed service and verify `/status` reports the
  resulting build identity with `readiness.status: ready`.

## Non-goals

- No folding of prose or whole cards.
- No folding during live typewriter streaming.
- No change to the 9,000-character canonical page limit.
- No automatic summary/model rewrite, persistent expansion preference, or
  CardKit action for copying/expanding content.
