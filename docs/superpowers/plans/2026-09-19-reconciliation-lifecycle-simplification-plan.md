# Reconciliation Lifecycle Simplification Implementation Plan

1. Add a Card Context regression test for a wake arriving during an active scan.
2. Replace the duplicated background lifecycle with `CoalescingDrain`, retaining an
   explicit request path that rejects on errors for tests and recovery tooling.
3. Add a runtime reconciliation test that forbids pane lookup for a preloaded
   orphaned binding, then seed the ownership map from active plus orphaned rows.
4. Run focused tests, typecheck, build, architecture check, and the full suite.
5. Commit the simplification independently and include it in production activation.

