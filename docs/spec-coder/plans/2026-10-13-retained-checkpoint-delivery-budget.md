# Retained Checkpoint and Delivery Budget Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification: `docs/spec-coder/specs/2026-10-13-retained-checkpoint-delivery-budget.md`.
Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`, existing clean
isolated `main` worktree at `44ee0bb006709a726949692595b6f57ab61db4e6`.
Baseline `e3cd80a004514e789a3d073b576450ce` passed three files and 162 tests.
Design selection and Gates 1-3 are auto-selected under the active goal's
explicit no-wait authority. Every child receives `delegation_allowed = false`.

## Wave W1: `T1`

### - [x] T1: Persist retained recovery checkpoints

| Field | Content |
| --- | --- |
| What to build | Add migration 132 and exact-fenced lane/sequence cursor columns to Session Activity snapshots; filter retained query by cursor; advance producer cursors transactionally with page mutations. |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, ARCH-1 |
| Dependencies | None |
| Delegation mode | Default direct worker |
| Mutation ownership | src/store/sqlite/schema.ts, src/store/sqlite/migration-registry.ts, src/store/sqlite/migrations.ts, src/store/sqlite/schema-manifest.ts, src/store/sqlite/session-activity-store.ts, tests/sqlite-migrations.test.ts, tests/session-activity-store.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Historical wait/close pairs disappear after committed recovery and reopen; new lane/higher sequence remains eligible; cursor update is exact-fenced, invisible, and rolls back with mutation/prune failure; migration 132 converges fresh/prior schemas. Run focused store/migration tests, typecheck, build, architecture check, and diff check. |
| Verification commands | `npx vitest run tests/session-activity-store.test.ts tests/sqlite-migrations.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | 117 focused tests passed, including replacement-lane and replacement-runtime cursor fences; typecheck, build, architecture check, and diff check passed. |
| Commits | `4cadd504` |

## Wave W2: `T2`

### - [x] T2: Bound Turn Card delivery retries

| Field | Content |
| --- | --- |
| What to build | Extract one pure delivery retry policy and apply its exponential/provider-delay/five-attempt decision to ordinary outbox and Turn Card failure persistence. |
| Spec references | SCN-4, SCN-5, INV-4, INV-5, ARCH-1 |
| Dependencies | T1 |
| Delegation mode | Default direct worker |
| Mutation ownership | src/domain/delivery-retry-policy.ts, src/store/sqlite/outbox-delivery-store.ts, src/store/sqlite/prepared-delivery-store.ts, tests/ring-delivery-hot-path.test.ts, tests/outbox-recovery-policies.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Safe transient Turn Card attempts 1–4 remain pending with increasing retry times; attempt 5 dead-letters and quarantines; provider delay bounds are preserved; permanent/uncertain outcomes remain immediately terminal; ordinary outbox behavior stays at five attempts. Run focused Ring/outbox tests, typecheck, build, architecture check, and diff check. |
| Verification commands | `npx vitest run tests/ring-delivery-hot-path.test.ts tests/outbox-recovery-policies.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | 57 focused tests passed; typecheck, build, architecture check, and diff check passed. |
| Commits | `06f7bca6` |

## Final delivery checks

Main performs independent Standards and Spec review, repairs findings through
TDD, runs fresh full Vitest/typecheck/build/architecture/docs checks and the
delivery artifact checker. After immutable install and force restart, allow the
first migration replay to settle, then restart once more and verify retained
continuation count/pages approach zero, health tail improves, schema epoch and
cursor rows are current, Turn Card retry diagnostics stay bounded, and error
logs/readiness remain clean.
