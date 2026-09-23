# Source-Aware Markdown Pagination Implementation Plan

## Objective

Make long Primary Answer and Worker Turn Card pagination proportional to one
source-index pass plus one selected-page render, while preserving existing
rendered Markdown and canonical continuation offsets.

## Public test seams

- `renderLarkMarkdownPage` and `renderLarkMarkdownPageWithSuffix`: rendered page
  text, bounded length, monotonic canonical `nextPageStart`, and final-page null.
- Primary presentation `answerStreamPage`: continuation suffix and canonical page
  boundary compatibility.
- Worker presentation `workerTurnPage`: shared renderer behavior after redaction.

Tests will not import or inspect the private page index or its traversal state.

## Work packages

### 1. Characterize bounded work at the public renderer seam

- Add a test-only optional diagnostics callback to the public page-render options,
  or an equivalent public-result-neutral seam, that reports source characters
  indexed and canonical ranges rendered.
- Add a failing 512 KiB mixed-Markdown test proving that one page does not first
  render the complete suffix and does not repeatedly render candidate ranges.
- Keep timing out of the CI assertion; record wall-clock measurements separately.

### 2. Build the ephemeral source index

- Parse source lines and Markdown blocks once per render call.
- Derive safe canonical boundaries and atomic tool-activity ranges from the same
  indexed source representation instead of rescanning the raw source.
- Preserve block metadata needed to close and reopen fences and wrap tables/diffs.

### 3. Select and render one page

- Traverse safe candidates forward from `pageStart`, maintaining bounded rendered
  length without rendering the complete remaining source.
- Stop after the first overflowing candidate and render only the selected range.
- Retain forced progress for a long line and reserve the continuation suffix only
  after overflow is proven.
- Run existing Markdown tests after each behavioral slice and add compatibility
  fixtures whenever a discovered transform changes source-to-rendered length.

### 4. Verify both presentation paths

- Add or extend Primary Answer coverage for a late page in a 512 KiB source.
- Add Worker Turn Card presentation coverage using the same long-source shape and
  assert redaction plus canonical offsets remain correct.
- Run focused Markdown, Answer stream, Worker Card, and affected integration tests.

### 5. Measure, review, archive, and commit

- Repeat the baseline benchmark at early, middle, and late page starts and record
  the before/after measurements in the implementation handoff.
- Run `npm test`, `npm run typecheck`, `npm run build`,
  `npm run architecture:check`, `npm run docs:audit`, `npm run public:audit`, and
  `git diff --check`.
- Review against the approved design and repository standards.
- Update `docs/architecture.md`, archive the completed design and plan, remove them
  from the active index, and commit without installing, restarting, or pushing.

## Guardrails

- Do not change SQLite, outbox identities, page limits, durable source offsets, or
  frozen-page behavior.
- Do not add a process-global parser cache or persist render indexes.
- Do not weaken Markdown sanitization or secret redaction.
- Do not use a wall-clock threshold as a test assertion.
