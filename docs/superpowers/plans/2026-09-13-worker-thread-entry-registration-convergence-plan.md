# Worker Thread Entry Registration Convergence Plan

1. Add a SQLite regression test that creates and acknowledges a canonical
   Worker Main Card before registering its Primary entry request. Assert that
   registration creates a pending `worker-session` card-context invalidation
   and that one rebuild reserves exactly one immutable entry reply.
2. Make `SqliteCommandIntentStore.registerWorkerThreadEntry()` insert the entry
   request and upsert its generation-fenced invalidation in one transaction.
   Keep duplicate registration a no-op.
3. Allow Worker-session projection to reserve pending entries whenever the
   canonical Main message is durable, independent of the invalidation reason.
4. Add startup repair for legacy pending entry requests by idempotently seeding
   their Worker-session invalidations during schema/startup convergence. Test an
   active row and a stale-generation row.
5. Run focused tests, typecheck, build, full tests, and `git diff --check`. Then
   install an immutable release, force restart under the existing authorization,
   and verify the two production pending rows converge without duplicate cards.
