# Runtime Identity Claim Ownership TDD Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

- Executor: native spec-coder implement-spec executor; one `tdd-coder` lifecycle per approved ticket, followed by `delivery-coder`.
- Specification: `docs/spec-coder/specs/2026-10-18-runtime-identity-claim.md`; Gate 2 approved on 2026-10-18.
- Authoritative workspace: `<repo-root>/.trae/worktrees/final-trace-envelope` on branch `worktree-final-trace-envelope`.
- Recorded wave base: `efca62fa70fc79da45e80e10d93cab7ab09a0208`.
- Initial task-owned changes before implementation: the approved specification and this plan only; the selected worktree was otherwise clean.
- Baseline: reusable records `8c609c968427432f821b181c203ff5e9` (`npm test`, 313 files and 5,177 tests), `5823976adfdf4b3498009b8998930675` (`npm run typecheck`), and `771014bf675948eabf9ab8dfa748490f` (`npm run build`), all exit 0.
- Isolation requirement: serial direct-worker mutation in this existing isolated authoritative worktree. Every wave is a singleton because the tickets intentionally share SQLite Binding, port, and test seams. No parallel mutation or additional worktree is required.
- Permitted preparation: Main may revalidate the authoritative workspace, ignored build cache, branch, base, and dependency state before dispatch. Creating an integration branch, regrouping waves, changing ownership, or allocating mutating parallel work requires reopened Gate 3 approval.
- Integration authority: Main alone accepts results, runs fresh affected verification, stages explicit ticket-owned paths, creates one atomic Conventional Commit per ticket, and advances that ticket checkbox.
- Blocking edges: T2 requires T1; T3 requires T1 and is ordered after T2 because of declared mutation conflicts, not an additional functional dependency; T4 requires T2 and T3 before contract closure.
- Durable waves: W1=`T1`, W2=`T2`, W3=`T3`, W4=`T4`. Only the earliest incomplete wave may execute.
- Gate 3 status: approved on 2026-10-18; reopened Gate 3 approved adding `src/store/sqlite/schema-manifest.ts` and `src/store/sqlite/migrations.ts` to T1 mutation ownership; reopened Gate 3 approved adding `tests/architecture-boundaries.test.ts` to T2 mutation ownership after the legacy interface assertion produced the expected structural Red; reopened Gate 3 approved adding `src/store/sqlite/orchestrator-identity-migration-store.ts` and `tests/orchestrator-identity-migration.test.ts` to T4 mutation ownership after source-boundary review proved pane identity migration could move the Binding attachment without moving its current claim. Delivery review first repaired T1 ARCH-5 migration integrity and T4 ARCH-3/ARCH-4 production-port contraction. Repeated Spec review then repaired existing T1 because active degraded schema-140 owners were classified as historical released claims, and existing T3 because valid conflicted claims could not pass the sole explicit-transition fence. The next Spec review reopened existing T2 because automatic reconciliation carried generation and pane fences but omitted the approved owner `sessionEpoch`, allowing an observation captured before clear rotation to reach the new epoch; no mutation ownership, wave membership, design, or scope changed. All repair frontiers and delivery checks are complete.
- Excluded authority: no installation, restart, deployment, production SQLite mutation, push, pull request, external issue publication, Core replay/outbox work, delivery-backlog tuning, or Feishu rendering changes.

## Wave W1: `T1`

### - [x] T1: Persist and migrate one current RuntimeIdentityClaim owner

