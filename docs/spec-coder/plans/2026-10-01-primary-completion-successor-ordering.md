# Primary Completion Successor Ordering Plan

Specification:
[`docs/spec-coder/specs/2026-10-01-primary-completion-successor-ordering.md`](../specs/2026-10-01-primary-completion-successor-ordering.md)

Workspace: in-place checkout on `main`, starting at
`9aaeca511ad81e8eacf9279096a223ec26f86e12`. Initial unrelated untracked paths
recorded in the specification remain outside this plan's ownership.

Baseline:

- `npx vitest run tests/sqlite-store.test.ts`: 437 passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.

Approval status: Gate 1 design approved; Gate 2 specification approved; Gate 3
ticket authorized; T1 implementation complete.

## Tickets

- [x] **T1: Release Primary completion notification despite historical nonterminal predecessors**

  **What to build:** Change the Primary completion notification successor check
  so only a same-Binding, same-generation, nonterminal Prompt strictly later in
  canonical FIFO order `(created_at, rowid)` suppresses the notification.
  Historical predecessors, including `uncertain` Prompts, must not suppress a
  newly completed Prompt.

  **Spec references:** SCN-1, SCN-2, SCN-3; INV-1 through INV-4; Architecture;
  Behavior & Failure Modes.

  **Ownership and implementation path:** `PrimaryNextInputNotification` remains
  the enforcing persistence module. Keep `releasePrimary(promptId, render)` and
  all callers unchanged. Extend its transactional SQLite query with canonical
  FIFO ordering against the current Prompt. Do not modify schema, historical
  rows, Worker policy, Answer gates, mention selection, or outbox contracts.

  **Acceptance criteria and verification:**

  - A focused test fails before the implementation because an older
    same-generation `uncertain` Prompt suppresses the completed Prompt.
  - The test proves that equal `created_at` values use insertion `rowid`, and
    that exactly one Primary notification containing the expected actor mention
    is reserved after final Answer delivery.
  - Existing parameterized tests prove later `queued`, `submitted`, `running`,
    `recovering`, and `uncertain` successors still suppress.
  - `npx vitest run tests/sqlite-store.test.ts`, `npm run typecheck`, and
    `npm run build` pass before the atomic commit.
  - Review confirms the diff changes no public interface or dependency
    direction and includes no unrelated paths.

  **Blocked by:** None.

## Final Delivery Checks

- Review the full task diff findings-first against the approved specification.
- Run the full `npm test` suite freshly.
- Re-run `npm run typecheck` and `npm run build` if delivery repairs alter source
  or tests after the ticket verification.
- Confirm no temporary debug instrumentation or unrelated files are staged.
- Confirm one atomic Conventional Commit contains only the specification, plan,
  test, and implementation owned by T1.
