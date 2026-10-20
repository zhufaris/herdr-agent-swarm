# Orphaned Primary Pending Delivery Repair plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

The native implement-spec executor owns post-Gate-3 ticket execution. The
approved specification is
`docs/spec-coder/specs/2026-10-19-orphaned-primary-pending-repair.md`.
The authoritative workspace is
`<repo-root>/.trae/worktrees/fix-ring-delivery-recovery`;
mode is existing serial recovery worktree, branch is
`fix/ring-delivery-recovery`, and the recorded wave base is
`e77ce758e7c5a306558b391a9d0fbbec92557380`. Initial tracked changes were
none. The workspace baseline is green and its reusable capture records are
stored in the specification. No worker isolation is required because the
singleton wave is serial; no installation, restart, deployment, live SQLite
mutation, push, or pull request is authorized by this plan.

Gate 2 specification approval: approved in the current request. Gate 3
implementation authorization is pending.

## Wave W1: `T1`

### - [x] T1: Retire no-effect pending Primary Main updates after owner invalidation

| Field | Content |
| --- | --- |
| What to build | Add bounded Ring maintenance that atomically dismisses only unclaimed, no-effect pending `primary-main` `session_status` rows whose exact durable owner is orphaned, archived, or closed; preserve uncertain heads and active quarantines while waking affected scopes. |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, ARCH-1, ARCH-2 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | Bounded, reversible SQLite/store change with a real focused test seam; no Gateway call, credential, live-data mutation, or main-only authority. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Prepared-delivery store owns the exact owner/effect predicate, transaction, recovery audit, checkpoint advance, and scope wake. Ring recovery invokes the bounded maintenance result through the existing maintenance path and does not duplicate SQL policy. |
| Mutation ownership | src/store/sqlite/prepared-delivery-store.ts, src/events/ring-delivery-engine.ts, src/domain/ports/prepared-delivery.ts, tests/prepared-delivery-store.test.ts, tests/ring-delivery-recovery.test.ts |
| Exclusions | No uncertain-effect dismissal or replay, no conflict bypass, no three-attempt policy change, no age purge, no schema migration, no CardKit/Lark change, no live SQLite repair, no install/restart/deploy. |
| Isolation | Serial singleton worker in the authoritative workspace at the recorded wave base; main validates the integrated result before staging and commit. |
| Concurrency conflicts | None |
| Verification seam | Real SQLite orphaned-owner backlog with same-conflict pending rows and an uncertain quarantined predecessor; assert bounded dismissal, audit, checkpoint/wake, unchanged quarantine, rollback on audit failure, and zero Gateway calls. Ring recovery tests assert the maintenance result is consumed without an unbounded global scan. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/ring-delivery-recovery/target |
| Direct-child boundary | delegation_allowed = false; main supplies the common brief and TDD role. The worker cannot delegate, stage, commit, install, restart, deploy, mutate live SQLite, or contact external services. |
| Acceptance criteria and verification | The intended orphaned pending fixture goes Red before implementation and Green after it; uncertain quarantine and ordinary uncertain rows remain blocked; concurrent claim/checkpoint/recovery races do not dismiss; focused store/Ring tests, affected validation, typecheck, build, architecture check, full Vitest, and diff check pass before the atomic ticket commit. |
| Verification commands | `npx vitest run --configLoader runner tests/prepared-delivery-store.test.ts tests/ring-delivery-recovery.test.ts`; `npm run typecheck -- --tsBuildInfoFile <repo-root>/.cache/fix/ring-delivery-recovery/target/tsconfig.typecheck.tsbuildinfo`; `npm run build`; `npm run architecture:check`; `git diff --check`. |
| Verification results | Main-owned Red failed on the new orphaned-pending scenario with no transitioned scope. The first Green passed 136 focused tests. Delivery review identified an active replacement-owner compatibility case, an unbounded candidate scan, duplicate compatibility paths, and missing race/checkpoint/lifecycle coverage. The T1 repair added active-replacement fencing, raw-row keyset paging, one compatibility consumer, and race/lifecycle/checkpoint tests; fresh focused verification then passed 141 tests across the store, Ring, and semantic-convergence integration seams. Typecheck, build, architecture check (553 source files), and diff checks passed after the repair. Fresh full Vitest passed 316 files and 5,260 tests. |
| Commits | `3d2a302e2bd1e77e40973b3fcc0f3302ce0bece8`, `944b405f90538e357f18f033d485320e97dd8b5d` |

## Final delivery checks

Main reviews the complete diff against the specification and T1, runs fresh
affected checks and the full applicable suite, verifies no live-data or
deployment mutation occurred, and records the atomic commit before any later
merge or deployment request.
