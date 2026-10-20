# Signal-Driven Semantic Convergence Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

The native implement-spec executor will execute the approved ticket graph from
`docs/spec-coder/specs/2026-10-18-signal-driven-semantic-convergence.md` in the
authoritative workspace
`<repo-root>/.worktrees/fix/signal-driven-semantic-convergence`.
The branch is `fix/signal-driven-semantic-convergence`; the recorded wave base and
starting revision are `1e8ae207e47a7ea1db001680ef52b9cb238d8d2e`. The root checkout
and its user-owned changes are excluded. Accounted initial changes are the approved
untracked specification and this plan; no implementation change exists before Gate
3.

Gate 2 was explicitly approved by the user. Baseline records
`8ebab38788de4c94b98749e42471637b`,
`b23572ca3e684bafb99dc14236dda417`, and
`a19cd50bfa1d4530a0401c646e499ccb` are retained in the specification and were
rechecked as reusable for build, typecheck, and 314 files / 5203 tests.

Execution uses six durable singleton waves in the order below. Tickets use one
default direct worker at a time in the authoritative isolated worktree; no parallel
mutation or additional per-ticket worktree is required. This serial isolation is
selected because the cross-context tickets share composition, store contracts, and
integration seams. Main revalidates the workspace/base before each dispatch, owns
Red evidence acceptance, stages only the ticket-owned diff, runs integrated checks,
creates one atomic local commit per accepted ticket, and updates its checkbox only
after acceptance. No push, installation, restart, deployment, live SQLite mutation,
root-checkout integration, or worktree deletion is authorized.

The build cache for every mutating ticket is
`<repo-root>/.cache/fix/signal-driven-semantic-convergence/target`.
Blocking edges are `T1 -> T2`, `T3 -> T4`, and `T1,T2,T4,T5 -> T6`; wave order is
otherwise integration order rather than a fabricated functional dependency.

## Wave W1: `T1`

### - [x] T1: Wake central recovery from committed Core pending work

| Field | Content |
| --- | --- |
| What to build | Make a committed insert or advance of a pending Core lane item emit one post-commit, coalesced historical-recovery wake; remove ordinary/multiplex ingestion's active owner-level empty probes while retaining periodic bounded recovery as the lost-wake watchdog. |
| Spec references | SCN-1, SCN-7, INV-1, INV-2, INV-8, ARCH-1, ARCH-5 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | Bounded durable-signal path with real SQLite commit/rollback tests and an existing supervisor seam; no external effect or credential. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Core event inbox detects real pending-lane mutation and registers a post-commit receipt; `RecoverySupervisor` coalesces explicit wakes and re-arms bounded slices; composition connects the two; ingestion ceases to own historical scanning. |
| Mutation ownership | src/domain/core-event-inbox.ts, src/store/sqlite-store-bundle.ts, src/store/sqlite/core-event-inbox-store.ts, src/coordinator/recovery-supervisor.ts, src/coordinator/core-session-ingestion-supervisor.ts, src/composition/create-bridge-runtime.ts, tests/core-event-inbox-store.test.ts, tests/recovery-supervisor.test.ts, tests/core-session-ingestion.test.ts |
| Exclusions | Historical candidate SQL/reducer policy, Agent Input replay, new queue/timer/worker, status-schema removal, Core JSONL mutation, deployment. |
| Isolation | Serial direct worker in the authoritative isolated worktree at the recorded wave base; main integrates and commits before W2. |
| Concurrency conflicts | T2 |
| Verification seam | Real SQLite nested commit/rollback receipts; supervisor duplicate/in-flight wake tests; ingestion fakes proving ordinary, multiplex, healthy-repeat, and route-unavailable paths never call owner reprojection. Include existing bounded historical workflow tests as preservation evidence. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/signal-driven-semantic-convergence/target |
| Direct-child boundary | delegation_allowed = false; main supplies the common brief and TDD role, and the worker cannot delegate, stage, commit, install, restart, deploy, or mutate live data. |
| Acceptance criteria and verification | A real pending insert/advance wakes only after outer commit; rollback, duplicate, empty, stale, and ignored ingestion emit none; duplicate or in-flight wakes coalesce without duplicate projection; `remaining` schedules one successor; periodic recovery repairs a lost wake; original lane order/event isolation and Agent Input no-replay remain. Run `npx vitest run tests/core-event-inbox-store.test.ts tests/recovery-supervisor.test.ts tests/core-session-ingestion.test.ts tests/historical-recovery-workflow.test.ts`, affected validation for every owned path, typecheck, build, and diff check. |
| Verification commands | `npx vitest run tests/core-event-inbox-store.test.ts tests/recovery-supervisor.test.ts tests/core-session-ingestion.test.ts tests/historical-recovery-workflow.test.ts`; `npm run typecheck`; `npm run architecture:check`; `npm run build`; `git diff --check` |
| Verification results | Main observed two behavior Reds: a same-transaction settlement emitted one false wake, and a coalesced historical wake dropped targeted delivery hints. Fresh integrated Green passed 178/178 focused tests; typecheck and build exited 0; architecture check validated 552 source files; diff check exited 0. The bundled spec-coder affected mapper rejected this arbitrary repository's source paths as unmapped, so repository-native focused/type/build/architecture checks were used. |
| Commits | `d765642fd99f10605e8ba3012e13ce59d6f3f052` |

