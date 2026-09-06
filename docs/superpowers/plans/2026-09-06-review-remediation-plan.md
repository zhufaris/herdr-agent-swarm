# Review Remediation Implementation Plan

1. Update the governing safety text to distinguish exact-turn stop from remote
   approval and arbitrary terminal control.
2. Extend pane-close result rendering with succeeded and uncertain child counts;
   compute them from the durable cascade outcomes and add card/workflow tests.
3. Centralize Worker interaction availability, suppress blocked steer, and gate
   Worker Main new-task actions with the same usability predicate as callbacks.
4. Introduce shared Zod Agent-session schemas in the shim and extend malformed
   input tests.
5. Move `TraexModelSummary` to the domain model-selection module and update
   imports.
6. Run focused and full verification, inspect the final diff, and commit the
   implementation separately from this design/plan commit.
