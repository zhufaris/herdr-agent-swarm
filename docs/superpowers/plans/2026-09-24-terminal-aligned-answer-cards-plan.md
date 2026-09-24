# Terminal-Aligned Answer Cards Implementation Plan

## Objective

Project new Primary and Worker turns as one durable chronological Answer timeline
whose Agent text and collapsed Tool panels follow canonical Herdr transcript order,
without changing prompt execution, remote-control policy, or legacy card recovery.

## Invariants

- SQLite is the durable source of timeline ordering and state.
- Transcript parsing and redaction happen before persistence.
- Lark rendering never parses raw TraeX envelopes.
- Frozen Answer pages are immutable and external effects are never replayed.
- Existing answer text and historical rows remain readable.
- Primary and Worker Answer cards share the same timeline semantics and renderer.

## Work package 1: Typed transcript timeline

### Tests

- Extend transcript projector tests with interleaved Agent message, tool call, tool
  result, and final answer fixtures.
- Prove stable item IDs and order across repeated reads.
- Prove Agent fragments do not merge across a tool boundary.
- Prove reasoning, protocol envelopes, ANSI content, and secret shapes do not enter
  emitted items.

### Implementation

- Add domain types for timeline items and deltas.
- Extend `TraexTranscriptObservation` with optional timeline deltas.
- Teach `TraexTranscriptProjector` to correlate calls/results and emit ordered,
  bounded, redacted items while retaining existing answer/progress output.
- Keep the new field optional so other Agent drivers and legacy tests remain valid.

### Gate and commit

- Run transcript projector/parser, redaction, and domain reducer tests.
- Run typecheck and `git diff --check`.
- Commit `feat: project terminal-aligned answer events`.

## Work package 2: Durable timeline projection

### Tests

- Add reducer tests for append, stable-ID update, duplicate delivery, ordering, and
  terminalization of incomplete tools.
- Add migration and reopen tests for Primary and Worker timeline state.
- Verify timeline mutation and its associated view/outbox revision are atomic.
- Verify the new durable tables are covered by the instance lease fence.

### Implementation

- Add an ordered additive migration for timeline rows keyed by aggregate kind,
  aggregate ID, item ID, and sequence.
- Add one consumer-shaped SQLite capability for applying and loading timeline
  deltas inside existing outer transactions.
- Wire Primary and Worker reducers/projectors to persist timeline changes alongside
  their current answer/progress projections.
- Reconstruct views after restart from SQLite; never use an in-memory collection as
  authority.

### Gate and commit

- Run SQLite migration/store, lease, Primary view, Worker view, and event projection
  tests.
- Run typecheck, build, architecture check, and `git diff --check`.
- Commit `feat: persist answer timelines`.

## Work package 3: Shared CardKit timeline renderer

### Tests

- Verify Agent Markdown and Tool panels retain timeline order.
- Verify Tool panels are collapsed by default with category, target, and state.
- Verify command/result content is fenced, redacted, bounded, and safe for CardKit.
- Verify unknown tools degrade to a generic step.
- Verify legacy text still uses `foldFinalAnswerContent`.

### Implementation

- Add a pure shared timeline renderer under `src/cards/`.
- Reuse existing CardKit size helpers and safe Markdown helpers.
- Keep `foldFinalAnswerContent` as the no-timeline fallback.
- Use common state labels and visual tokens for Primary and Worker cards.

### Gate and commit

- Run new renderer tests plus final-answer, card-style, Primary card, and Worker card
  tests.
- Run typecheck and `git diff --check`.
- Commit `feat: render terminal-aligned answer timelines`.

## Work package 4: Timeline-aware pagination and late results

### Tests

- Verify page planning keeps Tool items whole.
- Verify oversized Tool details are truncated rather than split.
- Verify an active-page Tool transitions in place.
- Verify frozen pages never receive patches.
- Verify a late Tool result creates one linked completion item on the active page.
- Verify repeated recovery does not duplicate continuation items or pages.

### Implementation

- Extend Primary and Worker answer-page planning to consume timeline item boundaries.
- Track the last projected timeline sequence in durable page metadata.
- When the original Tool item is on a frozen page, materialize a deterministic
  completion item on the active page.
- Preserve existing create/checkpoint/freeze ordering in the durable outbox.

### Gate and commit

- Run Answer stream/page, Worker page, outbox delivery/recovery, and end-to-end card
  integration suites.
- Run typecheck, build, architecture check, and `git diff --check`.
- Commit `feat: paginate answer timelines safely`.

## Work package 5: Main-card alignment and documentation

### Tests

- Verify Primary and Worker Main cards show only the latest readable activity and
  current Tool summary.
- Verify blocked timeline items coexist with existing Human Review notifications.
- Verify Command Status cards remain separate from Agent Answer timelines.
- Verify no remote approval or arbitrary input capability is advertised.

### Implementation

- Reuse one compact activity vocabulary across Primary and Worker Main cards.
- Add the current Tool summary without copying the full Answer.
- Document terminal alignment, legacy fallback, pagination, and security boundaries
  in architecture and Feishu usage docs.
- Update the active engineering index.

### Gate and commit

- Run Main/Worker/Human Review/Command Status card suites and documentation audits.
- Run typecheck, build, architecture check, and `git diff --check`.
- Commit `docs: document terminal-aligned answer cards`.

## Final audit

1. Map every approved design requirement to code and executable tests.
2. Confirm both Primary and Worker paths use the shared timeline renderer.
3. Confirm no raw transcript envelope or unredacted Tool detail crosses the domain
   boundary.
4. Confirm migration ordering, historical-schema upgrade, lease fencing, and reopen
   behavior.
5. Run all focused suites.
6. Run `npm run typecheck`.
7. Run `npm run build`.
8. Run `npm run architecture:check`.
9. Run `npm run docs:audit`.
10. Run `npm run public:audit`.
11. Run `npm test`.
12. Run `git diff --check`.
13. Verify all new commits lack disallowed automated co-author trailers.
14. Confirm the worktree is clean.

Do not install, restart, or push unless the user separately requests those
operations.
