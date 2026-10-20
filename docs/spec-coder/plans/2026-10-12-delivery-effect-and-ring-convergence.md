# Delivery Effect and Ring Convergence Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification:
`docs/spec-coder/specs/2026-10-12-delivery-effect-and-ring-convergence.md`.
Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`, existing
isolated clean worktree on `main`, base
`2fba0e4687dc65ff8ab698842a1c289421d40727`. The original user checkout is
excluded. Baseline records `5a1f79e9a7e248f1a9dc5d83f3177858`,
`5c96356d740841949eac1d5df6aaffae`, and
`a956c3ad81e24cc58c3011fe31fdf8a8` passed 214 affected tests, typecheck, and
build. The three-ticket design and Gates 1-3 were auto-selected under the
active goal's explicit autonomous/default execution authority. Main owns Red
evidence, integration, commits, deployment, and completion claims.

## Wave W1: `T1`

### - [x] T1: Preserve ambiguous Feishu effects without replay

| Field | Content |
| --- | --- |
| What to build | Classify `5xx`, `408`, transport timeout/reset, and missing acknowledgement identity as uncertain; allow root-forward fallback only for exact `400/230001` rejection. |
| Spec references | SCN-1, INV-1, ARCH-1 |
| Dependencies | None |
| Delegation eligibility | Bounded Gateway adapter behavior with deterministic table tests and no production external call. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Feishu adapter boundary translates provider evidence into `GatewayFailure`; durable delivery continues to own retry or reconciliation from that provider-neutral result. |
| Mutation ownership | src/gateways/feishu/errors.ts, src/adapters/lark-adapter.ts, tests/feishu-delivery-errors.test.ts, tests/lark-adapter.test.ts |
| Exclusions | Outbox retry policy, provider SDK upgrade, Gateway readiness circuit, Discord behavior, delivery persistence. |
| Isolation | Serial execution in the authoritative isolated worktree. |
| Concurrency conflicts | None |
| Verification seam | Failure classification table and fake SDK forward calls prove uncertainty and exact fallback behavior without a network effect. |
| Acceptance criteria and verification | `5xx`, `408`, reset/timeout, and missing message ID never cause retry-safe rejection or a second forward; `400/230001`, `409`, `425`, `429`, permanent `4xx`, and pre-connect failures retain their specified outcomes. Run the two focused test files, typecheck, build, and diff check. |
| Verification commands | `npx vitest run tests/feishu-delivery-errors.test.ts tests/lark-adapter.test.ts`; `npm run typecheck`; `npm run build`; `git diff --check` |
| Verification results | Main observed Red as four exact ambiguous-effect/fallback failures, then fresh integrated Green as 89/89 focused tests. Typecheck, build, and diff check exited 0. |
| Commits | `b6faa550` |
| Blocked by | None |

## Wave W2: `T2`

### - [x] T2: Release Ring grants after pre-effect exceptions

| Field | Content |
| --- | --- |
| What to build | Ensure every rejected delivery execution releases a still-active per-Ring grant, removes only the cached reference, releases the scheduler permit, and requests ordinary durable refill. |
| Spec references | SCN-4, INV-4, ARCH-3 |
| Dependencies | None |
| Delegation eligibility | One process-local lifecycle owner and injected deterministic exceptions; no persistence schema or provider effect. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `RingDeliveryEngine` drain lifecycle owns scheduler and Ring grant cleanup; SQLite/refill remains durable authority. |
| Mutation ownership | src/events/ring-delivery-engine.ts, tests/ring-delivery-hot-path.test.ts |
| Exclusions | New supervisor, retry queue, timer, refill batching, startup preemption redesign, Ring eviction. |
| Isolation | Serial execution after T1 in the authoritative isolated worktree. |
| Concurrency conflicts | T3 |
| Verification seam | Inject preparation, supersession, and claim exceptions after `beginGrant`; prove a second offer in the same scope executes without restart and no duplicate provider effect occurs. |
| Acceptance criteria and verification | Scheduler and Ring grants return to zero after each exception; stale cache is gone; cold recovery requests refill; the same scope remains runnable. Run Ring hot-path tests, typecheck, build, architecture check, and diff check. |
| Verification commands | `npx vitest run tests/ring-delivery-hot-path.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed Red as three stranded-grant failures after preparation, supersession, and claim exceptions. Fresh integrated Green passed 33/33 Ring hot-path tests, typecheck, build, the 535-file architecture check, and diff check. Main rejected the worker's unrelated synchronous-drain timing change and retained only rejection cleanup. |
| Commits | `c537290a` |
| Blocked by | None |

## Wave W3: `T3`

