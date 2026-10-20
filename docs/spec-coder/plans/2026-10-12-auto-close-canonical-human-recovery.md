# Auto-close Canonical Human Recovery Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

- Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`
- Branch: `main`
- Scope: migration, submission-intent recovery policy, supervisor readiness and focused tests.
- Main owns merge, commit, install, restart and live verification.

## Wave W1: `T1`

### - [x] T1: Auto-close Canonical Human recovery

| Field | Content |
| --- | --- |
| What to build | Add `auto_closed`, migrate legacy `needs_human` rows, and keep them out of pending recovery/readiness. |
| Spec references | SCN-1, SCN-2, INV-1, INV-2, INV-3, ARCH-1 |
| Dependencies | None |
| Delegation eligibility | main-local; this change is being applied to the deployment main worktree and owns a migration/operational cutover. |
| Delegation mode | main-local |
| Ownership and implementation path | SQLite migration and Submission Intent recovery state own durable semantics; Core session supervisor owns readiness projection. |
| Mutation ownership | `src/store/sqlite/schema.ts`, `src/store/sqlite/migrations.ts`, `src/store/sqlite/migration-registry.ts`, `src/store/sqlite/submission-intent-store.ts`, `src/coordinator/canonical-input-recovery-workflow.ts`, `src/coordinator/core-session-ingestion-supervisor.ts`, `tests/submission-intent-store.test.ts`, `tests/sqlite-migrations.test.ts`, `tests/core-session-ingestion.test.ts` |
| Exclusions | No direct production DB mutation, no Agent Input replay, no Core socket policy change. |
| Isolation | Serial main-local mutation. |
| Concurrency conflicts | None |
| Verification seam | Migration, store, supervisor focused tests plus full suite/typecheck/build. |
| Host capacity | main-only |
| Direct-child boundary | `delegation_allowed = false`; no child dispatch. |
| Acceptance criteria and verification | Existing and new ambiguous recovery rows become `auto_closed`, evidence remains, no pending recovery work is generated, and readiness is not blocked by Human Recovery. |
| Verification commands | `npx vitest run tests/canonical-input-recovery-workflow.test.ts tests/submission-intent-store.test.ts tests/sqlite-migrations.test.ts tests/core-session-ingestion.test.ts`, `npm test`, `npm run typecheck`, `npm run build`, `npm run architecture:check`, `npm run docs:audit` |
| Verification results | Exit 0; focused 140 tests and full 301 files / 4677 tests passed; typecheck, build, architecture and docs audit passed. |
| Commits | `2dc7bd87` |
| Blocked by | None |

## Final delivery checks

Run `npm test`, `npm run typecheck`, `npm run build`, `npm run architecture:check`,
`npm run docs:audit`, and delivery artifact validation before installing and
restarting the service.
