# Answer Delivery Facts Query Optimization

## Goal

Make Primary Answer convergence cost independent of retained outbox history while
preserving the existing delivery, retry, frozen-page, and no-replay behavior.

## Current problem

`SqliteProjectionStore.getAnswerPageDeliveryFacts()` loads every retained Answer
outbox row for a Prompt, sorts the rows, parses every payload, and then derives
four facts for one page. Answer convergence invokes this repeatedly while content
streams and again inside reservation transactions. A stream with many retained
snapshots therefore repeatedly revisits old rows and trends toward quadratic work.

The outbox already persists `prompt_id`, `kind`, `state`, `delivery_order`,
`stream_page_index`, and `stream_element_id`. These columns are the durable query
surface and should be used before decoding payload JSON.

## Selected design

Keep the existing `AnswerPageStore` interface and `AnswerPageDeliveryFacts`
result unchanged. Replace the broad query with four narrow lookups:

1. Load the newest `stream_content` row for the requested Prompt and page, ordered
   by descending delivery order. Parse only that row's payload to recover content,
   sequence, and source coverage.
2. Test whether a pending `stream_finish` exists for the requested page.
3. Test whether a pending `stream_card_create` exists for the next page.
4. Load the newest final-fold `card_update` state using its exact idempotency-key
   family and descending delivery order.

The lookups use structural columns wherever they are present. Historical Primary
Answer rows created before stream metadata existed may have null
`stream_page_index` or `stream_element_id`; only this null-metadata subset receives
a compatibility fallback that parses candidate payloads. The normal path never
loads or parses unrelated pages or kinds. No schema migration or new index is
required for this slice because existing Prompt/kind/state and Prompt/role/state
indexes bound candidate selection. An index may be considered later only if query
plans on production-sized data justify it.

## Compatibility requirements

- Do not change `AnswerPageStore`, `AnswerPageDeliveryFacts`, or workflow callers.
- Preserve the current state set: pending, delivered, dead-letter, and dismissed
  rows remain visible where they are visible today.
- Preserve newest-by-`delivery_order` selection.
- Preserve element-ID matching and page-index fallback for legacy payloads.
- Preserve pending finish and next-page continuation detection.
- Preserve exact and revisioned final-fold idempotency keys.
- Do not delete, coalesce, retry, or otherwise mutate outbox rows.
- Do not alter frozen Answer pages, CardKit rendering, or delivery lanes.

## Testing

Tests remain at the production SQLite store seam. Add a history-heavy case with
unrelated Answer rows, multiple pages, and mixed states, then assert the same four
facts as the current implementation. Add a legacy null-metadata case to prove the
fallback. Existing Answer workflow, outbox, historical migration, and full SQLite
tests remain the regression suite.

Verification includes focused Answer/SQLite tests, typecheck, build, architecture
and documentation checks, public audit, and the full Vitest suite.

## Non-goals

- No new projection table or migration.
- No durable outbox coalescing changes.
- No change to how often workflows request convergence.
- No Worker Answer refactor; its equivalent lookup is already structurally scoped.
