# Lifecycle Degraded Startup Implementation Plan

1. Add a service-lifecycle regression test reproducing a ready expected build
   whose `/status` response is `degraded`.
2. Update the startup-completion predicate to recognize the health server's two
   valid serving states while retaining identity, recovery, and PID ownership
   fences.
3. Add diagnostic coverage for unsupported status values.
4. Run the focused lifecycle tests, typecheck, full suite, and build.
5. Commit, install an immutable release, perform a safety-gated restart, and
   verify build identity and readiness.
