# Pane-Aligned Answer Card Rendering Design

## Goal

Make Answer Card content resemble the current TraeX presentation in a Herdr
pane: assistant prose remains prominent, while tool activity is compact by
default and command details are available on demand. Preserve the structured
transcript as the Answer authority and preserve durable CardKit pagination,
ordering, recovery, and redaction guarantees.

## Scope

This change applies to Primary Answer Cards. It changes presentation and the
durable page-finalization sequence needed to publish that presentation. It does
not read terminal scrollback, change prompt execution, alter Main Card content,
or change Worker task cards.

## User-visible behavior

### Assistant prose

Assistant Markdown remains in document order and continues to use the existing
source-aware normalization for headings, lists, links, tables, code, and diffs.
The card does not reproduce terminal chrome, reasoning prose, the input composer,
or pane status bars.

### Tool activity

During streaming, tool activity is represented by a compact one-line summary in
the Markdown stream. The style follows the Herdr pane's information hierarchy:

- command: `◆ Ran · npm test · 运行中`, `◆ Ran · npm test · 完成`, or
  `◆ Ran · npm test · ✗ exit 2`;
- non-command activity: the existing compact `Read`, `Search`, `Edit`, `Skill`,
  `Wait`, `Agent`, or fallback `Tool` row.

The command label is sanitized, single-line, and bounded by the existing
160-character target limit. A result summary is shown when the projector can
derive one safely. Generic success prose is not added when the state marker is
sufficient.

When a page is finalized, each command activity with details becomes a separate
collapsed CardKit panel. Its plain-text title repeats the compact summary. Its
body contains the command in a `bash` fence and, when present, its bounded output
or failure diagnostic in a `text` fence. Commands without details and all
non-command activities remain compact Markdown rows; empty panels are never
created. Panels are collapsed by default.

The existing security bounds remain authoritative: command and output text are
redacted, output is capped at 4,000 characters, and long output is reduced to
the existing first/omission/last line window in the render copy. Successful raw
file contents, patch payloads, agent payloads, and other currently excluded data
do not become visible through the panel.

## Architecture

### Structured render model

Add a pure Answer-content renderer that parses only the bridge's exact canonical
tool-activity grammar and produces an ordered render model:

- Markdown segments for assistant prose and compact non-command rows;
- command activity segments containing a compact title plus optional safe
  command/output detail.

The parser must not infer commands from arbitrary assistant prose. Only exact
blocks emitted by `tool-activity-projector.ts` are eligible. Malformed, partial,
or unknown blocks remain ordinary Markdown so streaming can never swallow user-
visible content.

The canonical Answer stored in `RunCardView.answer` remains unchanged. Structured
segments are derived at render time and are never stored as a second answer.

### Streaming render

`renderLarkMarkdownPage` remains responsible for mapping a rendered page to
canonical source offsets. Page fitting uses the safe detailed representation,
including fences and bounded output, even though the live Markdown copy displays
only compact tool summaries. This deliberately permits an under-filled live card
and guarantees that the finalized structured card for the same canonical range
cannot exceed the page budget merely because details become visible in panels.

The renderer returns both the canonical continuation boundary and the compact
live representation. Synthetic fences and continuation notices remain render-
only. `answer_pages.source_start` always refers to the unmodified canonical
Answer. The default rendered page limit remains 9,000 characters.

### Final structured render

The final-card renderer consumes the same bounded canonical page range and render
model used for streaming. It emits Markdown and collapsible panels in their
original order. Existing large non-tool code fences continue to use the current
semantic folding behavior. Adjacent Markdown segments may be combined, but tool
panels must not be reordered relative to assistant prose.

Card payload sizing is checked after element construction. If a structured
panel would exceed the CardKit serialized payload limit despite the page budget,
the renderer falls back for that activity to its compact Markdown row. It does
not truncate a different prose segment or move canonical content to another
page during finalization.

## Page finalization and durability

Every page, including a page rolled over before the turn completes, must become
structured before it becomes immutable. Page finalization uses this ordered
lane:

1. deliver the final stream content for the page;
2. deliver `stream_finish`;
3. deliver one idempotent structured `card_update`;
4. mark the page frozen or finished;
5. only then activate delivery for the continuation page.

The SQLite transition records the structured-update intent before Lark delivery.
A retry may repeat the idempotent card update but must never repeat a TraeX
prompt. The page lifecycle must represent a pending finalization explicitly so
startup convergence can recreate a missing structured update. A page in this
state is not yet frozen and cannot accept further stream content.

Frozen pages remain immutable. The design does not patch a page after it has
entered `frozen` or `finished`. The final page follows the same sequence without
creating a continuation. Outbox lane ordering prevents the continuation card
from overtaking the prior page's structured update.

If final structured rendering or delivery exhausts its normal retry policy, the
existing delivery failure and lane-quarantine behavior applies. The canonical
Answer and page source offsets remain recoverable; no execution work is replayed.

## Compatibility and migration

Existing active or finished pages created before rollout may not contain enough
durable boundary information to reconstruct every older page safely. Startup
convergence upgrades only a page whose canonical start and end can be proven
from the current page plus its successor or terminal Answer length. Otherwise it
leaves the visible page unchanged. No terminal-text fallback or heuristic page
adoption is introduced.

No schema migration rewrites canonical answer text. Any new page lifecycle value
or finalization checkpoint is added through an idempotent SQLite migration.

## Testing

Focused tests cover:

- exact recognition of successful, running, and failed command blocks;
- compact live rows and ordered final panels around assistant prose;
- commands without output and non-command activities remaining rows;
- malformed and assistant-authored lookalike markers remaining Markdown;
- long commands, output folding, payload fallback, and secret redaction;
- source-aware pagination retaining canonical monotonic offsets;
- rollover ordering: content, finish, structured update, then continuation;
- restart recovery while page finalization is pending;
- frozen pages rejecting later patches;
- static-delivery fallback and terminal final-page convergence.

Verification runs the focused renderer, Answer workflow, outbox, and SQLite
tests, followed by `npm run typecheck`, `npm run build`, and the full `npm test`
suite because the change spans presentation, persistence, and recovery.

## Non-goals

- Pixel-perfect ANSI color or terminal-layout reproduction.
- Rendering hidden reasoning or terminal UI chrome.
- Making terminal output an Answer or lifecycle authority.
- Adding remote approval, stop, or arbitrary terminal controls to Answer Cards.
- Changing the 9,000-character default or canonical Answer retention policy.
