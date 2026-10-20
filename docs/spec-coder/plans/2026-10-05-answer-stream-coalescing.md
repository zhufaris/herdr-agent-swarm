# Answer Stream Update Coalescing Plan

Specification: `docs/spec-coder/specs/2026-10-05-answer-stream-coalescing.md`

Workspace: in-place at `/workspace/herdr-agent-swarm` on `main`, starting from `d06eaf41d55b1c2a61b7c6cf9dc81d4ab058a3b3`.

Baseline: `npx vitest run tests/event-card-integration.test.ts tests/card-update-scheduler.test.ts --reporter=dot` (37 passed), `npm run typecheck`, and `npm run build` passed. Design, specification, ticket set, and implementation are authorized by the user's standing instruction to follow the recommended solution without per-step confirmation.

- [x] T1: Coalesce large nonterminal Answer updates
  - **What to build:** Preserve immediate first-paint and true terminal convergence while routing active answer growth of at least 80 characters through the existing 120 ms interactive window.
  - **Spec references:** S1-S4; Domain Model; Architecture; Behavior & Failure Modes.
  - **Ownership and implementation path:** `ConversationViewProjector` classifies lifecycle-aware priority and delay; `CardUpdateScheduler` remains unchanged and coalesces the latest durable version; SQLite remains authoritative.
  - **Acceptance criteria and verification:** A focused integration test first fails because an 80-character active delta flushes immediately, then passes only when it waits until 120 ms. Existing first-paint, terminal, ordinary debounce, and scheduler tests remain green. Run focused tests, typecheck, build, full suite, and task-diff review.
  - **Blocked by:** None.

- [x] T2: Preserve coalescing across an in-flight first paint
  - **What to build:** Keep projected-length classification current during delivery and ensure a newer nonterminal revision requested during an in-flight first paint retains its own interactive deadline instead of inheriting immediate terminal priority.
  - **Spec references:** S1-S3; Architecture; Behavior & Failure Modes.
  - **Ownership and implementation path:** `ConversationViewProjector` tracks latest projected length; `CardUpdateScheduler` captures the in-flight policy and resets pending policy for newer revisions while preserving serialized CardKit delivery.
  - **Acceptance criteria and verification:** A gated first-paint integration test fails under the T1 implementation because the second convergence starts immediately, then passes only when the newer active revision waits through 120 ms. Existing retry, terminal promotion, coalescing, focused, typecheck, build, and full-suite checks remain green.
  - **Blocked by:** T1.

## Final delivery checks

- Review the cumulative diff against the specification and repository instructions.
- Run the full Vitest suite, `npm run typecheck`, and `npm run build` freshly.
- Commit only task-owned files with a Conventional Commit and verify no forbidden co-author trailer.
- Install the immutable release, restart through the supported lifecycle command, and verify identity/readiness plus recent CardKit failures.
