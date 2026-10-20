# Awaiting Session Readiness Plan

Specification: `docs/spec-coder/specs/2026-10-06-awaiting-session-readiness.md`

Workspace: in-place at `/workspace/herdr-agent-swarm` on `main`, starting at `15d5b9271406b5ab3f164e52fe8e4ddb1c27766a`. The existing user-owned modified and untracked files listed in the specification are excluded from this ticket. The starting revision passed the full 3,959-test suite, typecheck, and build. The user approved the semantics and authorized autonomous implementation and deployment.

- [x] **T1: Represent the lazy first-session window as awaiting_session**
  - **What to build:** classify an active Primary Binding without a persisted exact session and without pending durable ingestion work as awaiting rather than lagging; expose the state/count and converge normally when the session appears.
  - **Spec references:** SCN-1, SCN-2, SCN-3; INV-1, INV-2, INV-3; Architecture and Behavior & Failure Modes.
  - **Ownership and implementation path:** `CoreSessionIngestionSupervisor` owns classification and bounded in-memory diagnostics; `CoreSessionIngestionDiagnostics` exposes the compatible additive contract; the existing composition-root `requiresIngestion` callback remains authoritative. Do not change Feishu admission, prompt routing, SQLite schema, or Submission Intent semantics.
  - **Acceptance criteria and verification:** Red-Green tests prove awaiting diagnostics without lag/failure, required-route fail-closed behavior, and exact-session convergence. Run `npx vitest run tests/core-session-ingestion.test.ts tests/health-snapshot-collector.test.ts`, `npm run typecheck`, and `npm run build`; inspect the complete task diff and create one atomic Conventional Commit.
  - **Blocked by:** None.

## Final Delivery Checks

- [ ] Findings-first standards/spec review reports no unresolved blocker.
- [ ] `npm test`, `npm run typecheck`, and `npm run build` pass freshly.
- [ ] Install the immutable release, restart through the supported lifecycle surface, and verify live status/logs without exposing message bodies or secrets.
- [ ] Confirm sessionless/no-work Bindings no longer create lag/readiness debt, while durable pending Input still fails closed.