## Wave W2: `T2`

### - [x] T2: Contract the retired owner-level reprojection API

| Field | Content |
| --- | --- |
| What to build | Remove the now-unreachable owner/session pending-candidate and `reprojectPending` API surface so central historical recovery is the sole historical scan owner, while preserving the public diagnostic shape as inert compatibility data. |
| Spec references | SCN-1, INV-2, INV-8, ARCH-1 |
| Dependencies | T1 |
| Blocked by | T1 |
| Delegation eligibility | Mechanical contract cleanup after a behaviorally green predecessor, with exact reference search and focused store/reader preservation tests. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Delete obsolete pending-lane candidate types and methods from the Core inbox/external transcript contracts, SQLite adapter, and Herdr reader; keep global historical candidate/reprojection APIs and their bounded workflow unchanged. |
| Mutation ownership | src/domain/core-event-inbox.ts, src/domain/ports/external.ts, src/runtime/herdr-events-reader.ts, src/store/sqlite/core-event-inbox-store.ts, src/coordinator/core-session-ingestion-supervisor.ts, tests/core-event-inbox-store.test.ts, tests/core-session-ingestion.test.ts, tests/helpers/herdr-events.ts |
| Exclusions | Core event schema, historical candidate SQL, recovery metrics removal, unrelated reader refactor, JSONL parsing, new compatibility wrapper. |
| Isolation | Serial direct worker after T1's accepted commit because source/test ownership overlaps T1. |
| Concurrency conflicts | T1 |
| Verification seam | Exact source/test reference search proves no retired API remains; existing global historical recovery, Herdr reader ingestion, and event-inbox suites preserve behavior. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/signal-driven-semantic-convergence/target |
| Direct-child boundary | delegation_allowed = false; main supplies the common brief and cleanup/TDD role, and the worker cannot delegate, stage, commit, install, restart, deploy, or mutate live data. |
| Acceptance criteria and verification | No production or test contract exposes `listPendingLaneCandidates` or owner-level `reprojectPending`; the centralized `listHistoricalRecoveryCandidates`/`reprojectHistoricalCandidate` seam remains; Core ingestion and historical recovery tests stay green. Run affected validation, focused inbox/reader/recovery tests, typecheck, build, exact reference search, and diff check. |
| Verification commands | `npx vitest run tests/core-event-inbox-store.test.ts tests/herdr-events-reader.test.ts tests/core-session-ingestion.test.ts tests/historical-recovery-workflow.test.ts`; `npm run typecheck`; `npm run architecture:check`; `npm run build`; exact `rg` reference searches; `git diff --check` |
| Verification results | Main observed the structural Red as live references to both retired APIs after a 205/205 green preservation baseline. Fresh integrated Green passed 202/202 focused tests; typecheck and build exited 0; architecture check validated 552 source files; build-info hash was `d1a69eef27e082d21766d4c75d58a9b770b2f4689e8c386f947f92353778454a`; retired production/test references were zero while centralized historical recovery references remained; diff check exited 0. This arbitrary repository uses its native focused/type/build/architecture checks because the bundled affected mapper does not map its source paths. |
| Commits | `eca1039e77e6961bf293397143255838e893022f` |

## Wave W3: `T3`

