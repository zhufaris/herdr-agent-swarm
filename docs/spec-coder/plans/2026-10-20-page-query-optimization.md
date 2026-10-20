# Page Query Scan and Materialization Optimization Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

The native implement-spec executor owns post-Gate-3 waves. The approved
specification is
`docs/spec-coder/specs/2026-10-20-page-query-optimization.md`.
The authoritative workspace is
`<repo-root>/.trae/worktrees/fix-ring-delivery-recovery`.
It is an existing isolated linked worktree on branch `fix/ring-delivery-recovery`.
The recorded wave base is
`3e2cb0f7ca6ce3b807ed0b485913022db0a815a4`; initial changes are none. The
main worktree remains dirty and is not touched.

The previous hotpath plan is not being resumed. This plan was created after
W1 query-plan evidence reopened design and Gate 1. The new page-query
specification is approved at Gate 2; Gate 3 implementation authorization is
pending. Waves are serial to keep migration and query-plan evidence easy to
attribute. No installation, restart, deployment, push, or production SQLite
mutation is authorized.

Fresh reopened-design baseline records are in the specification and were all
reusable:

- Vitest: 316 files / 5277 tests, record `26bd34331b444243bb93c040c0afd0e4`.
- Typecheck: record `fe163268dba442b294fb013c02014192`.
- Build: record `977ebdee46e347a1ab0222c09ea461ad`, build
  `sha256:c779f08e05adf5cad2dd950669a4509be7eb1c3c99999e1636f2d57de28117df`.
- Architecture: record `7de99f3fccac4d4390f7e20db6597d2d`, 553 source files.

## Wave W1: `T1`

### - [x] T1: Optimize Worker actionable page discovery

| Field | Content |
| --- | --- |
| What to build | Rewrite Worker actionable-page discovery to use an equivalent `EXISTS` page/actionability predicate instead of duplicate-producing joins plus `DISTINCT`, preserve `(updated_at, turn_id)` keyset bounds, and add only the planner-proven Worker keyset/page lookup indexes. |
| Spec references | SCN-1, SCN-4, SCN-5, INV-1, INV-2, INV-5, INV-6, ARCH-1, ARCH-4 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | Bounded SQLite read-path optimization with an existing public page method and deterministic behavior/query-plan seams. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `SqliteWorkerTurnStore.listActionableWorkerTurnCardPage()` owns the query contract; ordered migration registration, migration execution, schema manifest/fingerprint, and Worker migration helpers jointly own fresh and existing-database index rollout; existing startup supervisor traversal remains unchanged. |
| Mutation ownership | src/store/sqlite/worker-turn-store.ts, src/store/sqlite/migrations/worker-migrations.ts, src/store/sqlite/migration-registry.ts, src/store/sqlite/migrations.ts, src/store/sqlite/schema-manifest.ts, tests/worker-turn-card-workflow.test.ts, tests/instance-turn-supervisor.test.ts, tests/sqlite-store.test.ts, tests/sqlite-migrations.test.ts |
| Exclusions | No Worker lifecycle change, owner/generation fence change, page-size change, startup scheduling change, delivery-ring change, or production database mutation. The migration must be additive/idempotent and update canonical metadata safely; do not add candidate indexes whose before/after plan does not show a benefit. |
| Isolation | Serial worker in the authoritative isolated worktree at the recorded wave base; main validates the complete ticket diff before commit. |
| Concurrency conflicts | None |
| Verification seam | Public `listActionableWorkerTurnCardPage()` with active/finished pages, duplicate page rows, completion obligations, stale owner rows, upper-bound/cursor fixtures, and `EXPLAIN QUERY PLAN` before/after. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/ring-delivery-recovery/target |
| Direct-child boundary | `delegation_allowed = false`; no indirect delegation, staging, commit, installation, restart, deployment, or live SQLite mutation. |
| Acceptance criteria and verification | Returned IDs, order, next cursor, upper bound, and actionability are identical to the baseline fixtures; duplicate joins no longer require the observed DISTINCT temp sort; migration is idempotent on fresh and legacy databases. Run focused Worker/page tests, migration checks, typecheck, build, architecture check, and diff check. |
| Verification commands | `npx vitest run --configLoader runner tests/sqlite-migrations.test.ts`; `npx vitest run --configLoader runner tests/sqlite-store.test.ts -t 'pages actionable canonical segments and Worker Turns with stable cursors'`; `npx vitest run --configLoader runner tests/instance-turn-supervisor.test.ts tests/worker-turn-card-workflow.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; fresh Worker `EXPLAIN QUERY PLAN`; `git diff --check`. |
| Verification results | Migration 91/91; stable page 1/1; Worker/supervisor 37/37; typecheck/build/architecture passed; fresh planner uses `worker_turn_cards_actionable_page_keyset` and indexed page `EXISTS` with no DISTINCT/ORDER BY TEMP B-TREE; affected-path mapper could not map migration-registry and native checks were used. |
| Commits | `6d4593e3` |

## Wave W2: `T2`

### - [x] T2: Optimize completed Initial Agent Input selection pages

| Field | Content |
| --- | --- |
| What to build | Add the planner-proven partial keyset index for completed project selections with initial prompts, preserve exact Prompt/Submission Intent identity probes, and keep later eligible selections visible across cursor continuation. |
| Spec references | SCN-2, SCN-4, SCN-5, INV-1, INV-2, INV-3, INV-6, ARCH-2, ARCH-4 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | Bounded inbound SQLite query/migration change with an existing public startup-recovery page seam and exact identity fixtures. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `SqliteInboundProjectStore.listCompletedProjectSelectionPage()` owns eligibility and keyset semantics; `binding-session-migrations.ts` owns the query-local index; ordered migration `143` plus migration registry, schema epoch, and canonical fingerprint wiring own fresh/legacy/current-fast rollout; startup recovery and Initial Agent Input effect owners remain unchanged. |
| Mutation ownership | src/store/sqlite/inbound-project-store.ts, src/store/sqlite/migrations/binding-session-migrations.ts, src/store/sqlite/migration-registry.ts, src/store/sqlite/migrations.ts, src/store/sqlite/schema-manifest.ts, tests/sqlite-store.test.ts, tests/startup-recovery-workflow.test.ts, tests/sqlite-migrations.test.ts |
| Exclusions | No automatic resubmission, source-message identity change, initial-input workflow change, page cap change, readiness change, or production database mutation. The migration must be additive/idempotent and update canonical metadata safely; no index is added without plan evidence. |
| Isolation | Serial worker after W1 in the authoritative isolated worktree; main validates W1 acceptance and the recorded base before dispatch. |
| Concurrency conflicts | None |
| Verification seam | Public completed-selection page with ineligible Prompt/Submission Intent rows, same-timestamp IDs, upper-bound isolation, continuation pages, empty/invalid limits, and before/after query plans. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/ring-delivery-recovery/target |
| Direct-child boundary | `delegation_allowed = false`; no indirect delegation, staging, commit, installation, restart, deployment, or live SQLite mutation. |
| Acceptance criteria and verification | The page returns exactly the same eligible selections and cursors, does not skip later eligible rows, identity probes remain indexed and exact, and the outer selection scan/order improves according to `EXPLAIN QUERY PLAN`. Run focused SQLite/startup tests, migration checks, typecheck, build, architecture check, and diff check. |
| Verification commands | `npx vitest run --configLoader runner tests/sqlite-migrations.test.ts tests/sqlite-store.test.ts tests/startup-recovery-workflow.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; fresh selection `EXPLAIN QUERY PLAN`; `git diff --check`. |
| Verification results | 3 files / 654 tests passed; typecheck/build/architecture passed; fresh planner uses `project_selections_completed_initial_page` with row-value keyset bounds and no ORDER BY TEMP B-TREE; migration covers fresh, legacy, and formerly-current paths. |
| Commits | `4e97fada` |

