# Canonical Recovery Settlement Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification: `docs/spec-coder/specs/2026-10-13-canonical-recovery-settlement.md`.
Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`, existing
isolated clean worktree on `main`, base
`98ad8660b3b238d01ff724c55e72a76e1a07b4f7`. The original checkout is excluded.
Baseline `c0cd511b3daf49529510354ea2f9546d` passed 144 affected tests. Design and
Gates 1-3 were auto-selected under the active goal's no-wait/default authority.

## Wave W1: `T1`

### - [x] T1: Add terminal recovered outcome

| Field | Content |
| --- | --- |
| What to build | Extend canonical recovery attempts with recovered/null-failure/count-zero state through ordered migration 130 and epoch compatibility; persist success instead of deleting it. |
| Spec references | SCN-1, SCN-2, INV-1, INV-2, ARCH-1 |
| Dependencies | None |
| Delegation mode | main-local |
| Mutation ownership | src/store/sqlite/schema.ts, src/store/sqlite/migration-registry.ts, src/store/sqlite/migrations.ts, src/store/sqlite/schema-manifest.ts, src/store/sqlite/submission-intent-store.ts, tests/sqlite-migrations.test.ts, tests/submission-intent-store.test.ts, tests/canonical-input-recovery-workflow.test.ts, tests/core-session-ingestion.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Fresh/prior schemas converge with marker 130; existing rows are preserved; recovered is valid only with null failure, zero attempts and no retry time; successful page settlement excludes the submission across reopen; rollback keeps it eligible. |
| Verification commands | `npx vitest run tests/sqlite-migrations.test.ts tests/submission-intent-store.test.ts tests/canonical-input-recovery-workflow.test.ts tests/core-session-ingestion.test.ts`; `npm run typecheck`; `npm run build`; `git diff --check` |
| Verification results | 146 affected tests passed; typecheck, build, and diff check passed. |
| Commits | `0a52fe96` |

## Wave W2: `T2`

### - [x] T2: Retire terminal outcomes from canonical reconciliation

| Field | Content |
| --- | --- |
| What to build | Restrict canonical-Human reconciliation recovery evidence to active retry/human states so recovered and auto-closed rows remain audit-only. |
| Spec references | SCN-3, INV-3, ARCH-1 |
| Dependencies | T1 |
| Delegation mode | main-local |
| Mutation ownership | src/store/sqlite/submission-intent-store.ts, tests/submission-intent-store.test.ts |
| Concurrency conflicts | T1 |
| Acceptance criteria and verification | Recovered/auto-closed rows cause no reconciliation work; retry_wait and legacy needs_human remain eligible; canonical submission handling and summaries remain unchanged. |
| Verification commands | `npx vitest run tests/submission-intent-store.test.ts tests/canonical-input-recovery-workflow.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | 20 focused tests passed; typecheck, build, architecture check, and diff check passed. |
| Commits | `5097c6bd` |

## Final delivery checks

Main runs independent Standards/Spec review, TDD repairs, fresh full Vitest,
typecheck, build, architecture/docs checks and delivery artifact validation.
After immutable install/restart, verify migration 130 and epoch, confirm the
three production submissions have recovered terminal outcomes, observe zero
repeated canonical-snapshot transactions over multiple polling windows, sample
health/status latency, and retain ready/Core/Ring/no-error health.
