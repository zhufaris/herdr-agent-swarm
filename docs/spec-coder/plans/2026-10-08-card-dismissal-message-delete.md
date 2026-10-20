# Plan: Card dismissal deletes the visible Feishu message

Specification: `docs/spec-coder/specs/2026-10-08-card-dismissal-message-delete.md`

Workspace: repository root (in-place, serial).
Starting revision: `acd05b8aba1db01c01c086075aa3570d3b054e63`.
Baseline: `npm test`, `npm run typecheck`, and `npm run build` passed on
2026-10-08 before planning. Pre-existing untracked paths remain excluded.

Gate 1, Gate 2, and Gate 3 implementation authorization are approved. The
checkboxes below are the authoritative task state.

## Tickets

- [x] T1: Persist and settle one auditable Card Dismissal delete effect

  - **What to build:** Add the forward-only SQLite Card Dismissal audit model,
    its unique exact-card idempotency constraint, and a Store capability that
    atomically records a validated dismissal with a deterministic
    `message_delete` Outbound Reply. Extend message-delete acknowledgement and
    failure settlement so the audit records `deleted`, `already_absent`, or
    preserved recovery evidence.
  - **Spec references:** SCN-1, SCN-2, SCN-4, SCN-5; INV-1, INV-3, INV-4,
    INV-5; Architecture and Compatibility & Migration.
  - **Dependencies / Blocked by:** None.
  - **Delegation eligibility:** Bounded and reversible source change with
    focused store/outbox tests, but current session policy permits no proactive
    subagent delegation. Main-local execution is required for this ticket.
  - **Delegation mode:** Main-local; no applicable user authorization to spawn.
  - **Ownership and implementation path:** SQLite migration and Store own
    Card Dismissal persistence and transactionality; the existing outbox owns
    the external effect and settlement. The capability accepts only a
    validated exact message identity and stable action semantic identity.
  - **Mutation ownership:** SQLite schema/migrations, the relevant Store and
    capability ports, outbox settlement wiring, and focused tests only.
  - **Exclusions:** Card action routing, Lark SDK changes, arbitrary-message
    deletion, legacy retirement changes, and all unrelated schema cleanup.
  - **Isolation:** Serial shared checkout. This ticket touches shared schema
    and outbox seams and cannot run in parallel with T2.
  - **Concurrency conflicts:** Conflicts with T2 by design; unique SQLite
    constraint and deterministic key prove callback convergence.
  - **Verification seam:** Migration/reopen and Store integration tests assert
    atomic commit/rollback, duplicate convergence, and settlement for both
    `deleted` and `already_absent`; focused outbox tests cover retry/failure.
  - **Host capacity:** Not applicable; execute main-local. Any future child
    brief would state `delegation_allowed = false` and prohibit spawning,
    staging, and committing.
  - **Acceptance criteria and verification:** A new Card Dismissal persists
    exactly one linked message-delete effect; no external delete is possible
    before the commit; duplicate request returns the existing effect; success
    and already-absent settle accurately; uncertain/dead-letter remains
    recoverable. Run focused Vitest, typecheck, and build.

- [x] T2: Route every user dismiss/ignore action through Card Dismissal

  - **What to build:** Make all existing user-triggered Human Review Ignore,
    Primary completion Ignore, Worker completion Ignore, dead-letter dismiss,
    and equivalent dismiss paths request T1's atomic Card Dismissal instead of
    leaving or patching their source card. Successful deletion emits no
    acknowledgement replacement card.
  - **Spec references:** SCN-1 through SCN-4; INV-1 through INV-5;
    Architecture and Behavior & Failure Modes.
  - **Dependencies / Blocked by:** T1.
  - **Delegation eligibility:** Bounded behavior work with integration-test
    seams, but current session policy permits no proactive subagent delegation.
    Main-local execution is required.
  - **Delegation mode:** Main-local; no applicable user authorization to spawn.
  - **Ownership and implementation path:** Existing Card Action and delivery
    recovery workflows retain authorization and semantic consumption; they pass
    their already validated exact source card identity into the Store capability
    from T1. They do not call Lark or choose a message heuristically.
  - **Mutation ownership:** Card interaction, completion-action, and delivery
    recovery workflows; their domain ports and focused card-action/integration
    tests. It may adjust T1-owned interfaces only as needed and serially.
  - **Exclusions:** New Feishu commands, changes to automatic/systems deletes,
    rewriting legacy retirement, physical SQLite deletion, or changing
    authorization rules.
  - **Isolation:** Serial shared checkout after T1's accepted commit.
  - **Concurrency conflicts:** Cannot overlap T1; actions must preserve their
    current stale and unauthorized rejection behavior while sharing T1's unique
    deletion identity.
  - **Verification seam:** Existing Primary/Worker completion, card-action,
    Human Review, and dead-letter workflow tests demonstrate exact target
    deletion; stale/unauthorized and duplicate callbacks produce no unrelated
    delete or acknowledgement update.
  - **Host capacity:** Not applicable; execute main-local. Any future child
    brief would state `delegation_allowed = false` and prohibit spawning,
    staging, and committing.
  - **Acceptance criteria and verification:** Every in-scope action produces
    one exact delete intent after semantic validation; the source card vanishes
    on confirmed acknowledgement; failures preserve recovery evidence; no
    success tombstone/operation-result card remains. Run focused Vitest,
    typecheck, build, then full `npm test` during delivery.

## Delivery checks

- Confirm T1 and T2 cover SCN-1..SCN-5 and INV-1..INV-5.
- Review the final diff for direct Lark deletes from coordinators, missing
  authorization checks, physical history deletion, and changes to excluded
  automatic deletion routes.
- Run all affected tests, `npm run typecheck`, `npm run build`,
  `npm run architecture:check`, and full `npm test`.
- Commit each completed ticket separately with explicit task-owned paths; do
  not push or deploy without separate authorization.
