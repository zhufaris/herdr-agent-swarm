# Startup Convergence Bounds Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification: `docs/spec-coder/specs/2026-10-12-startup-convergence-bounds.md`.
Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`, clean isolated
worktree on `main`, base
`c4a1eb43730bb9846fe45b6c3f633bda14a704b6`. The original user checkout is
excluded. Baseline records `1fdb056ace0042b0988d82fa044f43dd`,
`7a14bc1e79b1430393e3964a44ef0bb4`, and
`dd394cfc002d48a19d300ac7ba8fe846` passed startup-focused tests, typecheck,
and build. The local selection-and-yield design and Gate 2 were auto-selected
under explicit autonomous authority. Main owns tests' Red evidence, plan state,
integration, commits, deployment, and completion claims.

## Wave W1: `T1`

### - [x] T1: Stop terminal null-Pane startup projection

| Field | Content |
| --- | --- |
| What to build | Exclude terminal Bindings without an authoritative Pane from the startup projection read model and add a coordinator race guard so they cannot create new Pane-owned Main/Answer intents or remain in permanent retry. |
| Spec references | SCN-1, SCN-2, INV-1, INV-2, ARCH-1, ARCH-2 |
| Dependencies | None |
| Delegation eligibility | Bounded query/coordinator behavior with a real in-memory SQLite/MainCardWorkflow seam, no credentials or external mutation. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `SqliteProjectionStore` owns authoritative selection; `StartupViewConverger` owns selection-to-use race protection. Existing Delivery recovery retains all prepared/historical effects. |
| Mutation ownership | src/store/sqlite/projection-store.ts, src/coordinator/startup-view-converger.ts, tests/startup-view-converger.test.ts |
| Exclusions | SQLite schema/data migration, delivered-version rewrite, scope-fence relaxation, error-string catches, pending/dead-letter replay, T2 page budget, docs and plan checkboxes. |
| Isolation | Serial shared workspace at recorded base; main verifies ownership and integrated state before acceptance. |
| Concurrency conflicts | T2 |
| Verification seam | Production-shaped archived/unattached/null-pane/dirty Topic fixture through real `StartupViewConverger` and `MainCardWorkflow`, plus direct selection and selected-binding race cases. |
| Host capacity | One direct-child slot; main rechecks capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; main supplies the full implementation brief; worker cannot spawn, stage, commit, edit plan artifacts, install, or deploy. |
| Acceptance criteria and verification | Terminal null-pane Binding produces no failed ID or outbound reply and retains historical Topic versions; active and terminal-with-Pane dirty views remain eligible; a concurrent terminal/null-pane transition is safely skipped. Run focused tests, typecheck, and architecture check. |
| Verification commands | `npx vitest run tests/startup-view-converger.test.ts`; `npm run typecheck`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed the production-shaped Red as `['pending-view']` versus `[]` with 30 existing passes, then Green as 33/33 tests. Delivery review found the initial race test used a stale prebuilt terminal snapshot; a genuine interleaving Red then observed an extra `selection-race` Main Card projection after SQLite archived/cleared the Pane, and passed 37/37 after authoritative Binding/generation recheck. Typecheck, 535-file architecture check and diff check exited 0. |
| Commits | `dd247c5c`, `d7da020b` |
| Blocked by | None |

## Wave W2: `T2`

### - [x] T2: Yield retained activity recovery after two pages

| Field | Content |
| --- | --- |
| What to build | Bound one startup convergence pass to two retained Session Activity pages while preserving exact cursor continuation through the existing full-rescan retry. |
| Spec references | SCN-3, INV-3, ARCH-1, ARCH-2 |
| Dependencies | None |
| Delegation eligibility | One deterministic page-budget change with injected recovery-port tests and no persistence/external mutation. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `StartupViewConverger` remains page-budget/cursor owner; `StartupViewRecovery` remains retry owner without interface or state changes. |
| Mutation ownership | src/coordinator/startup-view-converger.ts, tests/startup-view-converger.test.ts |
| Exclusions | Session Activity SQL/index redesign, new scheduler/timer/worker, cursor format, T1 binding selection, docs and plan checkboxes. |
| Isolation | Serial shared workspace after W1 is integrated; no parallel mutation because ownership overlaps T1. |
| Concurrency conflicts | T1 |
| Verification seam | Mock recovery port returns more than two pages; first pass calls exactly two pages and raises the existing bounded continuation signal, second pass starts at cursor two and completes without replay. |
| Host capacity | One direct-child slot; main rechecks capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; main supplies the full implementation brief; worker cannot spawn, stage, commit, edit plan artifacts, install, or deploy. |
| Acceptance criteria and verification | Each pass processes at most 256 retained results; continuation cursor survives yielding; next retry resumes after page two; existing one-page and completed recovery behavior remains unchanged. Run focused tests, typecheck, and architecture check. |
| Verification commands | `npx vitest run tests/startup-view-converger.test.ts tests/startup-view-recovery.test.ts`; `npm run typecheck`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed Red as 1 intended continuation failure with 32 existing passes, then integrated Green as 37/37 tests passed across 2 suites; typecheck, 535-file architecture check and diff check exited 0. |
| Commits | `c781e6b4` |
| Blocked by | None |

## Final delivery checks

Main performs independent Standards and Spec reviews, routes accepted findings
through TDD, and freshly runs startup-focused suites, typecheck, build,
architecture and documentation checks, the full Vitest suite, and the delivery
artifact checker. After immutable installation and force restart, the live
feedback loop must turn green, `startupViews.pendingCount` must stay zero,
repeated `invalid_delivery_scope` startup logs for the historical Binding must
stop, startup view-convergence duration must improve, and readiness, Delivery
backlog, Core ingestion, and latency must not regress.

Gate 3 recommendation: execute W1 then W2 through serial direct workers in the
authoritative worktree. This was auto-selected under explicit autonomous
authority because the tickets overlap files and parallel mutation would not be
isolated; no functional dependency is invented.
