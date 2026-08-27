# CardKit Long-Message Preview Design

## Goal

Make oversized message JSON and other long CardKit text readable by keeping the
beginning and end of the canonical text and replacing the omitted middle with a
clear, deterministic summary.

## User-visible behavior

Before text enters a CardKit Markdown field, the renderer applies an
independent presentation-only preview limit:

- Main-card previews use a 2,000-character budget.
- Answer-card content uses a 9,000-character budget.
- Text at or below its budget is rendered unchanged.
- Text over its budget keeps a head and tail. The middle is replaced by exactly
  one standalone line in this form:

  ```text
  … 已省略中间 <lineCount> 行 / <characterCount> 字符 …
  ```

- The renderer chooses nearby newline boundaries for both retained portions
  whenever doing so remains within the budget. If a very long line has no safe
  newline, it cuts at an exact character boundary so rendering always makes
  progress.

For example, an oversized JSON message remains recognizably JSON-shaped in a
code block or Markdown preview: its opening fields and closing metadata remain
visible, while the omitted count makes the loss explicit. The bridge does not
promise that a truncated JSON presentation is valid parseable JSON; it promises
that it is readable and that the canonical stored content is unchanged.

## Ownership and invariants

This is a pure rendering transform only. It runs after the bridge has selected
the canonical answer/message text and before CardKit rendering. It must not
change:

- SQLite `RunCardView.answer`, answer segments, drafts, TopicView answer text,
  prompt bodies, or terminal fingerprints;
- answer-page source offsets, page lifecycle, continuation decisions, or
  CardKit stream sequence numbers;
- outbox idempotency keys, durable view versions, or delivery/checkpoint
  semantics.

The existing Markdown safety and rendering pipeline remains in charge of HTML
removal, link restrictions, code-fence repair, table/diff presentation, and
CardKit size limits. The preview transform must happen at a seam where its own
added omission marker is also accounted for by the final field-size guard.

## Architecture

Add one pure runtime helper, tentatively named
`truncateLarkMarkdownMiddle(text, maxCharacters)`, beside the existing
`truncateLarkMarkdown` and `truncateLarkMarkdownTail` helpers. It returns the
source unchanged when it fits; otherwise it returns a head, the deterministic
omission marker, and a tail. The helper reports omitted characters from the
canonical input and omitted line count as the number of newline-delimited lines
that have at least one omitted character.

Wire that helper into the two presentation seams that already impose different
budgets:

1. `renderRunCard()` / `renderProjectEntryCard()` use the 2,000-character
   main-card preview budget.
2. `renderRequestAnswerCard()` uses the 9,000-character Answer-card preview
   budget only for the initial/non-streaming card body. It must not run inside
   `renderAnswerStreamPage()` or change `answer_pages.source_start`, because
   those source offsets refer to canonical Answer text.

Existing long Answer behavior remains page continuation at the current
source-aware page limit. This feature improves compact card previews and any
one-field message JSON presentation; it is not an alternate pagination system.

## Error handling and edge cases

- A budget that cannot fit at least one source character plus a complete marker
  returns a bounded prefix rather than throwing. Production callers use 2,000
  and 9,000, so this is a defensive pure-function rule.
- Empty content remains empty. Newlines, whitespace, fenced JSON, ordinary
  prose, logs, and diff text all use the same deterministic algorithm.
- The omitted marker is treated as display text, then passes through the normal
  Markdown renderer. It contains no user-controlled Markdown syntax.
- The final render must never exceed the caller's budget. The helper reserves
  space for the marker before selecting head/tail content.

## Verification

- Unit tests cover unchanged short text, exact-boundary text, head/tail
  retention, correct omitted character and line counts, newline-preferred cuts,
  long-line fallback, and strict output-budget compliance.
- Card-render tests cover a long JSON-shaped payload on the main card and Answer
  Card, asserting the marker and both source ends appear while the canonical
  `RunCardView.answer` object is not mutated.
- Existing answer-stream tests continue to show that page source offsets and
  continuation text derive from canonical answer content rather than this
  preview copy.
- Focused tests, `npm run typecheck`, `npm run build`, and `npm test` all pass.

## Non-goals

- No CardKit button/action or in-place expand/collapse control in this slice.
- No new persistence table, viewing-state record, or full-output delivery path.
- No attempt to preserve syntactically valid JSON after display truncation.
- No change to Lark approval boundaries, Herdr ownership, terminal redaction,
  answer-page pagination, or durable reconciler projections.
