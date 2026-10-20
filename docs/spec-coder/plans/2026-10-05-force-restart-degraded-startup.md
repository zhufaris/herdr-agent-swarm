# Force Restart of Degraded Startup Plan

Specification: `docs/spec-coder/specs/2026-10-05-force-restart-degraded-startup.md`

- [x] R1: Honor force for terminal degraded startup
  - **What to build:** Admit `startupRecovery.state=degraded` only when force is explicit, retaining all non-bypassable gates.
  - **Spec references:** R1-R3; Implementation Decisions.
  - **Ownership:** `RestartSafetyEvaluator` pure policy and its focused tests.
  - **Verification:** Red-Green policy test, full restart-safety tests, typecheck, build, full suite, review, install, and live restart.
  - **Blocked by:** None.

- [x] R2: Lock force boundary and operator guidance
  - **What to build:** Cover unforced degraded and forced unknown states, and make retry guidance reflect whether force can help.
  - **Spec references:** R1-R3; Testing Decisions.
  - **Verification:** Focused/full lifecycle tests, typecheck, build, and cumulative review.
  - **Blocked by:** R1.
