<!-- spec-coder:artifact-v1 plan -->

# Core Checkpoint Identity Recovery Plan

Specification:
`docs/spec-coder/specs/2026-10-12-core-checkpoint-identity-recovery.md`

## Wave W1: `T1`

### - [x] T1: Adopt compatible durable progress after a stale expired-cursor rebase

| Field | Content |
| --- | --- |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, ARCH-1 |
| Dependencies | None |
| Delegation mode | Default direct worker; main owns Red, integration, review, and commit |
| Mutation ownership | src/runtime/herdr-events-reader.ts, tests/core-session-ingestion.test.ts |
| Concurrency conflicts | None |
| Exclusions | No domain/store interface changes, schema changes, production DB edits, Herdr Core changes, Agent Input replay, Feishu/card changes, installation, restart, deployment, or push |
| Acceptance criteria and verification | A stale-rebase loser reloads and adopts only an identity-compatible checkpoint whose read cursor advanced beyond the expired cursor, then reads from that durable cursor and completes without duplicate input work. Missing, mismatched, or unchanged checkpoints fail closed. Existing one-expiry and epoch fences remain intact. Verify with focused reader/inbox tests, npm run typecheck, npm run build, and npm test. |
| Verification commands | npx vitest run tests/core-session-ingestion.test.ts tests/core-event-inbox-store.test.ts; npm run architecture:check; npm run docs:audit; npm run typecheck; npm run build; npm test |
| Verification results | Exit 0; 89 focused Core tests passed, architecture imports valid for 535 source files, documentation audit passed, typecheck/build passed, and full suite passed with 301 files / 4,652 tests. |
| Commits | d1b3b6b7, 5499798f |