## Wave W3: `T3`

### - [x] T3: Replace Conversation page window materialization

| Field | Content |
| --- | --- |
| What to build | Replace the global `ROW_NUMBER()` page CTE with an indexed current/latest-page predicate that preserves creating/active-over-frozen priority, apply the segment keyset before final actionability checks, and add only planner-proven segment/page indexes. |
| Spec references | SCN-3, SCN-4, SCN-5, INV-1, INV-2, INV-4, INV-6, ARCH-3, ARCH-4 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | Bounded conversation projection read optimization with an existing public page method, frozen-page fixtures, and explicit cursor equivalence tests. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `SqliteConversationSegmentStore.listActionableConversationSegmentPage()` owns current/latest page selection; `conversation-segment-migrations.ts` owns query-local indexes; ordered migration `144` plus migration registry, schema epoch, and canonical fingerprint wiring own fresh/legacy/current-fast rollout; projector writes, frozen-page state, and delivery checkpoints remain unchanged. |
| Mutation ownership | src/store/sqlite/conversation-segment-store.ts, src/store/sqlite/migrations/conversation-segment-migrations.ts, src/store/sqlite/migration-registry.ts, src/store/sqlite/migrations.ts, src/store/sqlite/schema-manifest.ts, tests/conversation-segment-store.test.ts, tests/startup-view-converger.test.ts, tests/sqlite-migrations.test.ts |
| Exclusions | No persistent current-page pointer, new aggregate, event, projector write, frozen-page mutation, cursor semantics change, readiness change, or production database mutation. The migration must be additive/idempotent and update canonical metadata safely; do not replace the current-page priority with a generic max-page rule. |
| Isolation | Serial worker after W2 in the authoritative isolated worktree; main validates W1/W2 accepted state and the recorded base before dispatch. |
| Concurrency conflicts | None |
| Verification seam | Public conversation page method with creating/active/frozen/historical pages, pending replies, actionability changes, upper-bound/cursor continuation, same timestamps, and before/after `EXPLAIN QUERY PLAN`. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/ring-delivery-recovery/target |
| Direct-child boundary | `delegation_allowed = false`; no indirect delegation, staging, commit, installation, restart, deployment, or live SQLite mutation. |
| Acceptance criteria and verification | Page items, selected page priority, projected IDs, next cursor, and upper bound are behaviorally identical; the ROW_NUMBER CTE/temp materialization is removed or bounded by the accepted shape; fresh and legacy migration tests pass. Run focused conversation/startup tests, migration checks, typecheck, build, architecture check, and diff check. |
| Verification commands | `npx vitest run --configLoader runner tests/conversation-segment-store.test.ts tests/sqlite-migrations.test.ts tests/startup-view-converger.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; fresh Conversation `EXPLAIN QUERY PLAN`; `git diff --check`. |
| Verification results | 3 files / 236 tests passed; typecheck/build/architecture passed; current/latest page planner uses `conversation_segments_actionable_page_keyset` and indexed current/frozen lookups with no ROW_NUMBER materialization or TEMP B-TREE. Delivery repair added finished-plus-pending-page regression coverage, Worker EXPLAIN coverage, and legacy business-row preservation coverage. |
| Commits | `67b53cbb`, `45e3350e` |

## Final delivery checks

Main reviews each ticket against the new specification, freshly verifies the
integrated state after each accepted result, and creates one atomic
Conventional Commit per completed ticket. Before completion, run full Vitest,
typecheck, build, architecture check, specification/plan artifact checks,
fresh before/after query-plan evidence, and diff check. No merge, install,
restart, deployment, push, or production SQLite mutation is authorized.
