# Startup Continuation Isolation Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification: `docs/spec-coder/specs/2026-10-13-startup-continuation-isolation.md`.
Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`, existing clean
isolated `main` worktree at `34107aefaeaeef07958a7d96b5aeefe7003574fd`.
Baseline `6069fe8d596644e38a0d4e8f5a535e19` passed five files and 78 tests.
Design selection and Gates 1-3 are auto-selected under the active goal's
explicit no-wait authority. Every child receives `delegation_allowed = false`.

## Wave W1: `T1`

### - [x] T1: Isolate retained startup continuation

| Field | Content |
| --- | --- |
| What to build | Add a retained-continuation lane to the existing StartupViewRecovery runner; expose narrow retained continuation from StartupViewConverger; route initial remainder correctly; split outbox recovery transaction labels by method. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, INV-1, INV-2, INV-3, ARCH-1 |
| Dependencies | None |
| Delegation mode | Default direct worker |
| Mutation ownership | src/coordinator/startup-view-converger.ts, src/coordinator/startup-view-recovery.ts, src/coordinator/startup-recovery-workflow.ts, src/store/sqlite/outbox-recovery-store.ts, tests/startup-view-converger.test.ts, tests/startup-view-recovery.test.ts, tests/startup-recovery-workflow.test.ts, tests/outbox-recovery-policies.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Initial/explicit full work runs exactly once; retained pages continue alone; external full requests have priority and are not lost; continuation/full failures requeue their own lane; one active timer/run remains; outbox transaction labels identify exact methods. Run focused startup/outbox tests, typecheck, build, architecture check, and diff check. |
| Verification commands | `npx vitest run tests/startup-view-converger.test.ts tests/startup-view-recovery.test.ts tests/startup-recovery-workflow.test.ts tests/outbox-recovery-policies.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | 55 focused tests passed, including active-run lane arrival and distinct full/continuation diagnostics; typecheck, build, architecture check, and diff check passed. |
| Commits | `4153fa8c` |

## Wave W2: `T2`

### - [x] T2: Isolate instance reconciliation failures

| Field | Content |
| --- | --- |
| What to build | Continue independent instance/workspace reconciliation after local failures, then reject the pass with bounded aggregate identity evidence. |
| Spec references | SCN-5, INV-4, ARCH-1 |
| Dependencies | T1 |
| Delegation mode | Default direct worker |
| Mutation ownership | src/coordinator/instance-runtime-reconciler.ts, tests/instance-runtime-reconciler.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | A bad first instance or workspace snapshot does not block later healthy instances; the pass still rejects, diagnostics remain failed, and the next clean pass succeeds. Run focused reconciler tests, typecheck, build, architecture check, and diff check. |
| Verification commands | `npx vitest run tests/instance-runtime-reconciler.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | 29 focused tests passed; typecheck, build, architecture check, and diff check passed. |
| Commits | `4ce8d1aa` |

## Final delivery checks

Main performs independent Standards and Spec review, repairs findings through
TDD, runs fresh full Vitest/typecheck/build/architecture/docs checks and the
delivery artifact checker. After immutable install and force restart, verify
method-specific outbox transaction counts, retained continuation retries,
startup readiness/error logs, reconciliation diagnostics, and endpoint latency.