### - [x] T3: Persist Worker runtime observations only on semantic change

| Field | Content |
| --- | --- |
| What to build | Make Worker observation persistence return explicit updated/unchanged/stale outcomes and perform no write, timestamp change, card-context invalidation, or wake when normalized runtime evidence is equal. |
| Spec references | SCN-4, INV-5, INV-8, ARCH-3, ARCH-4 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | One fenced SQLite mutation contract plus deterministic caller tests; bounded, reversible, and free of external effects. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Instance store transaction compares semantic observed state, effective pane token, last error, and applicable runtime/parent identity before updating; capability adapter exposes the result; runtime reconciler wakes cards/work only for `updated`; turn supervisor preserves its explicit idle observation behavior. |
| Mutation ownership | src/domain/ports/instance.ts, src/store/sqlite/instance-store.ts, src/store/sqlite/instance-capability-store.ts, src/coordinator/instance-runtime-reconciler.ts, src/coordinator/instance-turn-supervisor.ts, tests/sqlite-store.test.ts, tests/instance-runtime-reconciler.test.ts, tests/instance-turn-supervisor.test.ts |
| Exclusions | Workspace snapshot generation, Binding scan policy, Worker lifecycle redesign, persisted cursor, card renderer changes. |
| Isolation | Serial direct worker after W2; no functional dependency on T2, but the authoritative worktree remains single-writer. |
| Concurrency conflicts | T4 |
| Verification seam | Real temporary-SQLite row/invalidation inspection plus reconciler wake spies and stale generation/runtime/parent counterexamples. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/signal-driven-semantic-convergence/target |
| Direct-child boundary | delegation_allowed = false; main supplies the common brief and TDD role, and the worker cannot delegate, stage, commit, install, restart, deploy, or mutate live data. |
| Acceptance criteria and verification | Reapplying equal normalized evidence preserves all row timestamps/revisions and invalidation counts and emits no wake; one semantic change writes and invalidates once; stale Worker generation, runtime session/Pane, or parent owner loses without mutation; idle turn completion remains correct. Run the three focused suites, affected validation, typecheck, build, and diff check. |
| Verification commands | `npx vitest run tests/sqlite-store.test.ts tests/instance-runtime-reconciler.test.ts tests/instance-turn-supervisor.test.ts`; `npm run typecheck`; `npm run architecture:check`; `npm run build`; `git diff --check` |
| Verification results | Main observed six expected Reds from the old nullable result, unconditional observation write/wake, and missing runtime/parent fences. The first full Green exposed one legitimate pending-runtime attach wake that had depended on the old unconditional observation side effect; the caller now wakes explicitly. Fresh final focused verification passed 599/599 tests; typecheck and build exited 0; architecture check validated 552 source files; build-info hash was `ce62ea04697236efa20d7837659c005036d20fb313a59b4b86da56400bb781f1`; diff check exited 0. |
| Commits | `d381284f4d8cb4b4b47b81cdd550f37d973639e2` |

## Wave W4: `T4`

### - [x] T4: Reconcile one shared semantic Pane delta

