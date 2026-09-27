# Answer Page Length Design

## Goal

Show more Answer content on each page while retaining durable, source-aware pagination.

## Design

- Raise the default Primary and Worker Answer page limit from 9,000 to 12,000 UTF-16 code units.
- Budget rich-text pages from the compact Markdown document that is actually delivered. Do not reuse the CardKit-panel JSON budget, because hidden tool-panel payloads are substantially larger and caused visibly short rich-text pages.
- Keep the existing 28,000-character mutable stream ceiling and configured maximum unchanged.
- Continue splitting at safe Markdown boundaries, reserving continuation text space, freezing completed pages, and carrying the canonical source cursor to the next page.
- Existing installations must receive the new 12,000 value in generated runtime configuration; explicit operator overrides remain valid.

## Verification

- Default configuration and generated setup files use 12,000.
- Primary and Worker page planners share the same default.
- A tool-heavy rich-text page fills most of its Markdown budget before producing a continuation cursor.
- Markdown and multi-page recovery tests continue to pass.

