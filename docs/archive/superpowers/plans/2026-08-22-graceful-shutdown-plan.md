# Graceful shutdown implementation plan

1. Add a publisher lifecycle test proving `stop()` waits for an in-flight Lark
   delivery and final store update, then implement tracked event work and an
   idempotent async stop.
2. Add a projector lifecycle test proving `stop()` waits for projection and its
   publisher enqueue, then implement tracked projection work and async stop.
3. Extract an application shutdown coordinator with explicit dependency order,
   test store-close ordering and repeated calls, and wire it into `main.ts`.
4. Run focused tests, the full suite, typecheck, build, and diff checks.
5. Restart only the PM2-managed bridge and verify the old process emits no new
   closed-database error while the replacement becomes healthy and ready.