| Field | Content |
| --- | --- |
| What to build | Publish immutable semantic workspace generations with bounded add/change/remove Pane deltas, then make Binding and Worker Runtime consumers independently acknowledge the same evidence so idle periodic ticks return without full domain scans. |
| Spec references | SCN-2, SCN-3, SCN-7, INV-3, INV-4, INV-8, ARCH-2, ARCH-3, ARCH-5 |
| Dependencies | T3 |
| Blocked by | T3 |
| Delegation eligibility | Cross-module but bounded runtime capability with fake Herdr inventories, deterministic generations/cursors, and no production host mutation. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `WorkspaceSnapshotCache` owns semantic fingerprint, generation, bounded delta history, targeted invalidation, and explicit rebuild-required results; Binding and Worker reconcilers own independent success cursors and retain separate policy; composition shares one cache/evidence provider; periodic runner remains scheduling-only. |
| Mutation ownership | src/domain/runtime-observation.ts, src/domain/ports/runtime-observation.ts, src/runtime/workspace-snapshot-cache.ts, src/coordinator/herdr-snapshot-collector.ts, src/coordinator/binding-reconciliation-pass.ts, src/coordinator/herdr-runtime-reconciler.ts, src/coordinator/instance-runtime-reconciler.ts, src/runtime/herdr-event-router.ts, src/composition/create-infrastructure-runtime.ts, src/composition/create-worker-runtime.ts, src/composition/create-binding-session-runtime.ts, src/composition/managed-bridge-runtime.ts, tests/workspace-snapshot-cache.test.ts, tests/binding-reconciliation-pass.test.ts, tests/herdr-runtime-reconciler.test.ts, tests/instance-runtime-reconciler.test.ts, tests/herdr-event-realtime.integration.test.ts, tests/managed-bridge-runtime.test.ts, tests/architecture-boundaries.test.ts |
| Exclusions | Persisted delta cursor, new queue/worker/timer, removal of explicit integrity recovery, changed Binding/Worker ownership policy, topology redesign, timer-only tuning. |
| Isolation | Serial direct worker after T3 because `instance-runtime-reconciler` ownership overlaps and T4 consumes T3's explicit observation result. |
| Concurrency conflicts | T3 |
| Verification seam | Cache generation/delta unit tests; both reconciler cursor/failure tests; realtime one-Pane integration; managed-runtime cold-start and repeated-idle tests; architecture boundary assertions. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/signal-driven-semantic-convergence/target |
| Direct-child boundary | delegation_allowed = false; main supplies the common brief and cross-module TDD role, and the worker cannot delegate, stage, commit, install, restart, deploy, or mutate live data. |
| Acceptance criteria and verification | Semantically equal snapshots retain generation; exact add/change/remove deltas are shared non-destructively; each consumer advances only after its applicable success; empty periodic delta invokes no full Binding/project/instance enumeration; changed Pane targets only its related work; removal is not lost; invalidation/overflow/cold start performs one explicit rebuild; topology mutation re-invalidates before cursor advancement. Run all listed focused/integration suites, affected validation, architecture checks, typecheck, build, and diff check. |
| Verification commands | `npx vitest run tests/workspace-snapshot-cache.test.ts tests/binding-reconciliation-pass.test.ts tests/herdr-runtime-reconciler.test.ts tests/instance-runtime-reconciler.test.ts tests/herdr-event-realtime.integration.test.ts tests/managed-bridge-runtime.test.ts tests/architecture-boundaries.test.ts`; `npm run typecheck`; `npm run architecture:check`; `npm run build`; `git diff --cached --check` |
| Verification results | Main observed the topology capability Red as `cache.movePane is not a function`, then verified successful and uncertain topology effects invalidate semantic evidence before ACK. Fresh integrated Green passed 252/252 focused tests; independent Binding/Worker cursors, in-flight invalidation, bounded-history overflow, current-generation idle exits, and topology retry are covered. Delivery review then exposed two production-wiring Reds: targeted invalidation still fetched unrelated workspaces and a lost invalidation hint never refreshed. The first repair Green passed 39/39 focused tests and proves workspace-local refresh, a 60-second authoritative full watchdog that leaves equal generations unchanged, targeted refreshes that do not postpone that watchdog, independent retry cursors, and Primary/Worker recovery through production semantic-cache wiring. A second review Red proved that a topology-changing semantic generation could be ACKed without Worker observation when topology settlement did not invalidate cache evidence; the focused failure observed 33/34 tests with only the missing third replay failing, and the repair Green passed 34/34 by retaining the cursor until both topology and Worker reconciliation complete. The first fresh full suite then exposed one stale Herdr-runtime fixture that still lacked the targeted `listPanes` contract; its focused Green passed 62/62 and now asserts one initial all-workspace inventory plus one workspace-local refresh. The final fresh full suite passed 316/316 files and 5,249/5,249 tests. Fresh repair typecheck and build exited 0 against the canonical build cache; architecture check validated 553 source files; latest build-info hash was `09fb1287d13adf8129027b52b3e9b5c1c8356206b4574807471e500163503a29`; diff checks exited 0. This arbitrary repository uses its native focused/type/build/architecture checks because the bundled affected mapper does not map its source paths. |
| Commits | `f29d267f720f9f9e46b908f52a265f0ddf373063`, `1db43acb422bc16762864f0e3813477f75bdc886`, `126c5570edbde8396b3ac821d5a1a68c27081cb5`, `0d5c03f61257f44bc2329449b15a26d320bbe9b6` |

## Wave W5: `T5`

