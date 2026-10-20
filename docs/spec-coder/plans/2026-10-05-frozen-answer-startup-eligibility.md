# Frozen Answer Startup Eligibility Plan

Specification: `docs/spec-coder/specs/2026-10-05-frozen-answer-startup-eligibility.md`

- [x] F1: Exclude exact-version frozen effects from lag-only startup recovery
  - **What to build:** Refine durable startup eligibility without changing independent live, pending, streaming, quarantine, or explicit recovery paths.
  - **Spec references:** F1-F4; Domain Model; Architecture; Behavior & Failure Modes.
  - **Ownership:** `SqliteProjectionStore` query and existing SQLite integration seam.
  - **Verification:** Red-Green selection test, full store/startup tests, typecheck, build, full suite, review, install/restart, and warning comparison.
  - **Blocked by:** None.

- [x] F2: Lock different-version and mutable-terminal boundaries
  - **What to build:** Add regression coverage proving the anti-replay predicate requires both exact current version and durable freeze evidence.
  - **Spec references:** F1-F4; Testing Decisions.
  - **Verification:** Focused/full store tests, typecheck, build, and cumulative review.
  - **Blocked by:** F1.

- [x] F3: Apply frozen-effect exclusion to message-only lag
  - **What to build:** Reuse one named anti-replay predicate in both page-backed and legacy message-only/card-ID-missing lag branches.
  - **Spec references:** F1-F4; Architecture; Testing Decisions.
  - **Verification:** Red-Green message-only case, full store/startup tests, typecheck, build, full suite, review, and live warning count.
  - **Blocked by:** F2.

- [x] F4: Isolate the message-only regression fixture
  - **What to build:** Make the message-only case ineligible for page-backed lag so the test fails if the second predicate loses its guard.
  - **Spec references:** Testing Decisions.
  - **Verification:** Focused/full store tests and cumulative review.
  - **Blocked by:** F3.

- [x] F5: Exclude frozen current effects from historical creating pages
  - **What to build:** Reuse the anti-replay predicate in the page-in-progress eligibility branch while retaining live/pending/recovery overrides.
  - **Spec references:** F1-F4; Architecture; Testing Decisions.
  - **Verification:** Red-Green creating-page fixture, full store/startup tests, typecheck, build, full suite, review, and live warning count.
  - **Blocked by:** F4.

- [x] F6: Stop generic replay after a replacement effect already exists
  - **What to build:** Select replacement-pending recovery directly only while no durable replacement reply has been reserved; preserve pending-outbox and active-quarantine overrides.
  - **Spec references:** F1-F4; Behavior & Failure Modes; Testing Decisions.
  - **Verification:** Red-Green dead-letter replacement fixture, full store/startup tests, typecheck, build, full suite, review, and live warning count.
  - **Blocked by:** F5.

- [x] F7: Lock unreserved and pending replacement recovery paths
  - **What to build:** Add positive fixtures for direct unreserved replacement recovery and pending replacement outbox rediscovery.
  - **Spec references:** Behavior & Failure Modes; Testing Decisions.
  - **Verification:** Focused/full store tests, typecheck, build, and cumulative review.
  - **Blocked by:** F6.
