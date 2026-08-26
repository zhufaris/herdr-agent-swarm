# Answer Card Markdown Rendering Design

## Purpose

Improve the readability of a single TraeX Answer Card message when it contains
Markdown, fenced code, or a mixture of prose and code. The visible CardKit
content should preserve useful document structure, render code with its language
fence, and remain valid across live updates and continuation pages.

This is a presentation change. The canonical answer, prompt workflow, durable
outbox, and Answer page lifecycle remain unchanged.

## Existing constraints

- An Answer page contains one stable CardKit `markdown` element. Live updates
  replace that element's cumulative content with an increasing sequence.
- The rendered page limit remains 9,000 UTF-16 code units, including any
  render-only fence markers.
- Only the newest page is mutable. Frozen and finished pages are never patched.
- `answer_pages.source_start` remains an offset into the canonical persisted
  answer, not into a transformed rendering. Restart recovery must derive the
  same page boundaries from the same canonical answer.
- Markdown repair is render-only. It must not mutate `RunCardView.answer`,
  `answerSegments`, or `answerDraft`.
- Existing terminal filtering and secret redaction happen before presentation.
  Markdown rendering is not a replacement for those controls.

## Approaches considered

### Normalize the whole answer before pagination

This is the smallest code change and reuses the existing Markdown normalizer. It
is rejected because table conversion, HTML removal, and link rewriting change
string length. A persisted page offset would then refer to the rendered string
rather than the canonical answer, making active pages ambiguous across upgrades
and recovery.

### Persist typed Markdown segments

The bridge could store prose, code, table, and other block types separately and
render each as a dedicated CardKit element. This offers the most presentation
control, but it introduces a new persistence format and conflicts with the
single-element CardKit streaming protocol. It is disproportionate to the goal.

### Source-aware render-only pagination

This is the selected approach. A pure renderer consumes canonical source from a
persisted source offset and returns both CardKit-compatible Markdown and the next
canonical source offset. Render-only additions such as table fences and reopened
code fences count toward the 9,000-character limit but never advance the source
offset. This preserves recovery semantics while improving presentation.

## Rendering contract

The runtime exposes one page operation with the existing result shape:

```ts
interface RenderedAnswerStreamPage {
  page: string;
  nextPageStart: number | null;
}

function renderAnswerStreamPage(
  source: string,
  pageStart: number,
  limit?: number
): RenderedAnswerStreamPage;
```

`pageStart` and `nextPageStart` are canonical source offsets. `page` is a
render-only CardKit Markdown string. For identical arguments, the result is
deterministic and has no I/O or persistence side effects.

The renderer applies the existing conservative Lark Markdown policy:

- preserve headings, emphasis, strikethrough, lists, quotes, horizontal rules,
  inline code, and fenced code blocks;
- preserve a fenced code block's language identifier;
- convert Markdown tables to fenced `text` blocks for stable alignment;
- turn images into ordinary safe links without fetching them;
- retain clickable absolute HTTP and HTTPS links only;
- remove HTML tags and comments while retaining safe visible text; and
- leave link-like text inside inline code and fenced code unchanged.

The renderer does not attempt syntax highlighting beyond CardKit's fenced-code
support and does not add copy buttons, remote image loading, HTML rendering, or
another Markdown dependency.

## Block recognition and pagination

The implementation recognizes source lines as prose, fenced code, or a Markdown
table. Recognition is deliberately conservative and follows the existing
`lark-markdown.ts` rules rather than implementing full CommonMark.

Pagination prefers the latest complete line that fits. It keeps a table together
when the normalized table fits on one page. If a table or fenced code block is
larger than a page, it splits only at a line boundary when possible and closes
and reopens the render-only fence on adjacent pages. A single source line longer
than the available space is split at a hard source boundary so the workflow
always makes progress. No canonical source character is dropped or consumed
twice.

When a page begins inside a canonical fenced code block, the renderer prepends
the original opening fence, including its language identifier. When a page ends
inside the block, it appends a matching closing marker. These inserted markers
count toward the page limit but do not affect the source offsets. An unfinished
streaming fence is therefore valid in every emitted CardKit snapshot while the
stored answer remains untouched.

Synthetic `text` fences used for tables follow the same rule. An oversized table
remains visibly tabular on every continuation page even though its fence markers
do not exist in the canonical source.

## Component boundaries

`src/runtime/lark-markdown.ts` owns conservative Markdown recognition and
normalization. It gains the source-aware page renderer or focused helpers needed
to produce source-mapped render blocks. Existing bounded preview functions keep
their public behavior.

`src/runtime/answer-stream.ts` remains the Answer-specific facade. Its
`renderAnswerStreamPage` delegates Markdown page rendering while retaining the
9,000-character policy and its existing return contract.

`src/domain/answer-page-plan.ts`, SQLite schemas, coordinators, publisher logic,
and Lark adapter APIs do not change. Initial card creation, live stream updates,
continuation, and startup recovery already use `renderAnswerStreamPage`, so they
receive identical presentation behavior through one seam.

The older `splitAnswerStreamPage` helper remains compatible unless repository
usage proves it can be safely removed. It is not a second authority for durable
page planning.

## Error and fallback behavior

Malformed or incomplete Markdown is rendered as conservatively as possible. An
unfinished fence receives only a render-copy closure. A table-like sequence that
does not have a valid delimiter remains ordinary prose. Malformed and unsafe
links degrade to their visible label.

The renderer must always either consume at least one canonical source code unit
or return a terminal page. If optional decoration cannot fit in an unusually
small test limit, content progress takes priority and the smallest valid fenced
representation is used where possible. Production continues to use 9,000.

Delivery errors remain owned by the durable outbox. Presentation processing does
not add transport retries and cannot cause a TraeX prompt to be repeated.

## Testing strategy

Focused unit tests cover:

1. headings, lists, quotes, emphasis, inline code, and complete language-tagged
   code fences in an Answer page;
2. an unfinished streaming code fence closed only in the render copy;
3. a large code block split across pages with its language fence reopened and
   exact canonical source offsets preserved;
4. tables rendered as `text` fences, including a table continued across pages;
5. safe links, unsafe links, images, HTML removal, and code-literal immunity;
6. normalized output staying within the configured page limit;
7. long unbroken lines making forward progress without source loss; and
8. deterministic reconstruction of the same pages from persisted source starts.

Planner or integration coverage proves that initial Answer card creation and a
subsequent `stream_content` update both carry the normalized page produced by the
same renderer. Existing continuation and recovery tests continue proving that
frozen pages are immutable and retries do not duplicate a TraeX prompt.

Before completion, run the focused Markdown, Answer stream, page planner, and
Answer page recovery tests, followed by the full Vitest suite, TypeScript
typecheck, production build, and `git diff --check`.

## Acceptance criteria

- A single Answer Card displays supported Markdown without flattening its
  structure.
- Fenced code retains its language and indentation in complete, streaming, and
  continued pages.
- Markdown tables have a stable monospaced fallback.
- Every rendered page is valid conservative CardKit Markdown and no longer than
  9,000 characters in production.
- Canonical answer content and durable source-offset semantics do not change.
- Initial delivery, live updates, continuation, and recovery all use the same
  rendering function.
- No change weakens redaction, ordered delivery, frozen-page immutability, or the
  no-prompt-replay invariant.
