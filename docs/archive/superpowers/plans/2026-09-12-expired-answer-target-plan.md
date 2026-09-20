# Expired Answer Target Implementation Plan

1. Add Feishu error-classification tests for `230031` and scope its semantic
   recovery to Primary Answer update operations.
2. Add SQLite tests for terminal projection evidence, successor dismissal, new
   target eligibility, and migration idempotency.
3. Extend provider-neutral recovery contracts and implement the failure transition.
4. Suppress future Answer snapshot revisions for an expired projection key.
5. Add the one-time Feishu compatibility migration for existing `230031` rows.
6. Run focused tests, typecheck, full tests, architecture/docs audits, and build.
7. Commit, install, activate through the restart safety gate, and verify startup
   no longer recreates expired Answer updates.