### - [x] T3: Converge Primary and Worker Conversation Page heads

| Field | Content |
| --- | --- |
| What to build | Replace Primary-only page delivery methods with one owner-neutral Conversation Page interface; claim exact Worker or Primary pages and atomically retire only deterministically stale, no-effect page heads. |
| Spec references | SCN-2, SCN-3, INV-2, INV-3, ARCH-2, ARCH-3 |
| Dependencies | T2 |
| Delegation eligibility | Crosses the domain port and SQLite atomic transition with real temporary-database tests; bounded to the existing Conversation Page delivery seam. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Domain port names the owner-neutral interface; prepared-delivery store privately applies Primary/Worker owner predicates and page transitions; Ring engine consumes one Conversation Page contract. |
| Mutation ownership | src/domain/ports/prepared-delivery.ts, src/events/ring-delivery-engine.ts, src/store/sqlite/prepared-delivery-store.ts, tests/ring-delivery-hot-path.test.ts, tests/ring-delivery-recovery.test.ts, tests/prepared-delivery-store.test.ts |
| Exclusions | Page-state schema changes, production data edits, old-message age cutoff, Human Recovery, new quarantine type, global ordering redesign. |
| Isolation | Serial execution after T2 because Ring engine and hot-path tests overlap. |
| Concurrency conflicts | T2 |
| Verification seam | Real SQLite fixtures prove exact Worker/parent claims, Primary parity, closed-page local retirement, advanced-revision repair, and refusal to retire any possible-effect or merely blocked row. |
| Acceptance criteria and verification | Current Worker pages claim and settle; stale non-closed pages release their old pending link for current projection; closed undelivered pages terminalize without Gateway execution; claimed/checkpointed/uncertain/cooldown/prerequisite/conflict/lease failures are preserved. Run affected store/Ring suites, typecheck, build, architecture check, and diff check. |
| Verification commands | `npx vitest run tests/ring-delivery-hot-path.test.ts tests/ring-delivery-recovery.test.ts tests/prepared-delivery-store.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check`; search for retired Primary-only method names. |
| Verification results | Main observed Red as three exact Worker/stale/closed-page failures, then a separate frozen-page immutability Red during integration review. Fresh integrated Green passed 161/161 tests across 3 suites, typecheck, build, the 535-file architecture check, and diff check. Worker/parent claims, advanced create/update repair, closed local retirement, frozen preservation, and possible-effect/cooldown/prerequisite preservation are covered; no retired Primary-only source/test references remain. |
| Commits | `e12d4288` |
| Blocked by | T2 |

## Wave W4: `T4`

### - [x] T4: Preserve stale heads behind delivery blockers

