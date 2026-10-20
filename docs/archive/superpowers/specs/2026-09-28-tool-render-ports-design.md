# Tool Render Ports Design

## Goal

Give every Answer timeline Tool category an explicit rendering contract so a
change to one type cannot silently alter or remove another type in CardKit or
rich-text output.

## Boundary

`src/cards/answer-tool-render-ports.ts` owns the shared semantic projection from
an `AnswerTimelineItem` Tool to a transport-neutral render model. It exposes one
port for each category: `read`, `search`, `edit`, `command`, `test`, `skill`,
`tool`, and `step`.

Each port owns:

- its stable emoji and display label;
- its lifecycle-aware Herdr-style summary (`Reading` / `Read`, `Searching` /
  `Searched`, `Editing` / `Edited`, `Running` / `Ran`, and `Loading` /
  `Loaded`);
- whether the Tool is visible;
- whether Command content is eligible for display;
- whether Result content is eligible for display.

CardKit and rich-text renderers consume the model and remain responsible only
for transport formatting, size bounds, redaction, and collapsing behavior.

## Policies

- All eight categories have distinct registered ports and contract tests.
- A parent Tool followed by its contiguous `parentToolId` children is projected
  as one semantic group only for Search+Read, Read-only, Edit-only, Skill-only,
  or Command/Test-only work. Mixed or unknown groups keep their individual Tool
  rows so no activity disappears.
- A semantic group renders one compact status header and keeps the individual
  Search, Read, Edit, Skill, or Command members in its folded detail. This is a
  presentation-only transform; canonical Core events and durable timeline rows
  remain unchanged.
- A standalone semantic Tool without Command or Result detail renders as one
  compact Markdown row instead of an empty collapsible panel.
- Search+Read groups follow the Herdr pane information shape, for example
  `🔍 Searching for "scanDurablePromptWork" in sqlite, reading 2 files…`.
- Edit summaries include statically proven patch counts, for example
  `✏️ Edited herdr-events-reader.ts (+9 -52)`.
- Command/Test summaries use `Running`, `Ran`, or `Failed`; the original command
  remains fenced Markdown inside the folded detail.
- `skill` displays identity and state but never its loaded Result.
- `step` hides the internal `update_plan` operation completely; plan steps are
  rendered on the Main Card instead.
- Empty structured results such as `{}` are treated as no displayable output.
- Command-bearing Tool and Step items keep fenced `bash` Markdown.
- A Tool result completed after its source page froze is rendered on the active
  page with `（更新自第 N 页）` provenance while retaining the original command
  in its folded detail.
- Existing durable timeline rows are not rewritten. The renderer applies the
  current policy when old rows are materialized.

## Verification

Unit tests cover every port directly and assert every category's stable emoji
in both CardKit and rich-text output. Core-event integration tests cover raw
Code Mode Search+Read groups, commands, edits, skills, plan updates, and final
payloads. Page tests assert that a semantic group remains indivisible and keeps
every source item ID. The full Vitest suite, typecheck, and production build
remain deployment gates.
