# Runtime Tail Stability Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification: `docs/spec-coder/specs/2026-10-13-runtime-tail-stability.md`.
Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`, existing clean
isolated `main` worktree at `6d14d0a5453cb3d1113b88376fd84dba9210b7fa`.
Baseline `83a061293e2941059bf315efdc273bb5` passed four files and 176 tests.
Design selection and Gates 1-3 are auto-selected under the active goal's
explicit no-wait authority. Every child receives `delegation_allowed = false`.

## Wave W1: `T1`

### - [x] T1: Narrow retained Session Activity recovery

| Field | Content |
| --- | --- |
| What to build | Add migration 131 for the checkpoint session lookup; load/translate retained evidence outside the write transaction; prune once per changed scope after ordered mutations. |
| Spec references | SCN-1, SCN-2, INV-1, INV-2, ARCH-1 |
| Dependencies | None |
| Delegation mode | Default direct worker |
| Mutation ownership | src/store/sqlite/session-activity-store.ts, src/store/sqlite/schema.ts, src/store/sqlite/migration-registry.ts, src/store/sqlite/migrations.ts, src/store/sqlite/schema-manifest.ts, tests/session-activity-store.test.ts, tests/sqlite-migrations.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | A 144-mutation single-scope page performs six prune statements, retains ordering/results/rollback, and opens the write transaction only after evidence translation; migration 131 converges fresh/prior schemas and both query-plan branches use the released checkpoint index. Run focused store/migration tests, typecheck, build, architecture check, and diff check. |
| Verification commands | `npx vitest run tests/session-activity-store.test.ts tests/sqlite-migrations.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | 114 focused tests passed, including 144-mutation batching and prune-failure rollback; typecheck, build, architecture check, and diff check passed. |
| Commits | `72617d0f` |

## Wave W2: `T2`

### - [x] T2: Reject failed Lark update responses

| Field | Content |
| --- | --- |
| What to build | Validate the resolved Lark message-card update response with the adapter's existing provider-code validator before delivery settlement. |
| Spec references | SCN-3, INV-3, ARCH-1 |
| Dependencies | T1 |
| Delegation mode | Default direct worker |
| Mutation ownership | src/adapters/lark-adapter.ts, tests/lark-adapter.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | A nonzero resolved update response throws the normalized Lark update failure and success remains unchanged. Run the focused adapter suite, typecheck, build, and diff check. |
| Verification commands | `npx vitest run tests/lark-adapter.test.ts`; `npm run typecheck`; `npm run build`; `git diff --check` |
| Verification results | 44 focused tests passed; typecheck, build, and diff check passed. |
| Commits | `dacc7905` |

## Wave W3: `T3`

### - [x] T3: Bound reasoning sequence state by turn

| Field | Content |
| --- | --- |
| What to build | Clear the projector's reasoning-sequence map at the existing turn-start reset boundary. |
| Spec references | SCN-4, INV-4, ARCH-1 |
| Dependencies | T2 |
| Delegation mode | Default direct worker |
| Mutation ownership | src/runtime/herdr-events/event-projector.ts, tests/herdr-event-projector.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Prior-turn reasoning sequence state is absent in the next turn while current-turn deduplication/order stays intact. Run the focused projector suite, typecheck, build, and diff check. |
| Verification commands | `npx vitest run tests/herdr-event-projector.test.ts`; `npm run typecheck`; `npm run build`; `git diff --check` |
| Verification results | 23 focused tests passed; typecheck, build, and diff check passed. |
| Commits | `18aa30c4` |

## Final delivery checks

Main performs independent Standards and Spec review, repairs findings through
TDD, runs fresh full Vitest/typecheck/build/architecture/docs checks and the
delivery artifact checker. After immutable install and force restart, verify
epoch/migration 131, production `EXPLAIN QUERY PLAN`, retained recovery slow
transaction frequency/duration, readiness/error logs, endpoint latency, and
provider/turn-state regressions through local suites.
