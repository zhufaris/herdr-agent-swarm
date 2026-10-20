# Startup and Delivery Hot-Path Elegance Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification:
`docs/spec-coder/specs/2026-10-12-startup-delivery-hotpath-elegance.md`.
Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`, existing
isolated clean worktree on `main`, base
`b791a361c262e51618ff0807b9a120e5165d9dba`. The original checkout is excluded.
Baseline `273594fe84e54378879a84509c16b969` passed 195 affected tests; the same
current revision previously passed the full suite, typecheck, build,
architecture/docs checks, and artifact validation. Design and Gates 1-3 were
auto-selected under the active goal's autonomous/default authority.

## Wave W1: `T1`

### - [x] T1: Align start and restart observation budgets

| Field | Content |
| --- | --- |
| What to build | Use one 90-second default startup-completion budget for start and restart without changing explicit overrides or safety checks. |
| Spec references | SCN-1, INV-1, ARCH-1 |
| Dependencies | None |
| Delegation mode | Default direct worker |
| Mutation ownership | src/cli/service-lifecycle.ts, tests/service-lifecycle.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Default start/restart budgets equal 90 seconds; explicit short start/restart overrides still drive existing timeout tests; identity, ownership, readiness, and startup-state tests pass. Run service lifecycle tests, typecheck, build, and diff check. |
| Verification commands | `npx vitest run tests/service-lifecycle.test.ts`; `npm run typecheck`; `npm run build`; `git diff --check` |
| Verification results | Main observed Red because the shared timeout contract was absent. Fresh integrated Green passed 118/118 lifecycle tests, typecheck, build, and diff check. One worker incorrectly reopened a completed design gate and made no edits; the single promoted implementation was inspected and accepted. |
| Commits | `400cabae` |

## Wave W2: `T2`

### - [x] T2: Index replacement recovery identity

| Field | Content |
| --- | --- |
| What to build | Add ordered migration 128 and a partial `delivery_recoveries(replacement_reply_id)` index, bump schema epoch, and support the deployed prior-epoch upgrade. |
| Spec references | SCN-2, INV-2, ARCH-1 |
| Dependencies | None |
| Delegation mode | Default direct worker |
| Mutation ownership | src/store/sqlite/migration-registry.ts, src/store/sqlite/migrations.ts, src/store/sqlite/schema-manifest.ts, tests/sqlite-migrations.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Fresh and upgraded catalogs contain marker 128 and the partial index; exact replacement lookup uses SEARCH/index; upgraded and fresh fingerprints match; second open is current-fast. Run migration tests, typecheck, build, architecture check, and diff check. |
| Verification commands | `npx vitest run tests/sqlite-migrations.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed Red because fresh schema lacked the index. Fresh integrated Green passed 76/76 migration tests, including marker registry, prior-epoch upgrade, query-plan SEARCH, fingerprint parity, and current-fast reopen; typecheck, build, 535-file architecture check, and diff check exited 0. |
| Commits | `13ab101c` |

## Wave W3: `T3`

### - [x] T3: Move per-occurrence delivery diagnostics to debug

| Field | Content |
| --- | --- |
| What to build | Keep latency metrics at info and trace diagnostics/correlation at debug while preserving counters and sanitization. |
| Spec references | SCN-3, INV-3, ARCH-1 |
| Dependencies | None |
| Delegation mode | Default direct worker |
| Mutation ownership | src/runtime/service-logger.ts, tests/service-logger.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Debug logger sees safe diagnostic correlation at level 20; info logger emits no per-occurrence diagnostic; metrics remain level 30 and snapshot counters advance. Run logger tests, typecheck, build, and diff check. |
| Verification commands | `npx vitest run tests/service-logger.test.ts`; `npm run typecheck`; `npm run build`; `git diff --check` |
| Verification results | Main observed two Red failures: diagnostic level 30 and info-stream emission. Fresh integrated Green passed 4/4 logger tests; counters, safe correlation, and metric info level remain covered. Typecheck, build, and diff check exited 0. |
| Commits | `4c5dbf62` |

## Wave W4: `T4`

### - [x] T4: Prove prior-epoch fingerprint parity directly

| Field | Content |
| --- | --- |
| What to build | Close the Spec-review evidence gap by comparing the fresh fingerprint directly with the exact `2026-10-11.2` upgraded fingerprint and stored metadata. |
| Spec references | SCN-2, INV-2 |
| Dependencies | T2 |
| Delegation mode | main-local |
| Mutation ownership | tests/sqlite-migrations.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | The exact deployed-prior-epoch test asserts returned and persisted upgraded fingerprints equal the fresh canonical fingerprint, while index/marker/query-plan/current-fast assertions remain green. |
| Verification commands | `npx vitest run tests/sqlite-migrations.test.ts` |
| Verification results | Spec review identified indirect fingerprint evidence. The repaired focused case and all 76/76 migration tests passed with direct returned/stored fingerprint equality. |
| Commits | `48c1098f` |
| Blocked by | T2 |

## Wave W5: `T5`

### - [x] T5: Align retention query-plan evidence with the new index

| Field | Content |
| --- | --- |
| What to build | Update the existing retention-plan assertion to require the new replacement index while preserving all recovery-side and correlation checks. |
| Spec references | SCN-2, INV-2 |
| Dependencies | T2 |
| Delegation mode | main-local |
| Mutation ownership | tests/sqlite-store.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Active recovery still preserves both failed and replacement rows; planner uses the failed primary-key index and the new replacement partial index under distinct correlated subqueries. |
| Verification commands | `npx vitest run tests/sqlite-store.test.ts -t "keeps both sides of active delivery recovery out of retention"` |
| Verification results | Fresh full suite exposed one obsolete query-plan string assertion. The exact retention behavior/query-plan test passed after requiring `delivery_recoveries_replacement`; no behavior assertion changed. |
| Commits | `ce33369e` |
| Blocked by | T2 |

## Final delivery checks

Main runs independent Standards/Spec review, TDD repairs, fresh full Vitest,
typecheck, build, architecture/docs checks, and artifact validation. After
immutable install and authorized restart, verify `swarm:start` no longer
times out during the observed 34-second startup, the live query plan uses the
new index, info diagnostic volume drops to zero while `/status` counters still
move, and delivery/Core latency remains healthy.
