# Retained Recovery Index and Failure Backoff Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification: `docs/spec-coder/specs/2026-10-13-retained-recovery-index.md`.
Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`, existing
isolated clean worktree on `main`, base
`b0908058f50b3ec9e14ed8fafa6b14904f1c6c01`. The original checkout is excluded.
Baseline `38211c64af254d19853054d2162d9807` passed 245 affected tests. Design and
Gates 1-3 were auto-selected under the active goal's no-wait/default authority.

## Wave W1: `T1`

### - [x] T1: Index sparse retained multi-agent calls

| Field | Content |
| --- | --- |
| What to build | Add `core_event_inbox_multi_agent_call` to current schema and ordered migration 129 using the measured partial expression predicate; keep recovery SQL unchanged. |
| Spec references | SCN-1, INV-1, ARCH-1 |
| Dependencies | None |
| Delegation mode | main-local |
| Mutation ownership | src/store/sqlite/migration-registry.ts, src/store/sqlite/migrations.ts, src/store/sqlite/schema-manifest.ts, src/store/sqlite/session-activity-store.ts, tests/sqlite-migrations.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Fresh and prior-marker databases have the index and marker 129; migration is idempotent; EXPLAIN uses indexed SEARCH for the exact multi-agent predicate; no schema-policy drift. |
| Verification commands | `npx vitest run tests/sqlite-migrations.test.ts tests/session-activity-store.test.ts`; `npm run typecheck`; `npm run build`; `git diff --check` |
| Verification results | Red showed fresh schema lacked the sparse index. Green passed 110/110 migration and Session Activity tests: marker 129 upgrades the prior epoch, fresh/compatibility fingerprints converge, the exact predicate is index-eligible, and legacy payload-compaction rebuild drops/recreates safely. Typecheck, build, and diff check exited 0. Production-shaped benchmark evidence measured approximately 31 ms/page versus 580–610 ms without the index. |
| Commits | `d7b227b1` |

## Wave W2: `T2`

### - [x] T2: Split Core inbox transaction diagnostics

| Field | Content |
| --- | --- |
| What to build | Replace the shared Core inbox write label with one bounded constant label per mutating method while retaining nested transaction ownership. |
| Spec references | SCN-2, INV-2, ARCH-1 |
| Dependencies | T1 |
| Delegation mode | main-local |
| Mutation ownership | src/store/sqlite/core-event-inbox-store.ts, tests/core-event-inbox-store.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Ingest, canonical snapshot evidence, cursor repair and acknowledgement expose distinct labels; labels contain no runtime identity; existing results/rollback behavior pass. |
| Verification commands | `npx vitest run tests/core-event-inbox-store.test.ts`; `npm run typecheck`; `npm run build`; `git diff --check` |
| Verification results | Red observed the shared write label after an expired-lane bootstrap. Fresh Green passed 65/65 Core inbox tests and proves distinct ingest, bootstrap, canonical-snapshot and acknowledgement labels; all labels are constant and bounded. Typecheck, build, and diff check exited 0. |
| Commits | `2eec79dc` |

## Wave W3: `T3`

### - [x] T3: Reuse cold failed status observation during backoff

| Field | Content |
| --- | --- |
| What to build | Let status return the real last failed workspace observation before retryAt when no successful value exists; strict readiness still bypasses the status deadline. |
| Spec references | SCN-3, INV-3, ARCH-1 |
| Dependencies | T2 |
| Delegation mode | main-local |
| Mutation ownership | src/health/health-snapshot-collector.ts, tests/health-snapshot-collector.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Repeated cold status within backoff performs no new probe; status stays not-ready/degraded with failure IDs; deadline refresh coalesces; strict readiness probes immediately. |
| Verification commands | `npx vitest run tests/health-snapshot-collector.test.ts tests/health-server.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Red showed the second cold status request immediately launched a second Herdr probe. Fresh Green passed 73/73 collector/server tests: the real failed observation is reused before retryAt, deadline refreshes coalesce, and strict readiness waits for the shared fresh probe. Typecheck, build, 535-file architecture check, and diff check exited 0. |
| Commits | `ec45ea70` |

## Wave W4: `T4`

### - [x] T4: Close planner, label, and ownership review gaps

| Field | Content |
| --- | --- |
| What to build | Share the exact retained recovery SQL with planner coverage, assert its unhinted plan can select the sparse index, cover every Core repair label, and correct T3 mutation ownership. |
| Spec references | SCN-1, SCN-2, INV-1, INV-2, ARCH-1 |
| Dependencies | T3 |
| Delegation mode | main-local |
| Mutation ownership | src/store/sqlite/session-activity-store.ts, tests/sqlite-migrations.test.ts, tests/core-event-inbox-store.test.ts, docs/spec-coder/plans/2026-10-13-retained-recovery-index.md |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Exact production query is the runtime/test source of truth and its natural plan contains a sparse-index SEARCH; all eight Core mutation labels are asserted; T3 ownership matches its commit. |
| Verification commands | `npx vitest run tests/sqlite-migrations.test.ts tests/core-event-inbox-store.test.ts tests/session-activity-store.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Review found three evidence/artifact gaps without a behavioral defect. The exact runtime SQL is now shared with an unhinted production-plan assertion, all eight Core mutation labels are directly covered, and T3 ownership matches its commit. Fresh migration/Core tests passed 142/142; typecheck, build, 535-file architecture check, and diff check exited 0. |
| Commits | `b813e862` |

## Final delivery checks

Main runs independent Standards/Spec review, TDD repairs, fresh full Vitest,
typecheck, build, architecture/docs checks and delivery artifact validation.
After immutable install/restart, verify migration 129 and the live query plan,
compare retained-recovery transaction duration/page count and startup latency,
confirm operation-specific Core diagnostics, exercise status across workspace
backoff where safely observable, and retain ready/Core/Ring/no-error health.
