# Feishu Historical Projection Recovery Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification: `docs/spec-coder/specs/2026-10-14-feishu-history-recovery.md`.
Gate 1 design and Gate 2 specification were approved interactively on
2026-10-14. Gate 3 remains pending.

Workspace: `/tmp/herdr-agent-swarm-feishu-recovery-from-stop-active`, reused as
a clean isolated task worktree on branch
`fix/feishu-recovery-from-stop-active`, starting at
`0e9b5bebef70e578d32fc70740c4b72008cbda27`. The user's original
`stop-active-turn-deploy` worktree and its staged changes remain excluded.
Initial task-owned changes are the approved specification and this plan only.

Dependencies were confirmed by `npm ls --depth=0`. Fresh same-request baseline
records are `d700a2d9823a4c419fe2f3a08b449280` for typecheck,
`3b6f57d6e9714414b9e9f4d57bf4b4d0` for build, and
`7789bbfa15f642a99bb0eeee4fd993a3` for the complete suite. The observed
results were exit 0 for typecheck and build, plus 303 files and 4,840 tests
passing. Planning reruns any command whose complete capture cannot be reused.

The current request explicitly opts out of subagent delegation. Every ticket
is therefore `main-local`, occupies one singleton wave, and retains
`delegation_allowed = false`. This plan authorizes no install, restart,
deployment, production-state mutation, push, pull request, or external issue.

## Wave W1: `T1`

### - [x] T1: Recover exact-owner pending Core history

