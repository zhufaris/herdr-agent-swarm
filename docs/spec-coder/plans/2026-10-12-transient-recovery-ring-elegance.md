# Transient Recovery and Ring Elegance Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification:
`docs/spec-coder/specs/2026-10-12-transient-recovery-ring-elegance.md`.

Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`, clean
isolated worktree on `main`, base
`9ed2fbd0e13368cb189437129eb041cf820033b8`. The original user checkout is
excluded. Baseline records `d606af9fc09f4089a2a2d83e4281b3f5`,
`81df623be597478098cc338c22e123c3`, and
`92afc6c4c7d64c9fb2bfe2cff00c4b01` passed full tests, typecheck, and build.
The selected local-owner design and Gate 2 were auto-selected under explicit
autonomous authority. Main owns plan checkboxes, integration, commits,
deployment, and completion claims.

## Wave W1: `T1`, `T2`, `T3`

W1 contains three independent, ownership-disjoint bounded tickets. They are
eligible for delegation, but the authoritative worktree is shared, so main
dispatches one direct worker at a time and freshly verifies/integrates each
result before the next dispatch. No ticket is pulled from a later wave and no
parallel mutation is permitted without separately prepared real isolation.

### - [x] T1: Recover transient Core capability probes

| Field | Content |
| --- | --- |
| What to build | Make general capability, session-stream, and session-ring probes cache only successful results so a transient failed attempt can recover on the next call without restart. |
| Spec references | SCN-1, INV-1, ARCH-1, ARCH-2 |
| Dependencies | None |
| Delegation eligibility | Bounded local runtime wrapper with deterministic fake-port tests, no credentials or external mutation, and independently inspectable failure/retry behavior. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `HerdrEventSourceSession` remains the single-flight cache owner; preserve per-call fail-closed/rejection behavior and clear only the failed attempt's cache entry. |
| Mutation ownership | src/runtime/herdr-events/source-session.ts, tests/herdr-events-reader.test.ts |
| Exclusions | Core protocol, SQLite, submission replay, adapters, other observer behavior, docs and plan checkboxes. |
| Isolation | Serial shared workspace at recorded base; main verifies no intervening overlap before accepting the diff. |
| Concurrency conflicts | None |
| Verification seam | First probe fails, second succeeds, and concurrent callers share one attempt through `tests/herdr-events-reader.test.ts`; run focused tests and typecheck. |
| Host capacity | One direct-child slot; main rechecks live capacity before dispatch and may inherit-main if optional routing is unavailable. |
| Direct-child boundary | delegation_allowed = false; main supplies the common brief and implementation role, and the worker may not spawn, stage, commit, alter artifacts, or claim completion. |
| Acceptance criteria and verification | Failed general capabilities return conservative support for that call and retry later; failed stream/ring probes reject that call and retry later; successful results remain cached; focused tests pass with no submission or persistence effects. |
| Verification commands | `npx vitest run tests/herdr-events-reader.test.ts`; `npm run typecheck`; `git diff --check` |
| Verification results | Main observed Red as 2 intended failures with 47 existing passes, then integrated Green as 49/49 tests passed; typecheck and diff check exited 0. |
| Commits | `99223003` |
| Blocked by | None |

### - [x] T2: Back off failed Worker cursor reads

| Field | Content |
| --- | --- |
| What to build | Replace fixed-interval Worker exact-turn polling with one self-scheduling timer, capped exponential failure backoff, bounded tier-change warnings, and success reset while preserving final drain and terminal behavior. |
| Spec references | SCN-2, INV-2, ARCH-1, ARCH-2 |
| Dependencies | None |
| Delegation eligibility | Bounded coordinator behavior with fake timers, injected cursor/store/logger seams, no credentials or external mutation. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `WorkerTurnObserver` owns scheduling and failure tiers; existing exact-turn cursor remains the read/ack interface and existing store state remains terminal authority. |
| Mutation ownership | src/coordinator/worker-turn-observer.ts, tests/worker-turn-observer.test.ts |
| Exclusions | New durable recovery state, forced terminalization, cursor protocol changes, Worker card rendering, docs and plan checkboxes. |
| Isolation | Serial shared workspace at recorded base; main verifies no intervening overlap before accepting the diff. |
| Concurrency conflicts | None |
| Verification seam | Fake-timer tests measure read call timestamps, maximum one active read, warning count, success reset, stop/detach, and final drain; run focused tests and typecheck. |
| Host capacity | One direct-child slot; main rechecks live capacity before dispatch and may inherit-main if optional routing is unavailable. |
| Direct-child boundary | delegation_allowed = false; main supplies the common brief and implementation role, and the worker may not spawn, stage, commit, alter artifacts, or claim completion. |
| Acceptance criteria and verification | Consecutive failures increase delay to a finite cap without queued interval work; warnings occur only when the tier changes; a successful read restores the base interval; stop clears future polling and retains final drain semantics. |
| Verification commands | `npx vitest run tests/worker-turn-observer.test.ts`; `npm run typecheck`; `git diff --check` |
| Verification results | Main observed the original Red as one intended timing failure with 12 existing passes and Green as 14/14 tests; delivery review then found the valid 10-second base did not back off, whose added Red failed 1/15 before repair and passed 15/15 after repair. Typecheck, architecture check and diff check exited 0. |
| Commits | `2ea8bbaf`, `02f0d4d0` |
| Blocked by | None |

### - [x] T3: Deepen Ring membership and bulk operations

| Field | Content |
| --- | --- |
| What to build | Use the Ring's existing reply map for membership, replace repeated splice/unshift history invalidation with one stable partition, add one-pass bulk removal with exact released bytes, and remove unused/narrow internal surface. |
| Spec references | SCN-3, INV-3, ARCH-1, ARCH-2 |
| Dependencies | None |
| Delegation eligibility | Bounded in-memory refactor with deterministic public Ring and engine tests, no credentials, persistence, or external mutation. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `PreparedDeliveryRing` remains the deep module for identity/order/bytes/token/grant state; engines consume its small membership and bulk-removal interface without duplicating queue knowledge. |
| Mutation ownership | src/events/prepared-delivery-ring.ts, src/events/ring-delivery-engine.ts, src/events/shadow-delivery-engine.ts, tests/prepared-delivery-ring.test.ts, tests/ring-delivery-hot-path.test.ts, tests/shadow-delivery-engine.test.ts |
| Exclusions | Delivery scheduler replacement, Ring limits, SQLite checkpoints, Gateway behavior, semantic delivery policy, docs and plan checkboxes. |
| Isolation | Serial shared workspace at recorded base; main verifies no intervening overlap before accepting the diff. |
| Concurrency conflicts | None |
| Verification seam | Public Ring tests prove duplicate/stale identity, stable invalidation order, active-head protection, exact bytes/revisions/tokens and bulk clear; both engine suites prove unchanged duplicate/process-limit behavior. |
| Host capacity | One direct-child slot; main rechecks live capacity before dispatch and may inherit-main if optional routing is unavailable. |
| Direct-child boundary | delegation_allowed = false; main supplies the common brief and implementation role, and the worker may not spawn, stage, commit, alter artifacts, or claim completion. |
| Acceptance criteria and verification | Membership lookup does not copy the queue; invalidation is one stable pass; bulk removal clears queue/map/bytes once and reports exact released bytes; all FIFO, grant, ready-token, process-byte and duplicate outcomes remain unchanged in focused and affected tests. |
| Verification commands | `npx vitest run tests/prepared-delivery-ring.test.ts tests/ring-delivery-hot-path.test.ts tests/ring-delivery-recovery.test.ts tests/shadow-delivery-engine.test.ts`; `npm run typecheck`; `git diff --check` |
| Verification results | Main observed 4 intended Red failures with 45 existing passes, then integrated Green as 74/74 tests passed across 4 affected suites; typecheck and diff check exited 0. |
| Commits | `e213478f` |
| Blocked by | None |

## Final delivery checks

Main performs independent Standards and Spec reviews, repairs accepted findings
through TDD, checks the completed artifacts in delivery mode, and freshly runs
focused/affected tests, `npm run typecheck`, `npm run build`,
`npm run architecture:check`, documentation checks as applicable, and the full
Vitest suite. After atomic ticket commits and planning-evidence updates, main
installs an immutable release, force restarts through the supported lifecycle,
and verifies expected build identity, readiness, Core ingestion, Delivery Ring
backlog, failure logs, and recent latency without replaying uncertain effects.

Gate 3 recommendation: execute W1 serially through default direct workers in
the recorded authoritative worktree. This was auto-selected under explicit
autonomous authority because it is the only mode that preserves default
delegation without pretending shared-worktree writes are isolated.
