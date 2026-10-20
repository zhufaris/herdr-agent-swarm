# Feishu Rich-Text Edit-Limit Recovery Implementation Plan

**Goal:** Recover Primary and Worker rich-text Answers by creating one continuation message when Feishu rejects an update with `230072`.

**Design authority:** `docs/superpowers/specs/2026-09-27-feishu-rich-text-edit-limit-recovery-design.md`.

## Invariants

- Never replay an Agent prompt.
- Treat the rejected snapshot as undelivered.
- Continue from the last successfully delivered timeline cursor.
- Freeze the exhausted message and never update it again.
- Reserve the continuation durably and idempotently in the existing Answer lane.
- Fence recovery by the exact Primary binding or Worker generation, turn, page, and message identity.
- Do not add an edit counter or change the 9,000-character page budget.

## Task 1: Lock failure classification

**Files:**

- Modify `src/domain/delivery.ts`
- Modify `src/gateways/contract/plugin.ts`
- Modify `src/gateways/feishu/errors.ts`
- Modify `tests/feishu-delivery-errors.test.ts`

Add `message_edit_limit` as a recovery kind. Assert that Feishu code `230072`
maps to it only for `update_rich_text` on Primary Answer and Worker-turn Answer
intents; all other operation/purpose combinations remain ordinary permanent
rejections.

## Task 2: Implement the atomic Primary rollover

**Files:**

- Modify the Answer projection/recovery store and its narrow port
- Modify `tests/answer-page-workflow.test.ts` and focused SQLite tests

Given the failed claimed update, verify the active `rich_post` page and message,
freeze it without advancing delivery coverage, create the next page at the last
delivered timeline cursor, and reserve one idempotent continuation reply. Link
the failed reply to the replacement and make repeated recovery a no-op.

## Task 3: Implement the atomic Worker rollover

**Files:**

- Modify the Worker-turn projection/recovery store and its narrow port
- Modify focused Worker Answer tests

Apply the same recovery contract with Worker instance/session generation and
turn fencing. Share policy and small payload helpers, while retaining separate
aggregate-specific store transitions.

## Task 4: Wire delivery failure recovery

**Files:**

- Modify `src/store/sqlite/outbox-recovery/failure-transition.ts` and related facade wiring
- Modify `src/events/outbound-delivery-executor.ts` only if its existing wake contract is insufficient
- Modify focused dispatcher/recovery tests

Recognize `message_edit_limit` after the failed update is durably dead-lettered,
reserve the appropriate continuation in the same transaction, release the lane,
and wake delivery. Mark the recovery resolved only after the established
replacement checkpoint semantics are satisfied. Do not recursively recover a
failed continuation create.

## Task 5: Verify regression and operational behavior

Run focused tests for Feishu classification, Primary Answer, Worker Answer,
SQLite recovery, and outbox dispatch. Then run:

```bash
npm run typecheck
npm run build
npm test
npm run architecture:check
npm run docs:audit
git diff --check
```

Review the final diff against the dirty-worktree baseline, commit only files
owned by this fix, and leave installation/restart behind the live-work safety
gate.