| Field | Content |
| --- | --- |
| What to build | Add one bounded Historical Recovery Slice that selects exact active/orphaned or Segment-owned pending Core lane heads, transactionally revalidates their route, projects one event at a time as history work, yields between writes, and isolates stale or poison candidates. |
| Spec references | SCN-1, SCN-2, SCN-5, SCN-7, SCN-8, INV-1, INV-2, INV-5, INV-6, INV-7, ARCH-2, ARCH-3, ARCH-4 |
| Dependencies | None |
| Delegation eligibility | Grounded and independently testable, but request-scoped user opt-out forbids spawning or indirect delegation. |
| Delegation mode | main-local; request-scoped user opt-out forbids subagents |
| Ownership and implementation path | Core Projection owns pending-event state and exact route fencing; the new coordinator workflow owns slice budgets and event-loop yields; SQLite translates persisted lane, binding, Segment and route facts into internal DTOs and applies the conditional write. Canonical projectors retain event semantics and no SQLite row crosses the port. |
| Mutation ownership | docs/spec-coder/specs/2026-10-14-feishu-history-recovery.md, docs/spec-coder/plans/2026-10-14-feishu-history-recovery.md, src/domain/core-event-inbox.ts, src/domain/historical-recovery.ts, src/domain/ports/historical-recovery.ts, src/domain/ports/conversation-segment.ts, src/coordinator/historical-recovery-workflow.ts, src/store/sqlite/core-event-inbox-store.ts, src/store/sqlite/conversation-segment-store.ts, src/store/sqlite/capability-graph.ts, src/store/sqlite/schema.ts, src/store/sqlite/migrations.ts, src/store/sqlite/migration-registry.ts, src/store/sqlite/schema-manifest.ts, tests/core-event-inbox-store.test.ts, tests/conversation-segment-store.test.ts, tests/historical-recovery-workflow.test.ts, tests/sqlite-migrations.test.ts |
| Exclusions | Turn Card create recovery, RecoverySupervisor scheduling, archived/closed owners, current-revision quarantine reopening, Gateway fallback, deployment and production mutation. |
| Isolation | Main-local mutation in the selected isolated worktree; no concurrent mutation and no additional worktree required. |
| Concurrency conflicts | T2, T3 |
| Verification seam | SQLite integration tests for candidate selection and competing-handle route changes; workflow tests with a monotonic clock and event-loop probe; migration and query-plan tests for bounded oldest-head selection. |
| Host capacity | No child slot is used because the request-scoped opt-out selects local execution. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect child may be created for this ticket. |
| Acceptance criteria and verification | Active/orphaned and exact Segment routes project in lane order; ambiguous, archived, closed and unmapped routes are refused; a route change loses without projection, settlement, Segment or Outbox writes; one event transaction occurs between yields; duplicate replay is idempotent; projection failures retry under the current three-attempt policy and quarantine only the poison head; current-revision quarantines remain unchanged. Run the new workflow tests, focused Core Inbox tests, migration/query-plan tests, typecheck, build, architecture check and diff check. |
| Blocked by | None |
| Verification commands | `npx vitest run tests/historical-recovery-workflow.test.ts tests/core-event-inbox-store.test.ts tests/conversation-segment-store.test.ts tests/sqlite-migrations.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Fresh integrated Green: 4 files and 239 tests passed; typecheck exited 0; build exited 0 with identity `sha256:165e943fce0e5bbdbe4a9644e6da126d436bdf733fda8d7954235ca40669dcbb`; architecture check validated 544 source files; diff check passed. Red evidence separately observed the absent exact-route selector, absent conditional historical projector, absent Segment-owner route, and absent recovery index before each minimum implementation. |
| Commits | `2edcb20c` |

## Wave W2: `T2`

### - [x] T2: Recover never-attempted Turn Cards at the original target

| Field | Content |
| --- | --- |
| What to build | Extend the Historical Recovery Slice to reserve a bounded set of missing Turn Card creates only when the page has no message and no prior outbound effect, preserving the exact original Gateway/root target and history work class. |
| Spec references | SCN-3, SCN-4, SCN-5, SCN-8, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, ARCH-2, ARCH-3, ARCH-4 |
| Dependencies | T1 |
| Delegation eligibility | Grounded and independently testable after T1, but request-scoped user opt-out forbids spawning or indirect delegation. |
| Delegation mode | main-local; request-scoped user opt-out forbids subagents |
| Ownership and implementation path | Conversation Projection owns page eligibility and canonical create identity; HistoricalRecoveryWorkflow owns the per-slice card budget; SQLite atomically revalidates owner/route/page/effect absence and links one history-class Outbox reservation. Existing Gateway and Delivery Ring modules retain provider and priority behavior. |
| Mutation ownership | docs/spec-coder/plans/2026-10-14-feishu-history-recovery.md, src/domain/historical-recovery.ts, src/domain/ports/historical-recovery.ts, src/domain/ports/conversation-segment.ts, src/coordinator/historical-recovery-workflow.ts, src/coordinator/turn-card-workflow.ts, src/store/sqlite/conversation-segment-store.ts, src/store/sqlite/capability-graph.ts, src/store/sqlite/migrations.ts, src/store/sqlite/migration-registry.ts, src/store/sqlite/schema-manifest.ts, tests/conversation-segment-store.test.ts, tests/historical-recovery-workflow.test.ts, tests/sqlite-migrations.test.ts, tests/turn-card-workflow.test.ts, tests/ring-delivery-recovery.test.ts |
| Exclusions | Rerouting to group root, archived/closed pages, operator-skipped rows, uncertain effects, prior claims/checkpoints/attempts, provider-confirmed defunct targets, semantic rollout changes and delivery-priority changes. |
| Isolation | Main-local mutation in the selected isolated worktree after T1; no concurrent mutation. |
| Concurrency conflicts | T1, T3 |
| Verification seam | Conversation Segment SQLite tests cover exact safe reservation and every refusal; workflow tests cover the card budget, durable-before-wake ordering and restart/duplicate idempotency; migration query-plan tests cover bounded page selection. |
| Host capacity | No child slot is used because the request-scoped opt-out selects local execution. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect child may be created for this ticket. |
| Acceptance criteria and verification | A never-attempted active/orphaned page creates one history Outbox effect at the original target; repeated scan/reopen creates none; competing owner/root/page changes lose atomically; archived, skipped, uncertain, attempted, checkpointed, dismissed, dead-lettered and defunct-target evidence is unchanged; outbound wake occurs only after a committed reservation. Run workflow and Conversation Segment focused tests, migration/query-plan tests, Delivery Ring history-priority regression tests, typecheck, build, architecture check and diff check. |
| Blocked by | T1 |
| Verification commands | `npx vitest run tests/historical-recovery-workflow.test.ts tests/turn-card-workflow.test.ts tests/conversation-segment-store.test.ts tests/sqlite-migrations.test.ts tests/ring-delivery-recovery.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Fresh integrated Green: 5 files and 213 tests passed; typecheck exited 0; build exited 0 with identity `sha256:c4fe8f6de1e66e086e4be1c700ddfd31877f587fc11c268532ba06cf807e9fbe`; architecture check validated 544 source files; diff check passed. Red evidence showed the missing bounded card lane, missing exact never-attempted reservation, and missing page-selection index before implementation. |
| Commits | `c1eb701c` |

## Wave W3: `T3`

### - [x] T3: Schedule observable history recovery after startup

