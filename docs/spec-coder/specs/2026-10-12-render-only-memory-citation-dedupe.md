# Render-only Memory Citation Deduplication

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

One canonical Segment can contain adjacent `agent_message` and `final_answer`
items with the same human-visible answer. The non-final item may additionally
carry a terminal `<oai-mem-citation>` metadata block. Current presentation
deduplication compares normalized full Markdown, so the metadata suffix makes
the two items unequal and Feishu renders the answer twice.

The metadata is protocol evidence, not user-visible answer content. Deleting or
rewriting Core events, Conversation Segment items, SQLite history, canonical
positions or source cursors would weaken recovery and is not an acceptable
presentation fix. Presentation item fingerprints and page counts may change
when hidden metadata is removed from render copies.

## Solution

Extend the existing pure `prepareAnswerTimelineItems` presentation seam with a
bounded visible-Markdown normalizer. It removes only a complete terminal
`<oai-mem-citation>` block containing both `citation_entries` and `rollout_ids`,
then applies the existing newline normalization. Both final and non-final
assistant items use that visible form for rendering; `agent_message` dedupe
compares it with the visible final-answer set.

Canonical Core/Segment items, IDs, order, canonical positions, and source
cursors remain unchanged outside the returned render copy. Presentation item
fingerprints and page counts may reflect hidden metadata. Incomplete, mid-body,
ordinary XML, and fenced literal examples remain visible and cannot trigger
deduplication.

## User Stories

### SCN-1: Citation-only suffix does not duplicate an answer

When an `agent_message` is the final visible answer plus a valid terminal memory
citation block and the following `final_answer` contains that visible answer,
Feishu renders the answer once as the final item.

### SCN-2: Metadata is hidden from the final item itself

When a final item carries a valid terminal memory citation block, presentation
retains the answer prose and omits the metadata block.

### SCN-3: User-authored or malformed content remains visible

Incomplete citation blocks, citation-like XML in the middle of an answer, and
literal examples inside a fenced code block are not stripped and do not make
distinct assistant messages equivalent.

## Implementation Decisions

### INV-1: Canonical evidence is immutable

The sanitizer runs only on copies returned by the card presentation layer. It
does not mutate Core events, timeline persistence, Segment state, canonical
positions, source cursors, recovery gaps, delivery intent identity or SQLite
history. Presentation checkpoint fingerprints and page counts may reflect the
sanitized visible copy.

### INV-2: Deduplication requires complete visible equality

After removing only the recognized terminal metadata block and normalizing line
endings/trailing blank lines, the complete visible `agent_message` Markdown must
equal one complete visible `final_answer`. Similar, prefix, suffix or partial
matches remain separate.

### INV-3: Terminal protocol recognition is narrow

Recognition requires a complete block at the end of the Markdown with the
expected root and both expected child sections. It does not parse or delete
arbitrary XML and does not search inside the body.

### ARCH-1: Presentation owns visible equivalence

`src/cards/answer-timeline.ts` remains the enforcing module because it already
owns render-only assistant deduplication. No new store, port, schema, adapter or
workflow is introduced.

## Testing Decisions

Use the public `planAnswerTimelinePage` seam. Red-Green tests prove a citation
suffix no longer duplicates visible text, terminal metadata on a final item is
hidden, and malformed/mid-body/fenced literal examples remain visible and
distinct. Existing exact-duplicate and similar-but-distinct tests stay green.

Fresh baseline on clean revision `0d6d3bb29bfc04819b1e7186d7752db4617f232f`:

- `npx vitest run tests/answer-timeline-page.test.ts tests/answer-timeline-card.test.ts`: 2 files / 66 tests passed.
- `npm run typecheck`: passed.

## Out of Scope

No Core/TraeX protocol change, event deletion, SQLite migration, historical data
rewrite, pagination-offset change, generic XML sanitizer, memory citation
validation service, choice-list protocol change, Feishu API change or production
database mutation is included.

## Further Notes

Three approaches were compared. Core-side deletion was rejected because it
changes canonical evidence. Global XML stripping was rejected because it can
remove user content. The selected render-only terminal-block recognizer reuses
the existing deep presentation seam and preserves all recovery authority.

Workspace mode is in-place inside the existing isolated deployment worktree
`/tmp/herdr-agent-swarm-main-ring-stability-20261012`, branch `main`, starting
revision `0d6d3bb29bfc04819b1e7186d7752db4617f232f`. The worktree was clean,
locked dependencies were present, and the original user checkout remains
untouched. The user's `继续完成` directive authorizes completing this final
bounded pending task.