| Field | Content |
| --- | --- |
| What to build | Add the Primary Session claim model, semantic evidence fingerprint, SQLite schema/migration after 140, legacy classification, claim persistence, current-session partial uniqueness, and claim/Binding projection integrity checks while leaving existing runtime callers temporarily compatible. |
| Spec references | SCN-6, SCN-7, INV-1, INV-2, INV-3, INV-4, INV-5, INV-7, INV-8, ARCH-1, ARCH-2, ARCH-3, ARCH-5 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | Bounded and reversible domain/persistence slice with deterministic policy tests, SQLite migration fixtures, round-trip behavior, and an independently inspectable partial-index seam; carries no credentials or external effects. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Primary Session owns claim states and evidence equality; the SQLite aggregate persists owner epoch, native identity, attachment, and refusal evidence, classifies schema-140 rows without guessing, and synchronizes the compatibility Binding projection transactionally. Use an expand-only step: old callers remain green until later tickets migrate them. |
| Mutation ownership | src/domain/runtime-identity-claim.ts, src/domain/types.ts, src/domain/ports/binding.ts, src/store/sqlite/schema.ts, src/store/sqlite/schema-manifest.ts, src/store/sqlite/migrations.ts, src/store/sqlite/migration-registry.ts, src/store/sqlite/runtime-identity-claim-store.ts, src/store/sqlite/binding-store.ts, src/store/sqlite/binding-session-capability-store.ts, src/store/sqlite/capability-graph.ts, src/store/sqlite-records.ts, tests/runtime-identity-claim.test.ts, tests/sqlite-migrations.test.ts, tests/sqlite-store.test.ts, tests/helpers/sqlite-store-kernel.ts, tests/helpers/sqlite-binding-store.ts |
| Exclusions | No runtime-converger caller migration, provisioning/clear cutover, metadata-patch contraction, Core event changes, or production database repair. |
| Isolation | Serial direct worker in the authoritative worktree at recorded wave base; Main verifies only task-owned specification/plan changes precede Red. |
| Concurrency conflicts | T2, T3, T4 |
| Verification seam | Red-Green domain tests for state/equality/fingerprint rules; schema-140 migration fixtures and reopen; real SQLite save/load/post-load reconciliation; competing handles against the partial unique index; claim/projection rollback assertions. |
| Host capacity | One direct-child slot; Main rechecks live capacity before dispatch and waits rather than changing the durable wave. |
| Build cache | <repo-root>/.cache/worktree-final-trace-envelope/target |
| Direct-child boundary | delegation_allowed = false; Main supplies the common brief plus implementation role, and the worker must not spawn, stage, commit, install, restart, deploy, or mutate production state. |
| Acceptance criteria and verification | A complete native session has at most one current owner; unique attached and unique orphaned legacy candidates classify safely, attached-plus-orphaned duplicates release historical owners, incomplete rows become unclaimed, ambiguous live candidates become conflicted, archived evidence is retained, migration reopen is idempotent, paneToken/timestamps do not affect evidence equality, and a losing concurrent claim leaves both claim and Binding projection unchanged. Run focused new tests, `tests/sqlite-migrations.test.ts`, affected `tests/sqlite-store.test.ts`, `npm run typecheck`, and `npm run build`. |
| Verification commands | `npx vitest run tests/runtime-identity-claim.test.ts tests/sqlite-migrations.test.ts tests/sqlite-store.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `npm test` |
| Verification results | Main observed 625/625 affected tests, typecheck exit 0, build exit 0, architecture imports valid for 552 source files, and 5,184/5,184 full-suite tests across 314 files. The spec-coder artifact checker passed; its repository-specific affected-path mapper rejected this arbitrary project path set, so native project checks were used as required. Delivery repair first observed migration 141 accept a divergent current claim/Binding projection, then passed 90/90 migration tests after adding the in-transaction integrity guard; typecheck and build exited 0 and diff check passed. Repeated review repair observed the schema-140 degraded-owner fixture migrate as released, then passed the focused fixture and 90/90 migration tests while proving the Binding retained `attachment='degraded'`; typecheck and build exited 0 and diff check passed. |
| Commits | `29e3def9`, `d67507c5`, `339c1c94` |

## Wave W2: `T2`

### - [x] T2: Make automatic runtime convergence claim-authoritative and idempotent

| Field | Content |
| --- | --- |
| What to build | Replace direct Binding-column identity decisions in attached observation and orphan recovery with `reconcileRuntimeIdentity`, covering safe first adoption, same-session observation, terminal refresh, orphan recovery, stale/conflict refusal, and durable suppression of identical rejected evidence. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, SCN-7, INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, ARCH-2, ARCH-3, ARCH-6 |
| Dependencies | T1 |
| Blocked by | T1 |
| Delegation eligibility | Bounded reconciliation behavior with public coordinator/store seams, deterministic warning observations, and no external delivery effect beyond existing identity-fenced projection reservation. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Runtime Reconciliation consumes normalized Herdr observation and exact owner fence; the claim policy decides outcomes; SQLite applies claim, Binding projection, lifecycle, and successful orphan projection atomically. `BindingRuntimeConverger` logs only first/changed refusals and treats repeated evidence as a no-op. |
| Mutation ownership | src/domain/types.ts, src/domain/ports/binding.ts, src/store/sqlite/runtime-identity-claim-store.ts, src/store/sqlite/binding-store.ts, src/store/sqlite/binding-projection-store.ts, src/store/sqlite/binding-session-capability-store.ts, src/coordinator/binding-runtime-converger.ts, src/coordinator/pane-runtime-identity.ts, tests/herdr-runtime-reconciler.test.ts, tests/pane-runtime-identity.test.ts, tests/binding-runtime-convergence-policy.test.ts, tests/sqlite-store.test.ts, tests/architecture-boundaries.test.ts, tests/helpers/sqlite-store-kernel.ts |
| Exclusions | No provisioning, manual attach, reset, pane replacement, `/swarm clear`, generic metadata contraction, Core replay, or delivery-backlog behavior. |
| Isolation | Serial direct worker after accepted T1 commit; Main revalidates HEAD, plan checkbox, and clean ticket boundary before dispatch. |
| Concurrency conflicts | T1, T3, T4 |
| Verification seam | Coordinator tests observe logger calls and projection reservations; real store tests compare claim and Binding before/after; explicit repeated-evidence assertions prove no updated timestamp/write, no warning, and no outbox reservation. |
| Host capacity | One direct-child slot; Main rechecks live capacity before dispatch and preserves W2 membership. |
| Build cache | <repo-root>/.cache/worktree-final-trace-envelope/target |
| Direct-child boundary | delegation_allowed = false; Main supplies the common brief plus implementation role, and the worker must not spawn, stage, commit, install, restart, deploy, or mutate production state. |
| Acceptance criteria and verification | An attached unclaimed owner safely adopts only complete structured evidence on the expected pane/terminal; same session may refresh terminal; same session may recover an orphan and reserve the existing projection once; different/missing/incompatible evidence cannot transfer ownership; stale owner fences and unique-index races lose without partial state; the second identical refusal performs no write/warning/projection while changed evidence is re-evaluated. Run focused reconciler/policy/pane identity tests, affected SQLite tests, `npm run typecheck`, and `npm run build`. |
| Verification commands | `npx vitest run tests/architecture-boundaries.test.ts tests/pane-runtime-identity.test.ts tests/herdr-runtime-reconciler.test.ts tests/binding-runtime-convergence-policy.test.ts`; `npx vitest run tests/sqlite-store.test.ts --reporter=dot`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed 159/159 focused behavior and architecture tests plus 533/533 SQLite tests; typecheck and build exited 0; architecture imports were valid for 552 source files; diff check exited 0. Real SQLite conflict coverage proved the savepoint rolls back Binding, claim, Topic view, and outbox together. Repeated Spec review repair observed a pre-clear epoch-1 observation mutate epoch-2 refusal evidence, then passed the focused stale-epoch test after carrying `expectedSessionEpoch` through the port, converger, and pre-policy SQLite fence. Fresh affected verification passed 75/75 reconciler/policy tests, 85/85 architecture tests, and 543/543 SQLite tests; typecheck, build, 552-file architecture imports, and diff check passed. |
| Commits | `f33dd50c`, `c098334c` |

## Wave W3: `T3`

### - [x] T3: Route provisioning, attach, reset, and pane replacement through explicit claim handoff

| Field | Content |
| --- | --- |
| What to build | Replace generic pane-identity patches and direct cutover writes in provisioning, recovery, manual attach, reset cutover, pane replacement, and attached-thread transfer with exact-fenced `applyRuntimeIdentityTransition` handoffs that atomically release and establish claims. |
| Spec references | SCN-1, SCN-5, SCN-7, INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-8, ARCH-3, ARCH-7 |
| Dependencies | T1 |
| Blocked by | T1 |
| Delegation eligibility | Bounded explicit workflow migration with existing attach/provisioning integration tests, SQLite cutover seams, and no credentials or unbounded external actions in tests. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Binding Provisioning coordinates user intent and Herdr effects, then submits the exact old/target owner and attachment fences to the SQLite handoff. The claim aggregate owns release/claim atomicity; paneToken remains presentation metadata. Preserve existing lifecycle, retired-pane cleanup, capability revocation, and projection semantics. |
| Mutation ownership | src/domain/ports/binding.ts, src/store/sqlite/runtime-identity-claim-store.ts, src/store/sqlite/binding-store.ts, src/store/sqlite/binding-session-capability-store.ts, src/coordinator/binding-provisioning-workflow.ts, src/coordinator/binding-provisioning/managed-binding-lifecycle.ts, src/coordinator/binding-provisioning/binding-attachment-use-case.ts, tests/attach-command-integration.test.ts, tests/pane-thread-lifecycle-integration.test.ts, tests/provisioning-recovery.test.ts, tests/retired-pane-cleanup-workflow.test.ts, tests/sqlite-store.test.ts, tests/helpers/sqlite-store-kernel.ts |
| Exclusions | No `/swarm clear` session-epoch rotation, final generic metadata-patch contraction, automatic convergence changes, Worker Runtime redesign, installation, or production pane operations. |
| Isolation | Serial direct worker after accepted T2 commit because T2 and T3 share claim/store/port seams; no parallel fallback is authorized. |
| Concurrency conflicts | T1, T2, T4 |
| Verification seam | Existing attach/reset/provisioning integration seams plus direct SQLite handoff tests inspect both old/new claims, Binding projections, cancelled prompts, retired cleanup, stale fences, and rollback after uniqueness conflicts. |
| Host capacity | One direct-child slot; Main rechecks live capacity before dispatch and preserves W3 membership. |
| Build cache | <repo-root>/.cache/worktree-final-trace-envelope/target |
| Direct-child boundary | delegation_allowed = false; Main supplies the common brief plus implementation role, and the worker must not spawn, stage, commit, install, restart, deploy, or mutate production state. |
| Acceptance criteria and verification | New provisioning establishes one owner claim with its Binding projection; pane replacement changes generation/attachment only under exact fences; reset and attach-transfer release the prior current claim and create the intended target owner atomically; stale or conflicting handoffs preserve both sides; orphan attach cannot steal another current session; existing thread, cleanup, prompt-cancellation, and Primary-tool behavior stays green. Run the listed focused integration/store tests, `npm run typecheck`, and `npm run build`. |
| Verification commands | `npx vitest run tests/attach-command-integration.test.ts tests/pane-thread-lifecycle-integration.test.ts tests/provisioning-recovery.test.ts tests/retired-pane-cleanup-workflow.test.ts`; `npx vitest run tests/sqlite-store.test.ts --reporter=dot`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed the initial SQLite handoff test fail because the transition interface was absent, then pass after the transactional implementation. Self-review added a second Red proving an unattached Binding with a current attached claim bypassed the fence; the narrowed attached/degraded compatibility rule made it Green while preserving degraded reset continuity. Final integrated verification passed 60/60 workflow tests and 537/537 SQLite tests; typecheck and build exited 0; architecture imports were valid for 552 source files; diff check exited 0. Repeated review repair observed an exact complete conflicted claim fail stale, then passed five focused explicit-transition cases covering successful resolution plus released, incomplete, mismatched, and unattached rejection; 60/60 workflow tests and 542/542 SQLite tests passed, with typecheck, build, 552-file architecture imports, and diff check green. |
| Commits | `e1a042c7`, `cf8404f2` |

## Wave W4: `T4`

### - [x] T4: Rotate orchestrator epochs through claims and contract generic identity mutation

| Field | Content |
| --- | --- |
| What to build | Move `/swarm clear` receipt application to the explicit claim transition, then remove pane/session/generation/sessionEpoch authority from `BindingMetadataPatch` and production ports so no remaining workflow can bypass claim rules. Complete source-boundary and full compatibility verification. |
| Spec references | SCN-5, SCN-6, SCN-7, INV-1, INV-2, INV-6, INV-8, INV-9, ARCH-3, ARCH-4, ARCH-5, ARCH-7 |
| Dependencies | T2, T3 |
| Blocked by | T2, T3 |
| Delegation eligibility | Bounded rotation and contract-closure slice with exact receipt fences, existing clear workflow tests, compile-time port enforcement, and full repository verification; no live Herdr or production effect is required. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Orchestrator Clear coordinates the external reset receipt; SQLite verifies the old `(bindingId,generation,sessionEpoch)` and session/attachment evidence, releases the old claim, advances sessionEpoch, and claims the receipt session atomically. After every identity caller is migrated, Binding metadata retains only non-identity fields and TypeScript enforces the boundary. |
| Mutation ownership | src/domain/binding.ts, src/domain/types.ts, src/domain/ports/binding.ts, src/domain/ports/orchestrator-clear.ts, src/domain/ports/workflow.ts, src/domain/ports/pane-operations.ts, src/store/sqlite/runtime-identity-claim-store.ts, src/store/sqlite/binding-store.ts, src/store/sqlite/binding-session-capability-store.ts, src/store/sqlite/orchestrator-clear-store.ts, src/store/sqlite/orchestrator-identity-migration-store.ts, src/store/sqlite/capability-graph.ts, tests/orchestrator-clear-workflow.test.ts, tests/orchestrator-identity-migration.test.ts, tests/sqlite-store.test.ts, tests/helpers/sqlite-store-kernel.ts, tests/helpers/sqlite-binding-store.ts |
| Exclusions | No removal of compatibility columns from `bindings`, no Core/outbox/backlog/CardKit changes, no production clear operation, and no deployment. |
| Isolation | Serial direct worker after accepted T2 and T3 commits; Main verifies all earlier callers have migrated before allowing the contract step. |
| Concurrency conflicts | T1, T2, T3 |
| Verification seam | Orchestrator-clear receipt tests inspect old/new owner epochs and rollback; TypeScript and source review prove production identity writes cannot compile through metadata ports; full migration/store/reconciler/provisioning/clear suites verify compatibility. |
| Host capacity | One direct-child slot; Main rechecks live capacity before dispatch and preserves W4 membership. |
| Build cache | <repo-root>/.cache/worktree-final-trace-envelope/target |
| Direct-child boundary | delegation_allowed = false; Main supplies the common brief plus implementation role, and the worker must not spawn, stage, commit, install, restart, deploy, or mutate production state. |
| Acceptance criteria and verification | A valid clear receipt atomically releases epoch N and claims epoch N+1; stale/mismatched receipts mutate neither claim nor Binding; duplicate receipt handling remains idempotent; `BindingMetadataPatch` exposes no workspace/pane/token/terminal/native-session/generation/sessionEpoch fields; all production identity paths use one of the two deep claim interfaces; compatibility Binding projections remain synchronized. Run focused clear/store tests, all affected tests from T1-T3, `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`. |
| Verification commands | `npx vitest run tests/orchestrator-identity-migration.test.ts`; affected T1-T4 suites across 12 files; `npx vitest run tests/sqlite-store.test.ts --reporter=dot`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check`; `npm test` |
| Verification results | Main observed 16/16 focused identity-migration tests, 346/346 affected tests, and 538/538 SQLite tests; typecheck and build exited 0; architecture imports were valid for 552 source files; diff check exited 0; the fresh full suite passed 5,196/5,196 tests across 314 files. Source review confirmed generic Binding metadata no longer carries runtime identity authority, legacy production handoff bypasses were removed, and clear plus pane migration keep claims and compatibility projections in one savepoint. Delivery repair first observed the architecture assertion fail on raw claim plus legacy identity-write methods exposed by the production port, then moved fixture access to the test-only kernel and removed those production methods. Fresh affected verification passed 118/118 architecture, identity-migration, and pane-lifecycle tests plus 538/538 SQLite tests; typecheck, build, 552-file architecture imports, and diff check passed. |
| Commits | `bade3f9b`, `23bf503f` |

## Final delivery checks

- [x] Main mapped every specification scenario/invariant/architecture decision to accepted ticket diffs and actual test evidence.
- [x] Independent Standards and Spec reviews completed with zero remaining findings after three ticket-level TDD repair commits.
- [x] Focused claim, migration, SQLite, reconciler, provisioning, attach/reset, and orchestrator-clear verification passed on the cumulative accepted state; per-ticket evidence is recorded above.
- [x] Fresh serial delivery verification passed: `npm run typecheck` exit 0; `npm run build` exit 0; `npm run architecture:check` validated 552 source files; `npm test` passed 5,203/5,203 tests across 314 files; `git diff --check` exit 0. The earlier concurrent build/test attempt was discarded because build cleanup caused test-only `dist/build-info.json` `ENOENT` failures; the required serial rerun passed, including `standalone-install.test.ts` 26/26.
- [x] The spec-coder delivery artifact checker reported `delivery: passed` after all ticket checkboxes, accepted evidence, and code commits were present.
- Installation, restart, deployment, production SQLite mutation, push, PR, or external issue remain separately unauthorized.