| Field | Content |
| --- | --- |
| What to build | Integrate the complete HistoricalRecoveryWorkflow into RecoverySupervisor as a periodic-only lane, keep startup repair/eager scan history-free, expose bounded privacy-safe diagnostics, and preserve single-flight shutdown behavior. |
| Spec references | SCN-6, SCN-7, SCN-8, SCN-9, INV-5, INV-7, INV-8, ARCH-1, ARCH-2, ARCH-4 |
| Dependencies | T2 |
| Delegation eligibility | Grounded after T2 and independently inspectable through supervisor/runtime/status seams, but request-scoped user opt-out forbids spawning or indirect delegation. |
| Delegation mode | main-local; request-scoped user opt-out forbids subagents |
| Ownership and implementation path | RecoverySupervisor remains the only scheduling/lifecycle owner and distinguishes startup delivery scan from interval history work; composition injects the workflow through its internal port; health/status/log adapters expose only bounded counters and ages. The workflow and persistence adapters retain all eligibility judgments. |
| Mutation ownership | docs/spec-coder/plans/2026-10-14-feishu-history-recovery.md, src/domain/recovery.ts, src/domain/historical-recovery.ts, src/domain/ports/historical-recovery.ts, src/coordinator/recovery-supervisor.ts, src/coordinator/historical-recovery-workflow.ts, src/composition/create-bridge-runtime.ts, src/store/sqlite/core-event-inbox-store.ts, tests/recovery-supervisor.test.ts, tests/managed-bridge-runtime.test.ts, tests/health-server.test.ts, tests/service-logger.test.ts, tests/historical-recovery-workflow.test.ts, tests/core-event-inbox-store.test.ts |
| Exclusions | New timer/queue, readiness relaxation, startup-stage reordering unrelated to history, manual command expansion, credentials, production state, install/restart/deploy and external publication. |
| Isolation | Main-local mutation in the selected isolated worktree after T2; no concurrent mutation. |
| Concurrency conflicts | T1, T2 |
| Verification seam | Supervisor tests distinguish startup repair, eager scan and interval work; managed runtime tests prove history is not awaited by startup; health/logger tests assert bounded diagnostics and payload/cursor/secret canary absence; shutdown tests prove the active slice is awaited once. |
| Host capacity | No child slot is used because the request-scoped opt-out selects local execution. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect child may be created for this ticket. |
| Acceptance criteria and verification | Startup delivery repair and eager scan make zero history calls; interval work coalesces one history lane and runs ordinary delivery recovery first; duplicate ticks remain single-flight; failures are isolated and leave future periodic recovery armed; stop awaits the active slice and starts no successor; status reports eligible/excluded/recovered/stale/yield/duration evidence without payloads, message text, CardKit JSON, cursors or secrets. Run supervisor/runtime/status/logger focused tests, all affected T1/T2 suites, typecheck, build, architecture/docs checks and diff check. |
| Blocked by | T2 |
| Verification commands | `npx vitest run tests/recovery-supervisor.test.ts tests/historical-recovery-workflow.test.ts tests/core-event-inbox-store.test.ts tests/conversation-segment-store.test.ts tests/turn-card-workflow.test.ts tests/sqlite-migrations.test.ts tests/ring-delivery-recovery.test.ts tests/managed-bridge-runtime.test.ts tests/health-server.test.ts tests/service-logger.test.ts tests/outbound-runtime-composition.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `npm run docs:audit`; `git diff --check` |
| Verification results | Fresh integrated Green: 11 files and 390 tests passed; typecheck exited 0; build exited 0 with identity `sha256:f2e18faf2dacac08477c65fd9fee5eca8788c66986afb1bf61e64d756c21b3ca`; architecture check validated 544 source files; documentation audit and diff check passed. Red evidence proved interval history was absent while startup repair/eager scan remained history-free; Green adds interval-only execution, single-flight shutdown, bounded backlog/result diagnostics and privacy-safe success logs. |
| Commits | `a10615e2`, `5a27a558`, `ca297164`, `3d76662c` |

## Final delivery checks

- Every scenario, invariant and architecture decision is mapped to at least one
  completed ticket and executable evidence.
- Each ticket follows behavior Red-Green, passes its focused and affected
  checks, updates this checkbox/evidence, and creates one path-scoped atomic
  Conventional Commit without the `automated co-author trailer` trailer.
- Main reviews each complete diff for exact-target, pending-only, no-replay,
  startup-isolation, idempotency, transaction and privacy invariants before
  accepting its commit.
- After T3, run fresh `npm run typecheck`, `npm run build`,
  `npm run architecture:check`, documentation checks, `git diff --check`, and
  the complete `npm test` suite.
- Run the delivery artifact checker against this specification and plan, inspect
  local commit history and verify the worktree is clean.
- No install, restart, deployment, live Feishu smoke, production database
  mutation, push, pull request or external issue occurs without separate user
  authorization.
