<!-- spec-coder:artifact-v1 plan -->

# Core Lane Expiry Bootstrap Plan

Specification:
`docs/spec-coder/specs/2026-10-12-core-lane-expiry-bootstrap.md`

## Wave W1: `T1`

### - [x] T1: Bootstrap a new identity-verified lane after typed Core expiry

| Field | Content |
| --- | --- |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, ARCH-1 |
| Dependencies | None |
| Delegation mode | Default direct worker; main owns Red, integration, review, and commit |
| Mutation ownership | src/domain/core-event-inbox.ts, src/store/sqlite/core-event-inbox-store.ts, src/runtime/herdr-events-reader.ts, tests/core-event-inbox-store.test.ts, tests/core-session-ingestion.test.ts |
| Concurrency conflicts | None |
| Exclusions | No historical lane migration, cross-owner adoption, schema migration, production DB edit, Herdr Core, Agent Input replay, Feishu/card changes, installation, restart, deployment, or push |
| Acceptance criteria and verification | A v2 typed cursor expiry on a current lane with no checkpoint atomically bootstraps that lane at Core's resume cursor, records one cursor-expired gap, and continues ingestion without copying historical lane items. Missing resume, checkpoint race, or pre-existing current lane items fail closed. Verify focused Core tests, architecture/docs audits, typecheck, build, and full npm test. |
| Verification commands | npx vitest run tests/core-session-ingestion.test.ts tests/core-event-inbox-store.test.ts; npm run architecture:check; npm run docs:audit; npm run typecheck; npm run build; npm test |
| Verification results | Exit 0; 94 focused Core tests passed, architecture imports valid for 535 source files, documentation audit passed, typecheck/build passed, and full suite passed with 301 files / 4,657 tests. |
| Commits | a82ea74c, a974542c |
