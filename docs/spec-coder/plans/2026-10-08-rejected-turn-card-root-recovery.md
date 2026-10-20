# Plan: Recover rejected Turn Card root creates

Specification: `docs/spec-coder/specs/2026-10-08-rejected-turn-card-root-recovery.md`

Workspace: repository root (in-place,
serial). Baseline: `npm test`, `npm run typecheck`, and `npm run build` passed
on 2026-10-08. Gate 1, Gate 2, and Gate 3 implementation authorization are
approved.

## Tickets

- [x] T3: Replace a proven rejected missing-page Turn Card root create

  - **What to build:** Extend durable Turn Card recovery to recognize an exact
    current page-zero create with rejected/not-started effect certainty but no
    linked page record. In one transaction dismiss the old reply, link its
    recovery record to one newly reserved root create, release the quarantine,
    and enqueue the current authoritative snapshot under a new delivery
    identity.
  - **Spec references:** SCN-1..SCN-4; INV-1..INV-5; Architecture and
    Behavior & Failure Modes.
  - **Dependencies / Blocked by:** T1 and T2 complete, because both own
    adjacent outbox settlement/action changes and this plan must not overlap
    their shared Store/recovery files.
  - **Delegation eligibility:** Bounded but stateful recovery work with one
    inspectable integration seam. Current session policy permits no proactive
    subagent delegation, so execution is main-local.
  - **Delegation mode:** Main-local; no user authorization to spawn.
  - **Ownership and implementation path:** `SqliteOutboxRecoveryStore` owns
    candidate proof and atomic recovery. Existing Turn Card projection/
    prepared-delivery reservation owns reconstruction and successor enqueue;
    the Delivery Ring retains ordering and the adapter retains acknowledgement.
  - **Mutation ownership:** Turn Card recovery/store and projection reservation
    seams, related domain delivery types only if required, plus focused Turn
    Card recovery and Ring tests.
  - **Exclusions:** Lark adapter classification, user-driven Card Dismissal,
    arbitrary immutable effects, uncertain effects, and physical history
    deletion.
  - **Isolation:** Serial shared checkout after T1/T2. It cannot parallelize
    because all three tickets mutate recovery/outbox transaction boundaries.
  - **Concurrency conflicts:** Conflicts with T1/T2 only. Within T3, the
    transaction and deterministic successor identity prevent duplicate scans
    from creating multiple replacements.
  - **Verification seam:** Focused SQLite/recovery integration test constructs
    a current rejected missing-page root and asserts old dismissal, recovery
    link, released quarantine, one new successor, no early dependent delivery,
    and acknowledgement-driven unblocking. Negative tests cover uncertain and
    stale/malformed candidates.
  - **Host capacity:** Not applicable. Any future child brief would state
    `delegation_allowed = false` and prohibit spawning, staging, and commits.
  - **Acceptance criteria and verification:** A safe candidate gets exactly
    one replacement with a new identity and current snapshot; all unsafe
    candidates remain quarantined; later output cannot pass before successor
    ACK. Run focused Vitest, typecheck, build, architecture check, then full
    suite during delivery.

## Delivery checks

- Confirm T3 covers all SCN/INV references, including the uncertain boundary.
- Review that no path directly skips later work or treats a failed root as a
  created target.
- Run affected tests, `npm run typecheck`, `npm run build`,
  `npm run architecture:check`, and full `npm test`.
- Commit T3 separately using explicit paths. Do not push or deploy without
  separate authorization.
