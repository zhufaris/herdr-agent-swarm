# Delivery Intent V2 Deduplication Plan

1. Add public-boundary tests for version 2 encoding/materialization and retained
   version 1 compatibility.
2. Add SQLite tests proving new rows omit the duplicate body and safe legacy
   rows migrate across reopen without changing delivery or recovery state.
3. Implement the version 2 domain contract and dual-version materializer.
4. Update latest-schema triggers and add an idempotent transactional migration
   for safe version 1 envelopes.
5. Run focused tests, typecheck, build, architecture and documentation audits,
   the full test suite, and public audit.
6. Review the complete diff and map each acceptance criterion to direct evidence.
