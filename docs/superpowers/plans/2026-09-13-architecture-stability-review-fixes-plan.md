# Architecture Stability Review Fixes Plan

1. Add focused failing tests for pre-claim Gateway preparation failure, then
   return before claim and verify retry convergence.
2. Extend the command-runner contract with optional cancellation, implement exact
   child termination and cleanup, propagate the signal through Herdr prompt/wait,
   and add runner plus adapter regression tests.
3. Introduce a coded unavailable-instance domain error at the instance workflow
   boundary, update inbound classification to use it, and cover typed versus
   arbitrary failures.
4. Verify and include the existing Worker-title and SQLite migration regression
   test corrections.
5. Run focused tests after each boundary, followed by typecheck, build, full test,
   and production dependency audit. Commit each independently meaningful batch.
6. Build and install an immutable release, use the supported forced restart only
   after checking active work, and verify identity, readiness, inbound backlog,
   and outbox/quarantine state without automatically replaying uncertain work.
