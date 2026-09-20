# Main Card Latest Snapshot Implementation Plan

1. Add SQLite regression tests for unclaimed Main Card history/live coalescing,
   contiguous CardKit sequence reuse, and claimed-row immutability.
2. Add an integration test proving startup history is superseded by a newer live
   Main Card projection.
3. Implement atomic Main Card snapshot replacement at the projection/outbox
   boundary without changing Answer or Worker lanes.
4. Run focused projection, outbox, startup, and event-card tests.
5. Run typecheck, full tests, architecture/docs audits, and build.
6. Commit, install an immutable release, activate through the restart safety
   gate, and verify Main Card version convergence in production.
