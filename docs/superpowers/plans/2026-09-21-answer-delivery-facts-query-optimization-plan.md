# Answer Delivery Facts Query Optimization Plan

## Objective

Replace the Primary Answer delivery-facts full-history scan with bounded,
structurally filtered SQLite lookups while preserving every observable delivery
fact and all persistence semantics.

## Work packages

### 1. Characterize the production store seam

- Add a history-heavy `SqliteBindingStore` test containing unrelated Prompt,
  page, kind, and state rows.
- Assert newest content, pending finish, next-page continuation, and final-fold
  state through `getAnswerPageDeliveryFacts()`.
- Add a legacy row with null stream metadata and assert payload-based fallback.

### 2. Implement targeted lookups

- Query the newest structurally identified content row with `ORDER BY
  delivery_order DESC LIMIT 1`.
- Use `SELECT 1 ... LIMIT 1` for pending finish and continuation facts.
- Query the final-fold idempotency-key family directly and select its newest row.
- Parse only the selected content row and bounded legacy null-metadata candidates.
- Keep the store interface and result shape unchanged.

### 3. Verify query behavior and compatibility

- Run focused Answer workflow, Answer planning, SQLite store, and migration tests.
- Inspect query plans against the existing Prompt/kind/state indexes.
- Confirm no schema, migration, outbox mutation, delivery state, or frozen-page
  behavior changes.

### 4. Synchronize docs and finish

- Update `docs/architecture.md` with the bounded Answer-facts read path.
- Run documentation and architecture checks, typecheck, build, public audit, and
  the full Vitest suite.
- Review the final diff, archive the completed design and plan, and commit the
  implementation without pushing or restarting.
