# Streaming Markdown Code Fence Design

## Goal

Render fenced code blocks such as ` ```bash ` correctly in CardKit streaming
Answer cards, including while a block is still being streamed and when an
answer rolls over to a continuation card. Preserve the language identifier when
CardKit supports it and otherwise retain a valid plain fenced code block.

## Rendering boundary

The persisted Answer stream remains the canonical, unmodified content. Before
creating or updating a CardKit Markdown element, the bridge derives a
render-only copy. This keeps storage, prefix detection, retries, and final-answer
deduplication independent from syntax repairs required by the client renderer.

The same rendering function is used for the initial Markdown element and every
`cardElement.content` update. An open backtick fence is closed in that render
copy, while the canonical stream stays open and can accept further content. A
later cumulative update regenerates the complete render copy from the canonical
content.

## Pagination

Answer pagination must not leave either page with an invalid fence. When the
page boundary falls inside a fenced block, the outgoing page receives a closing
fence and the continuation page receives a matching opening fence, including
the original language identifier such as `bash`. The inserted boundary markers
exist only in the per-page render representation and are not treated as model
output.

Where possible, pagination prefers a newline outside a fenced block. If no safe
boundary is available before the CardKit limit, it splits on a line boundary
inside the block and performs the close-and-reopen transformation. It must not
drop or duplicate source characters.

## Compatibility fallback

The primary output preserves supported language identifiers, especially
`bash`. If CardKit rejects an update specifically because of an unsupported
fence language, retry the same render copy with the language identifier removed
from opening fences. Other delivery failures follow the existing durable retry
path and must not silently alter content.

## Verification

Regression tests cover a complete Bash fence, an incomplete fence during a
stream update, subsequent cumulative content after the temporary render-only
closure, and rollover inside a Bash fence. Integration coverage asserts the
exact content passed to `streamCardContent`, not only the stored Answer text.
The focused tests, full test suite, typecheck, build, and `git diff --check` must
pass before completion.