### - [x] T5: Fence Primary Session projection by active session ownership

| Field | Content |
| --- | --- |
| What to build | Refuse `primary-session` projection before topic mutation unless the Binding is the exact active attached owner for generation, session epoch/native session, Pane/root identity, and non-supersession; carry the session fence in Topic projection identity without destructive schema migration. |
| Spec references | SCN-5, INV-6, INV-8, ARCH-4 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | One transactional projection boundary with a real SQLite ownership matrix and additive JSON projection identity; no Gateway call. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Topic view records the Binding session fence from authoritative projection events; legacy views lacking it require safe current-owner reconstitution before admission; `SqliteCardContextStore` checks lifecycle, attachment, generation, session, Pane/root, and supersession before worker-summary/topic updates or Prepared Delivery reservation. |
| Mutation ownership | src/domain/topic-view.ts, src/events/conversation-view-projector.ts, src/store/sqlite/projection-store.ts, src/store/sqlite/card-context-store.ts, tests/topic-view.test.ts, tests/conversation-view-projector.test.ts, tests/card-context-boundary.integration.test.ts |
| Exclusions | Binding lifecycle redesign, destructive migration, inference from Lark cards, Primary Turn behavior change, renderer changes, old outbox retirement. |
| Isolation | Serial direct worker after W4; no functional dependency on runtime delta, but later T6 relies on this fence. |
| Concurrency conflicts | None |
| Verification seam | Real SQLite active/orphaned/detached/superseded/wrong-generation/wrong-session ownership matrix with topic JSON/version, invalidation, and outbox inspection; projection reducer compatibility tests for the additive session identity. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/signal-driven-semantic-convergence/target |
| Direct-child boundary | delegation_allowed = false; main supplies the common brief and TDD role, and the worker cannot delegate, stage, commit, install, restart, deploy, or mutate live data. |
| Acceptance criteria and verification | Exact active owner admits and reserves normally; every losing owner case settles stale without topic revision/outbox work; missing legacy session identity cannot be treated as current without authoritative reconstitution; active `primary-turn` behavior is preserved. Run the three focused suites, affected validation, typecheck, build, and diff check. |
| Verification commands | `npx vitest run --configLoader runner tests/topic-view.test.ts tests/event-card-integration.test.ts tests/card-context-boundary.integration.test.ts tests/conversation-view-projector.test.ts`; `npm run typecheck -- --tsBuildInfoFile <repo-root>/.cache/fix/signal-driven-semantic-convergence/target/tsconfig.typecheck.tsbuildinfo`; `npm run architecture:check`; `npm run build`; `git diff --cached --check` |
| Verification results | Main observed the losing-owner Red as 7/8 failures before implementation, with only generation mismatch already fenced. Fresh integrated Green passed 82/82 focused tests, including exact-owner admission, eight losing-owner cases, native-session counterexamples, and projector persistence without a presentation revision. Delivery review then proved that `topic_views.updated_at` was not authoritative legacy session evidence because unrelated Topic writers advance it; the counterexample failed 22/23 before repair and showed stale Topic state being attributed to the replacement session. The repair removes timestamp reconstitution, requires exact persisted session identity, and keeps authoritative bridge projection as the additive identity repair path. The complete T5 seam again passed 82/82 focused tests. Typecheck and build exited 0; architecture check validated 553 source files; latest repair build-info hash was `6eb4bdf82e740cf314212e96c72d117e36f619b486fd12dc2b5e502b25d4785a`; staged diff checks exited 0. This arbitrary repository uses its native focused/type/build/architecture checks because the bundled affected mapper does not map its source paths. |
| Commits | `ec826dbce0f1dbd01bb469a74a107865d34c8894`, `0bc68039ca0aa4b9895e926390281847dafb2c0a` |

## Wave W6: `T6`

### - [x] T6: Retire reconstructible invalid-owner heads and prove flat idle convergence

