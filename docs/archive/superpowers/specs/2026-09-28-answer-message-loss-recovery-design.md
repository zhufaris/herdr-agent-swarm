# Answer Message-Loss Recovery Design

## Scope

Fix two independently verified gaps in the native Herdr-events Answer path:

1. A rich-text page rolled over after Feishu error `230072` can later fail to
   create its own continuation because the recovery payload loses the structured
   timeline cursor and falls back to an unrelated legacy character offset.
2. Herdr Core `record_skipped` events are silently discarded, leaving no visible
   indication that one transcript record could not be projected.

Title rendering and `update_plan` filtering are outside this change.

## Continuation recovery

The durable page checkpoint is authoritative. When edit-limit recovery freezes a
rich-text page, the replacement page payload must include the same delivered
timeline cursor used to create its checkpoint. Subsequent target validation then
compares structured cursors and does not depend on the compatibility `pageStart`
integer. This preserves existing idempotency keys and transaction boundaries.

Existing historical continuation intents without `startCursor` remain subject to
the legacy validation rule. Startup recovery may roll their unclaimed creating
page back through the existing stale-quarantine mechanism; no prompt is replayed.

## Skipped source records

A `record_skipped` event becomes one stable failed Tool timeline item. Its label
states that a Herdr source record was omitted and its compact result contains only
the bounded error code. It must not expose raw transcript data or guess whether
the skipped record was prose, a call, or a result. Processing continues so later
messages and lifecycle events remain deliverable.

## Verification

- Reproduce a second rich-text continuation after edit-limit rollover where the
  structured cursor advances but the compatibility offset decreases.
- Assert that the recovery intent carries `startCursor` and passes target
  validation.
- Assert that `record_skipped` produces one visible failed timeline item and that
  the following final Answer still completes normally.
- Run focused tests, TypeScript checking, build, and the full suite because the
  changes cross event ingestion, persistence, and delivery validation.
