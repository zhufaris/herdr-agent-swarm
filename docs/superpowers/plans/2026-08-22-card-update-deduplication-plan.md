# Card Update Deduplication Implementation Plan

1. Add regression tests for reducer lifecycle no-ops, producer state
   deduplication, and the two-second scheduler boundary.
2. Make `reduceRunCard` return the existing snapshot for repeated running and
   blocked lifecycle changes.
3. Make `SyncCoordinator` update and publish observed agent state only when the
   state changes, without suppressing output observations.
4. Change the ordinary card update scheduler default from 800ms to 2,000ms.
5. Run focused tests, the full suite, typecheck, build, and diff checks.
6. Rebuild and restart the PM2 service after in-flight work settles, then
   validate health and the next real channel request.
