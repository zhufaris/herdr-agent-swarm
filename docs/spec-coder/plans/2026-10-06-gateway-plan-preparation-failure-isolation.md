# Gateway Plan Preparation Failure Isolation Plan

Specification: `docs/spec-coder/specs/2026-10-06-gateway-plan-preparation-failure-isolation.md`

- [x] P1: Terminalize deterministic prepare poison per lane
  - **What to build:** Convert local plan-preparation exceptions into durable per-item rejected dead letters while allowing sibling lanes to complete.
  - **Spec references:** P1-P4; Domain Model; Architecture; Behavior & Failure Modes.
  - **Ownership:** `OutboundDeliveryExecutor` pre-claim boundary, existing Outbox failure transition, existing dispatcher integration seam.
  - **Verification:** Red-Green two-lane dispatcher test, full dispatcher tests, typecheck, build, full suite, two-axis review, commit, install/restart, live status/log audit.
  - **Blocked by:** None.

- [x] P2: Lock serialization and storage-failure boundaries
  - **What to build:** Cover circular plan serialization and prove plan/rejection persistence failures remain scan-fatal; centralize pre-effect rejection metadata.
  - **Spec references:** P1-P4; Architecture; Testing Decisions.
  - **Verification:** Focused/full dispatcher tests, typecheck, build, full suite, cumulative review.
  - **Blocked by:** P1.
