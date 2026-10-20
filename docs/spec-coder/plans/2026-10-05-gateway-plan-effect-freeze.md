# Gateway Plan Effect Freeze Plan

Specification: `docs/spec-coder/specs/2026-10-05-gateway-plan-effect-freeze.md`

Workspace: in-place at `/workspace/herdr-agent-swarm` on `main`, starting from `b9a64a09abb2c236fedaa5d3c4ac6376891e5e27`. Existing user-owned dirty files are preserved. Fresh baseline: 274 files / 3,952 tests, typecheck, and build passed. Design, specification, ticket, and implementation are covered by the user's standing authorization.

- [x] G1: Freeze outbox effect identity at Gateway plan persistence
  - **What to build:** Make identical prepared-plan replays idempotent, reject changed same-key effects after a plan is persisted, and enforce the freeze through SQLite while keeping the original row claimable.
  - **Spec references:** G1-G4; Domain Model; Architecture; Behavior & Failure Modes.
  - **Ownership and implementation path:** `SqliteOutboxQueueStore` owns equality/freeze policy; the existing outbox immutability trigger is the database backstop; the delivery executor remains unchanged.
  - **Acceptance criteria and verification:** A file-backed reopen test first demonstrates changed payload mutation and identical replay false conflict, then passes with the freeze. Direct SQL mutation fails, unchanged claim succeeds, pre-plan coalescing tests remain green. Run focused/full store and dispatcher tests, typecheck, build, full suite, and review.
  - **Blocked by:** None.

- [x] G2: Complete frozen effect equality and terminal-row conflict handling
  - **What to build:** Compare every effect-defining route, owner, intent, stream, lane, and projection field while preserving exact live/history rediscovery, and reject changed frozen replays before state-based returns.
  - **Spec references:** G1-G4; corrected Domain Model; Behavior & Failure Modes.
  - **Ownership and implementation path:** Centralize named effect-identity keys in `SqliteOutboxQueueStore`; keep work class outside effect equality; move the freeze check ahead of non-pending compatibility return.
  - **Acceptance criteria and verification:** Focused reopen coverage rejects destination, owner, lane, snapshot, and post-delivery conflicts; exact work-class rediscovery remains a no-op. Store/dispatcher/full-suite checks remain green.
  - **Blocked by:** G1.

- [x] G3: Canonicalize reusable sequence and protect shortcut destinations
  - **What to build:** Compare replay identity using the status-card sequence that will actually be persisted, and include `shortcut_panel_id` in the plan-aware SQLite trigger.
  - **Spec references:** G2-G4; Architecture; Testing Decisions.
  - **Ownership and implementation path:** Perform read-only sequence normalization before equality/conflict checks, retain mutation only after those checks, and extend legacy-safe trigger generation for the optional shortcut column.
  - **Acceptance criteria and verification:** A prepared normalized status-card replay is a no-op rather than a false conflict; direct shortcut-panel mutation is rejected after plan persistence; focused/store/dispatcher/full checks remain green.
  - **Blocked by:** G2.

## Final delivery checks

- Review cumulative task diff against the specification and repository boundaries.
- Run the full Vitest suite, typecheck, and build freshly.
- Commit only task-owned files with no Trae CLI co-author trailer.
- Install/restart through supported lifecycle commands and verify identity, startup convergence, delivery failures, and logs.
