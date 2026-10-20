# Initial Agent Input Recovery Deduplication Plan

Specification: `docs/spec-coder/specs/2026-10-05-initial-agent-input-recovery-dedup.md`

Workspace: in-place on `main` from `f486b2d4a103c3d75ee3fcb7cd4b5a602b318a3e`; user-owned dirty files remain untouched. Fresh baseline: 274 files / 3,954 tests, typecheck, and build passed. The user's standing authorization covers design, specification, implementation, commit, and deployment.

- [x] I1: Exclude durable Submission Intents from initial-input recovery
  - **What to build:** Make startup selection recovery consult exact gateway/source Submission Intent authority while retaining legacy Prompt compatibility.
  - **Spec references:** I1-I4; Domain Model; Architecture; Behavior & Failure Modes.
  - **Ownership and implementation path:** `SqliteInboundProjectStore` owns the read model; `StartupRecoveryWorkflow` and `InitialAgentInputWorkflow` remain unchanged.
  - **Acceptance criteria and verification:** Another-gateway source remains eligible, exact-gateway source is excluded in any state, legacy Prompt exclusion remains, and query planning uses the durable source index. Run focused/full store, startup recovery, typecheck, build, full suite, review, install, restart, and live startup-state audit.
  - **Blocked by:** None.

## Final delivery checks

- Confirm no unrelated user file enters the commit and no forbidden trailer is present.
- Verify startup `initial-agent-inputs` completes without submission or outbox replay.
- Verify target build identity, Core ingestion, outbox failures, and warning/error logs.
