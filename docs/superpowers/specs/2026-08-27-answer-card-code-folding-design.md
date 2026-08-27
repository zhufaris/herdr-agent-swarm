# Final Answer Card Code Folding Design

## Goal

Keep completed Feishu Answer Cards readable when one page contains a large code,
log, diff, JSON, or configuration block. The final card shows prose normally
and collapses only an oversized fenced code block behind a CardKit disclosure
panel.

## User-visible behavior

During streaming, Answer Cards retain the existing single Markdown element and
native CardKit typewriter behavior. No fold panel is created while the page is
mutable.

After a page has successfully received its terminal `stream_finish`, the bridge
publishes one replacement snapshot of that same completed CardKit entity:

- ordinary prose, short fenced blocks, tables, and non-code Markdown remain
  ordinary Markdown elements;
- each complete fenced code block with more than 80 source lines or more than
  6,000 characters becomes a collapsed `collapsible_panel`;
- the panel title is `代码块（已折叠 +<N> 行）` when no language is known, or
  `<Language> 代码（已折叠 +<N> 行）` for a known fence language;
- the panel body preserves the code block as a fenced Markdown block, including
  its original language identifier and all code characters;
- the panel is initially collapsed and can be expanded by the user locally in
  Feishu.

The number shown is the number of code lines in the collapsed block. A block
with 81 lines displays `+81 行`; this is not an omitted-line count because no
code is discarded.

## Scope and page boundary

Folding is a final-page presentation upgrade, not a new pagination mechanism.
It runs independently for each completed Answer page using that page's existing
canonical `source_start` and the same source-aware renderer used for streaming.
Code is never combined across Answer pages. A code fence reopened by the existing
page renderer is handled as the complete rendered block of that page.

The original 9,000-character Answer page limit remains authoritative. The final
snapshot reuses the already bounded render copy for the page; folding only
changes CardKit element structure. It must not increase a page's canonical
content, change the source offset, or alter continuation boundaries.

## Delivery and lifecycle

The order is deliberately two-stage:

1. The existing durable `stream_finish` finalizes the active streaming page.
   Its delivery is the authority that the page is terminal and no longer mutable.
2. Only after that acknowledgement, `AnswerPageWorkflow` reserves one ordinary
   durable `card_update` intent targeting the same Answer message. Its payload is
   the completed structured card. The durable outbox retries this visual upgrade
   independently.

If the second step fails, the already finalized streaming card remains readable
and correct. Retrying this card update must not reopen the page, resend stream
content, change a sequence number, create a new Answer Card, or replay the
TraeX prompt.

The store records/deduces whether the page's final presentation snapshot has
already been reserved or delivered from the durable outbox record and its stable
idempotency key. This requires no new Answer-page lifecycle state and no schema
migration. The normal Answer-card update lane remains ordered and retryable.

## Architecture

### Pure final-content renderer

`src/cards/run-card.ts` gains a pure final Answer-page rendering path separate
from the stable streaming element. Given a `RunCardView`, page number, and the
already rendered bounded page Markdown, it produces the same header and metadata
as the completed Answer Card plus a sequence of Markdown and collapsible-panel
elements.

The parser is deliberately narrow: it recognizes only complete, line-oriented
triple-backtick fences in the already render-safe page Markdown. It preserves
unrecognized or malformed input as normal Markdown. It does not implement a new
Markdown parser and does not mutate canonical answer text.

### Page convergence

`AnswerPageWorkflow` remains the sole owner of Answer-page convergence. Once it
observes a finished terminal page, it regenerates that page's bounded render copy
from canonical answer text and asks the store to atomically reserve the final
Answer-card update. The workflow does not call Lark directly.

The SQLite store gains a narrowly named semantic reservation that verifies the
finished page identity, checks for the stable final-card idempotency key, and
inserts a normal `card_update` outbox intent only once. No durable card body is
stored outside the existing outbox payload.

The existing outbox dispatcher already delivers `card_update` through
`LarkPort.updateCard`. It continues to assert that the target is the current
Answer message before delivery and uses its normal retry/quarantine policy.

## Invariants

- Streaming pages keep one stable Markdown `element_id`; no fold panel appears
  before `stream_finish` is delivered.
- Only `finished` terminal pages receive the upgrade. A `frozen` page that has
  a continuation is never rebuilt into fold panels.
- Canonical `RunCardView.answer`, `answerSegments`, `answerDraft`, and page
  `source_start` values never change.
- The 9,000-character page limit, page sequence, continuation creation, and
  stale stream dismissal rules do not change.
- No new Lark action, remote TraeX control, prompt replay, or user-controlled
  server callback is introduced.
- Existing secret redaction and Markdown safety transformations remain upstream
  of folding.

## Edge cases

- A code block exactly 80 lines and at most 6,000 characters remains expanded.
  The 81st line or 6,001st character triggers folding.
- A long single-line minified JSON block folds by character count and shows
  `+1 行`.
- A closing fence absent from the final render copy stays ordinary Markdown;
  folding never guesses a missing fence.
- Adjacent eligible code blocks become separate panels. Prose between them stays
  in its original order.
- A final Answer Card with no eligible block may still use the normal completed
  rendering path; no visual-only update is reserved when it would be byte-for-
  byte equivalent to the existing final card structure.
- `failed` terminal pages do not receive the folding upgrade in this slice.

## Verification

- Unit tests cover below-threshold code, 81-line code, 6,001-character
  single-line JSON, language titles, multiple blocks, malformed fences, and
  preservation of surrounding prose/code.
- Card tests prove streaming cards still have the stable Markdown element and
  final structured cards contain collapsed panels only after explicit final
  rendering.
- Answer-page workflow/store tests prove an update is reserved only after a
  terminal `stream_finish` delivery, is idempotent across repeated convergence,
  targets the current Answer message, and does not alter page lifecycle or
  sequences.
- Outbox tests prove a failed visual-upgrade `card_update` retries without any
  stream-content, stream-finish, continuation, or TraeX replay side effect.
- Run focused CardKit, Answer-page planner/workflow, store, and outbox tests,
  then `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`.

## Non-goals

- No folding of live streaming output, whole Answer Cards, prose, or main cards.
- No arbitrary Markdown AST, copy button, expand/collapse action callback, or
  persistent per-user expansion preference.
- No changes to long-message head/tail previews, page sizing, typed transcript
  ingestion, or Pane-output reconciliation.
