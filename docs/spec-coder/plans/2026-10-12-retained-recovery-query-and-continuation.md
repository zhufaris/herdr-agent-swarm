# Retained Recovery Query and Continuation Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification:
`docs/spec-coder/specs/2026-10-12-retained-recovery-query-and-continuation.md`.
Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`, clean isolated
worktree on `main`, base
`68c60e2eff00bcda683f8f712803a35fe3d85a61`. The original user checkout is
excluded. Baseline records `df4c37324083438dba05d13169032a82`,
`fe101eb8069940728c74aafc5a971b97`, and
`ab166ba06ab24fe5a00360e94969e4ed` passed affected tests, typecheck, and
build. The structured-continuation design and reopened Gate 2 were
auto-selected under explicit autonomous authority. Main owns performance
evidence, Red tests, plan state, commits, deployment, and completion claims.

## Wave W1: `T2`

W1 contains one bounded ticket and executes through one direct worker in the
authoritative shared worktree.

### - [x] T2: Model bounded continuation as structured progress

| Field | Content |
| --- | --- |
| What to build | Return structured failed-binding/full-rescan state from startup view convergence and let StartupViewRecovery requeue expected retained-page continuation without exception/failure diagnostics or repeated warning logs. |
| Spec references | SCN-2, SCN-3, INV-2, INV-3, ARCH-2 |
| Dependencies | None |
| Delegation eligibility | Bounded coordinator result-contract change with injected fakes/fake timers and no persistence or external effects. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `StartupViewConverger` creates the result, `StartupRecoveryWorkflow` handles the initial result, and `StartupViewRecovery` remains the background retry owner. |
| Mutation ownership | src/coordinator/startup-view-converger.ts, src/coordinator/startup-view-recovery.ts, src/coordinator/startup-recovery-workflow.ts, tests/startup-view-converger.test.ts, tests/startup-view-recovery.test.ts, tests/startup-recovery-workflow.test.ts |
| Exclusions | New scheduler/timer/worker/table, page budget/size changes, SQL changes from T1, Delivery replay, unrelated startup stages, docs/plan. |
| Isolation | Serial shared workspace after T1 integration; files do not overlap T1 but main preserves one-writer execution. |
| Concurrency conflicts | None |
| Verification seam | Converger result tests, fake-timer StartupViewRecovery full-rescan continuation tests, and StartupRecoveryWorkflow stage/diagnostic tests distinguish expected progress from actual failures. |
| Host capacity | One direct-child slot; main rechecks capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; worker cannot spawn, stage, commit, edit plan artifacts, install, or deploy. |
| Acceptance criteria and verification | Initial two-page yield completes the stage and schedules full rescan; background yield retains `fullRescanPending` with `lastFailure=null`; final page clears pending state; failed Bindings and thrown errors still back off and report failures; bounded-yield warning is removed. |
| Verification commands | `npx vitest run tests/session-activity-store.test.ts tests/startup-view-converger.test.ts tests/startup-view-recovery.test.ts tests/startup-recovery-workflow.test.ts`; `npm run typecheck`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed Red as one bounded-continuation rejection with 32 existing StartupViewConverger passes, then integrated Green as 77/77 tests across 4 suites. Expected continuation, completion, failed-Binding and thrown-error diagnostics are covered; typecheck, 535-file architecture check and diff check exited 0. |
| Commits | `16755ccd` |
| Blocked by | None |

## Wave W2: `T3`

### - [x] T3: Keep continuation on the existing failure budget

| Field | Content |
| --- | --- |
| What to build | Repair delivery-review findings so expected bounded continuation neither increases the failure backoff nor clears a real earlier failure before full convergence succeeds. |
| Spec references | SCN-3, INV-2, INV-3 |
| Dependencies | T2 |
| Delegation eligibility | Review repair required main-owned Red/Green evidence and touched one existing retry owner through its public fake-timer seam. |
| Delegation mode | main-local |
| Ownership and implementation path | `StartupViewRecovery` alone owns retry delay and diagnostic lifetime; its public fake-timer seam proves both state transitions. |
| Mutation ownership | src/coordinator/startup-view-recovery.ts, tests/startup-view-recovery.test.ts |
| Exclusions | New retry state, scheduler, persistence, timer, warning, or recovery owner. |
| Isolation | Serial repair in the authoritative isolated worktree after W1 completion. |
| Concurrency conflicts | None |
| Verification seam | A clean continuation repeats at the base delay; a thrown full rescan followed by an incomplete successful page preserves the real failure and its existing retry attempt until final convergence. |
| Acceptance criteria and verification | Expected continuation keeps the current attempt unchanged; only failed Bindings and thrown errors increase backoff; only complete successful convergence clears prior failure diagnostics. |
| Verification commands | `npx vitest run tests/startup-view-recovery.test.ts`; `npx vitest run tests/session-activity-store.test.ts tests/startup-view-converger.test.ts tests/startup-view-recovery.test.ts tests/startup-recovery-workflow.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed two intended Red failures, then 7/7 focused and 78/78 affected tests passed. Typecheck, build, 535-file architecture check, and diff check exited 0. |
| Commits | `0b3c7b9e` |
| Blocked by | T2 |

## Final delivery checks

Main runs independent Standards/Spec reviews, TDD repairs, affected suites,
typecheck, build, architecture/docs checks, the full Vitest suite, and delivery
artifact validation. After immutable install and force restart, compare
view-convergence/startup duration, `startup-recovery-stage-failed` and bounded
yield warnings, startupViews final state, Core/Delivery failures, backlog, and
latency.

Gate 3 recommendation: execute W1 through one default direct worker in
the authoritative worktree. This was auto-selected under explicit autonomous
authority; no functional dependency or parallel-isolation claim is invented.