| Field | Content |
| --- | --- |
| What to build | Atomically dismiss a blocking Prepared Delivery only when its durable owner is invalid, its projection is reconstructible, and no new external effect is needed; return typed post-commit projection hints, release the scope, and prove the complete system remains flat across repeated idle passes. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-6, SCN-7, INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, ARCH-1, ARCH-2, ARCH-3, ARCH-4, ARCH-5 |
| Dependencies | T1, T2, T4, T5 |
| Blocked by | T1, T2, T4, T5 |
| Delegation eligibility | Cross-context terminal capability with real SQLite atomicity, fake Gateway/Herdr evidence, and one new integration seam; no live provider effect. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Prepared-delivery store owns effect/owner/reconstructibility proof plus dismissal, audit, quarantine/checkpoint handling, and scope transition in one per-head transaction; maintenance result carries exact projection recovery hints; Ring/composition dispatches them only after successful commit through existing card-context and projection-recovery supervisors; integration test exercises the whole feedback loop. |
| Mutation ownership | src/domain/ports/prepared-delivery.ts, src/store/sqlite/prepared-delivery-store.ts, src/events/ring-delivery-engine.ts, src/composition/create-outbound-runtime.ts, src/events/card-context-rebuilder.ts, src/coordinator/projection-delivery-recovery-watchdog.ts, tests/prepared-delivery-store.test.ts, tests/ring-delivery-recovery.test.ts, tests/signal-driven-semantic-convergence.integration.test.ts |
| Exclusions | Generic uncertain-effect replay/dismissal, age cutoff, backlog purge, new recovery worker/table/queue, Delivery Ring ordering redesign, Feishu retry change, live SQLite edit, deployment. |
| Isolation | Serial direct worker after all blocking capabilities; the new integration file avoids focused-test merge conflicts, and main performs final cross-ticket integration review. |
| Concurrency conflicts | None |
| Verification seam | Real SQLite retirement/counterexample/rollback fixtures, Ring post-commit wake and zero-Gateway tests, plus one integration fixture that repeats converged Core/runtime/projection/delivery passes then injects one Pane/owner change. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/signal-driven-semantic-convergence/target |
| Direct-child boundary | delegation_allowed = false; main supplies the common brief and cross-context TDD role, and the worker cannot delegate, stage, commit, install, restart, deploy, or mutate live data. |
| Acceptance criteria and verification | Invalid-owner reconstructible head is dismissed with retained audit, released scope, one current-projection wake, and zero Gateway calls; valid owner, non-reconstructible projection, active effect/checkpoint, and ordinary uncertain rows remain blocked/recoverable; rollback changes nothing. Repeated idle passes keep pending recovery runs, Worker rows/invalidations, topic revisions, outbox rows, and waiting scopes flat; one real change converges once and returns flat. Run all owned suites, the integration test, affected validation, architecture checks, typecheck, build, full Vitest, and diff check. |
| Verification commands | `npx vitest run --configLoader runner tests/prepared-delivery-store.test.ts tests/ring-delivery-recovery.test.ts tests/signal-driven-semantic-convergence.integration.test.ts`; `npm run typecheck -- --tsBuildInfoFile <repo-root>/.cache/fix/signal-driven-semantic-convergence/target/tsconfig.typecheck.tsbuildinfo`; `npm run architecture:check`; `npm run build`; `npm test -- --configLoader runner`; `git diff --check` |
| Verification results | Main observed the invalid-owner retirement behavior Reds before implementation. Fresh focused Green passed 130/130 tests; architecture check validated 553 source files; build exited 0 with build-info SHA256 `8f6d87c3a9f1fe8341c0ca314c27e757d32d8ed449b540801874d049f9ae9df8`; full Vitest passed 316 files / 5,246 tests with the runner config loader; diff check exited 0. Delivery review found that the original idle-flat integration covered only Ring/CardContext. Its first repair wires healthy Core ingestion, shared semantic cache, Binding and Worker reconcilers, conditional Worker persistence, projection rebuild, invalid-owner retirement, and Ring scope convergence in one in-memory test. A later cross-boundary review found the retirement SQL retained the same unsafe legacy timestamp fallback as projection admission. The expanded feedback-loop test failed by dismissing the old head before any exact replacement identity existed; after repair it keeps the head pending with zero replacement work, then dismisses and converges exactly once after authoritative identity arrives. The cumulative T5/T6 seam passed 212/212 focused tests and made zero Gateway calls. Final Standards review found one Low test-specificity gap because an outbox-count increment did not prove the replacement Primary Main identity. The strengthened test first failed under an incorrect fixed-reply-id assumption, then verified the durable identity tuple `bindingId=current`, `targetRole=session_status`, and `projectionKey=primary-main:current:1`: no replacement exists before authoritative session identity, and the exact replacement exists afterward. The focused integration passed 1/1, the T6 affected suite passed 130/130, and the final fresh repository suite passed 316/316 files and 5,249/5,249 tests. Final typecheck/build used the canonical build cache, architecture validated 553 source files, build-info SHA256 was `6eb4bdf82e740cf314212e96c72d117e36f619b486fd12dc2b5e502b25d4785a`, and diff checks exited 0. The default Vitest config loader first failed only because `node_modules/.vite-temp` was read-only; the runner loader completed the repository suite without changing behavior. Deployment validation then exposed a production-shaped cold-recovery hotspot: no-match invalid-owner candidate discovery scanned terminal history long enough to starve the lease heartbeat. The first repair constrains only initial discovery to the existing nonterminal scope-order partial index, retains the exact per-candidate transaction revalidation, and adds query-plan plus 50,000-terminal-row/4,000-no-match regression coverage. Fresh first-repair verification passed 102/102 focused tests, 316/316 files and 5,251/5,251 full-suite tests, typecheck, build, 553-file architecture validation, and diff checks; its build-info SHA256 was `6c40900efc31c0af38733777108865e56e3ae87bab6dee6136710303682ed085`. Production cold-start then exposed a second hotspot: the same authoritative blocker subquery was evaluated once per pending successor in one heavily skewed scope, taking 131.719 seconds. The production-shaped Red measured 23,432.933 ms for 12,000 successors behind one blocker. The minimum repair materializes distinct pending candidate scopes, resolves one authoritative blocker per scope with the existing delivery-order index, and fetches that exact row by SQLite rowid; it leaves the transaction revalidation query and retirement policy unchanged. The exact Red became Green below the 2,000 ms query threshold, the complete prepared-delivery store passed 102/102, and fresh delivery verification passed typecheck, build, 553-file architecture validation, diff checks, and 316/316 files with 5,251/5,251 tests. The second-repair build-info SHA256 was `dccc5b3b4a6d932b881e53443985ae6c72417b0a41782d1071cef3213121c5a2`. Independent Standards and Spec review then found one shared Medium gap: all distinct candidate scopes were still materialized before the outer limit, so a many-scope backlog remained unbounded. The review repair adds indexed keyset paging over at most 64 candidate scopes per pass, wraps the process-local cursor after exhaustion, and passes only that bounded page to authoritative-head derivation; loss of the cursor only restarts advisory discovery and exact mutation-time revalidation is unchanged. The pagination Red initially reached the later eligible scope on the first pass; Green proves two blocked 64-scope pages return empty and the third reaches the eligible scope. Separate 12,000-successor single-scope and 12,000-independent-scope regressions remain below the 2,000 ms query thresholds, with the many-scope discovery observed at 421-456 ms. Both independent repair reviews returned no findings. Fresh final verification passed 104/104 prepared-delivery tests, typecheck, build, 553-file architecture validation, diff checks, and 316/316 files with 5,253/5,253 tests; the repair build-info SHA256 was `2c2fbbb13b19fd42726def501eadfc61e147445cc37548ca2829e87b4e562b38`. |
| Commits | `70958f92318d046c71b884a3a16733eb1ad7094b`, `a703272c4e9629a0ed099f6382156e0e72a56684`, `0bc68039ca0aa4b9895e926390281847dafb2c0a`, `3ea0841e60971581a9f2b63b9b3b98f49035bdbe`, `9bb10433e2efa76c9a541b663427aceb41a18208`, `a0c995ae6e02a71f0edce6b6c089c17f224ea3d0`, `ea3c1d0664cd0e998b5f07f241f31a81cc478c6f` |

## Final delivery checks

Main performs independent Standards and Spec reviews, repairs findings through the
ticket TDD loop, and confirms each ticket has one accepted atomic local commit.
Then main freshly runs the complete affected set, `npm run typecheck`,
`npm run build`, architecture checks, the full Vitest suite, `git diff --check`,
and spec-coder delivery artifact validation. Main compares implementation coverage
in both directions against every SCN/INV/ARCH reference and confirms no retired
owner-level reprojection production reference remains. Delivery stops after local
verification and commits; merge/cherry-pick, push, installation, force restart,
deployment, live latency observation, and production backlog repair require later
explicit authority.
