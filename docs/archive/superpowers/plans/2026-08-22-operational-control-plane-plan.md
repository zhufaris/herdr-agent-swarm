# Operational Control Plane Implementation Plan

1. Add an injected-clock SQLite instance lease with monotonic fencing tokens,
   conditional acquire/renew/release, startup-before-consumers ownership, lease
   loss shutdown, structured logs, and readiness/status visibility.
2. Add a process-wide two-second workspace snapshot cache with concurrent refresh
   coalescing, diagnostics, invalidation, and explicit force-refresh use in all
   attachment mutation paths. Route directory, reconcile, and readiness reads
   through it.
3. Extend commands, persistence queries, and bounded paginated cards for
   `/herdr sessions` and `/herdr failures`, scoped to the requesting chat and
   separating actionable state from historical totals.
4. Add authorized, audited card actions for outbound-only dead-letter retry and
   dismiss. Use compare-and-set transitions, preserve delivery idempotency, wake
   the publisher after retry, and prove that no prompt can be replayed.
5. Add Space directory buttons that open same-chat bound topics or claim eligible
   unbound panes. Force-refresh and revalidate every claim, then reuse attach's
   ownership and provisioning rules. Never render close/delete actions.
6. Add a real-user smoke-test checklist/observer that generates a unique marker
   but cannot synthesize inbound user identity or bypass bot filtering. Update
   operator and Feishu documentation.
7. Run focused tests for every slice, then the full test suite, typecheck, build,
   `git diff --check`, and migration verification against a copied runtime DB.
   Commit thematic slices, restart PM2, verify `/ready` and `/status`, inspect
   logs, and complete the genuine-user smoke checklist when a user is available.
