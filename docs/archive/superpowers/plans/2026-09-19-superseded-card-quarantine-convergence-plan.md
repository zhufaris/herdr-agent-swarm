# Superseded Card Quarantine Convergence Plan

1. Add SQLite regressions for a same-target Worker Main successor, identity mismatch, and a previously claimed successor.
2. Add a regression proving the existing exact Answer replacement proof accepts a legacy `immutable` update quarantine.
3. Extend transactional startup recovery with the two narrowly fenced convergence cases.
4. Reuse the existing `released_newer_snapshot` delivery evidence path so recovery closes only after the retained successor is delivered.
5. Run focused outbox/store tests, typecheck, build, architecture checks, and the full suite.
6. Wait for the active Prompt and in-flight delivery safety gate, install normally, restart without force, and verify quarantine, lane, readiness, integrity, and build identity.
