# Lark card Markdown compatibility

## Goal

Render TraeX user-facing answers as predictable, safe CardKit Markdown while
preserving useful document structure. Markdown normalization happens after the
existing terminal-output and credential filters and before card-size limiting.
Execution progress remains code-owned structured text and never accepts raw
Markdown from terminal output.

## Supported syntax

The answer region preserves headings, emphasis, strikethrough, ordered and
unordered lists, block quotes, horizontal rules, inline code, fenced code blocks
with optional language names, and ordinary links. These constructs are passed to
the CardKit `markdown` element after normalization.

The normalizer does not implement a general Markdown parser or fetch referenced
resources. Its output is a conservative subset intended for Lark rendering.

## Compatibility conversions

Image syntax is converted to an ordinary link. For example:

```markdown
![Architecture](https://example.com/architecture.png)
```

becomes:

```markdown
[图片：Architecture](https://example.com/architecture.png)
```

The bridge does not download, proxy, upload, or embed the image. Empty alt text
uses `图片` as its visible label.

Markdown tables are converted to fenced `text` code blocks. This preserves the
rows without depending on CardKit table support or producing inconsistent client
layouts. Table recognition requires a header row followed by a delimiter row;
ordinary prose containing pipe characters is not converted.

HTML tags and comments are removed. Their plain inner text remains where
possible, but HTML attributes and executable markup are discarded.

## Link safety

Only absolute `http://` and `https://` destinations remain clickable. Links using
`javascript:`, `data:`, `file:`, or another protocol are replaced by their visible
label. Relative destinations and malformed URLs are also reduced to visible text
because Lark has no stable repository-relative navigation context.

The normalizer must not inspect or rewrite Markdown link-like text inside fenced
code blocks or inline code spans. Existing credential filtering still applies to
the source answer before Markdown normalization.

## Streaming and truncation

While a response is streaming, an unfinished fenced code block is closed in the
rendered copy so every CardKit update contains valid Markdown. The stored answer
remains unchanged, allowing later deltas to complete the original fence. The
final render applies the same normalization deterministically.

Card-size limiting operates on normalized Markdown. If the answer must be
truncated, the renderer appends an explicit truncation marker and closes any code
fence left open by the cut. Progress entries are still removed before answer
content is truncated.

## Component boundary

A pure Markdown normalizer accepts an answer string and returns CardKit-compatible
Markdown. It performs no I/O and has no Lark SDK dependency. The request-card
renderer invokes it only for the answer region. The TraeX output parser remains
responsible for deciding which content is safe enough to become an answer; the
Markdown normalizer is not a replacement for output safety filtering.

## Verification

Automated tests must demonstrate that:

1. headings, lists, quotes, emphasis, inline code, and fenced code are preserved;
2. images become ordinary safe links without network access;
3. Markdown tables become fenced text blocks;
4. HTML markup is removed while safe visible text remains;
5. only HTTP and HTTPS links remain clickable;
6. link-like content inside fenced and inline code is unchanged;
7. unfinished streaming fences are closed only in the rendered copy;
8. truncation produces valid fenced Markdown and an explicit marker; and
9. request-card rendering places normalized Markdown in the answer region without
   changing structured progress rendering.

## Non-goals

- Rendering remote images inside a card.
- Uploading files or images to Lark.
- Full CommonMark or GitHub Flavored Markdown compatibility.
- Executing HTML, supporting embedded media, or resolving relative links.
- Applying user-authored Markdown to execution-progress events.