| Field | Content |
| --- | --- |
| What to build | Repair delivery-review findings so stale-page retirement repeats the claim's conflict, prerequisite, cooldown, and lease guards, and add real Worker checkpoint/ACK evidence. |
| Spec references | SCN-2, SCN-3, INV-2, INV-3 |
| Dependencies | T3 |
| Delegation eligibility | Main-owned review repair with four focused Red interleavings and one existing SQLite transaction seam. |
| Delegation mode | main-local |
| Ownership and implementation path | `SqlitePreparedDeliveryStore` remains the single transactional owner; retirement may run only when the ordinary blockers and current lease also permit it. |
| Mutation ownership | src/store/sqlite/prepared-delivery-store.ts, tests/ring-delivery-hot-path.test.ts |
| Exclusions | New blocker state, recovery worker, table, timer, retry policy, production data mutation, or unrelated delivery behavior. |
| Isolation | Serial repair in the authoritative isolated worktree after T3 and both review axes. |
| Concurrency conflicts | T3 |
| Verification seam | Combine an advanced page with cooldown, active quarantine, unmet prerequisite, and lost lease; prove every row/page remains unchanged. Claim, checkpoint, and ACK an exact Worker page in real SQLite. |
| Acceptance criteria and verification | Retirement is impossible behind each ordinary blocker or without the exact lease; Worker settlement updates the outbox and Conversation Page through the owner-neutral seam. |
| Verification commands | `npx vitest run tests/ring-delivery-hot-path.test.ts tests/ring-delivery-recovery.test.ts tests/prepared-delivery-store.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed four exact Red failures for cooldown, quarantine, prerequisite, and lease combinations. Fresh integrated Green passed 165/165 affected tests, including Worker claim/checkpoint/ACK evidence; typecheck, build, the 535-file architecture check, and diff check exited 0. |
| Commits | `e6732ec3` |
| Blocked by | T3 |

## Wave W5: `T5`

### - [x] T5: Keep retry tests on proven rejection fixtures

| Field | Content |
| --- | --- |
| What to build | Update retry-specific integration fixtures from ambiguous `503` to explicit rejected/transient `429`, preserving their intended retry and bounded-attempt assertions under INV-1. |
| Spec references | SCN-1, INV-1 |
| Dependencies | T1 |
| Delegation eligibility | Main-local full-suite repair limited to test evidence; no production mutation. |
| Delegation mode | main-local |
| Ownership and implementation path | Tests choose provider evidence matching the behavior under test; production Feishu classification remains unchanged. |
| Mutation ownership | tests/concurrency-controls.integration.test.ts, tests/message-delete-delivery.test.ts, tests/project-selection-integration.test.ts |
| Exclusions | Production retry policy, error classification, Gateway behavior, timings, dependencies, or unrelated assertions. |
| Isolation | Serial repair after fresh full-suite evidence exposed four obsolete fixtures. |
| Concurrency conflicts | None |
| Verification seam | The exact four formerly failing scenarios must retry under `429`; ambiguous `503` behavior remains covered by T1 as uncertain/no-replay. |
| Acceptance criteria and verification | Retry tests use a proven rejection and retain their original outcomes; all three affected files pass without weakening assertions. |
| Verification commands | `npx vitest run tests/concurrency-controls.integration.test.ts tests/message-delete-delivery.test.ts tests/project-selection-integration.test.ts`; `git diff --check` |
| Verification results | Fresh full suite produced four exact failures because old `503` fixtures contradicted INV-1. After fixture correction, the four focused scenarios and all 56/56 tests across the three affected files passed. |
| Commits | `c9dcb5e4` |
| Blocked by | T1 |

## Wave W6: `T6`

### - [x] T6: Fence pristine initial-card recovery by process epoch

| Field | Content |
| --- | --- |
| What to build | Pass one immutable Ring startup timestamp into Conversation Page claim and locally terminalize only pristine page-zero creates that predate this process. |
| Spec references | SCN-5, INV-3, INV-5, ARCH-2, ARCH-3 |
| Dependencies | T3, T4 |
| Delegation eligibility | Live-evidence repair crosses the Ring/store seam but has deterministic process-time and real-SQLite tests; main retains execution due active service incident. |
| Delegation mode | main-local |
| Ownership and implementation path | Ring owns process epoch; PreparedDeliveryStore atomically applies it with existing effect, owner, blocker, page, and lease fences. |
| Mutation ownership | src/domain/ports/prepared-delivery.ts, src/events/ring-delivery-engine.ts, src/store/sqlite/prepared-delivery-store.ts, tests/ring-delivery-hot-path.test.ts |
| Exclusions | Arbitrary age threshold, production DB edit, segment lifecycle rewrite, new persistence, replay queue, Human Recovery, or non-initial Card Page suppression. |
| Isolation | Serial incident repair in the authoritative isolated worktree while the deployed service is intentionally stopped. |
| Concurrency conflicts | T3, T4 |
| Verification seam | Inject deterministic Ring `now`; prove a pre-epoch pristine page-zero create dismisses/terminalizes without Gateway execution, a current create claims, and possible-effect rows remain pending. |
| Acceptance criteria and verification | Restart cannot create the first visible card for a pre-existing pristine Segment; current-process initial cards and all possible-effect evidence preserve existing behavior. |
| Verification commands | `npx vitest run tests/ring-delivery-hot-path.test.ts tests/ring-delivery-recovery.test.ts tests/prepared-delivery-store.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed Red when a pristine pre-epoch initial page was claimed. An initial engine-start cutoff also broke two same-process paths and was rejected; the corrected immutable module/process epoch passed 168/168 affected tests. Current-process creates and provider-checkpoint evidence remain claimable; typecheck, build, 535-file architecture check, and diff check exited 0. |
| Commits | `8bac12aa` |
| Blocked by | T3, T4 |

## Final delivery checks

Main runs independent Standards and Spec reviews, routes any behavior repair
through TDD, then freshly runs the full Vitest suite, typecheck, build,
architecture/docs checks, and delivery artifact validation. After immutable
install and force restart, verify build identity and readiness; query the two
observed reply IDs and their Conversation Pages; compare pending,
`waitingBehindScope`, `staleAttempts`, Core failures, duplicate-effect evidence,
and available delivery latency.

Gate 3 recommendation: execute the three serial waves with one default direct
worker per ticket and main-owned Red/integration/commit evidence. This was
auto-selected under the active goal's explicit autonomous/default execution
authority; no parallel-isolation overhead or new architectural layer is
introduced.
