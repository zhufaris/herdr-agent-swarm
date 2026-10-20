# Core Ingestion and Shutdown Stability Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification: `docs/spec-coder/specs/2026-10-13-ingestion-stability.md`.
Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`, existing
isolated clean worktree on `main`, base
`61f204d79a9a0b311231d9a1e18037539eca35a6`. The original checkout is excluded.
Baseline `5f099dd03ee74cc1a529d4b8034cbcdd` passed 136 affected tests. Design and
Gates 1-3 were auto-selected under the active goal's no-wait/default authority.

## Wave W1: `T1`

### - [x] T1: Elide exact caught-up Core checkpoint writes

| Field | Content |
| --- | --- |
| What to build | Reuse the cached full checkpoint statement and return accepted before a transaction only for an exact empty caught-up batch. Give the mutating path a specific ingestion transaction label for live verification. |
| Spec references | SCN-1, INV-1, ARCH-1 |
| Dependencies | None |
| Delegation mode | main-local |
| Mutation ownership | src/store/sqlite/core-event-inbox-store.ts, tests/core-event-inbox-store.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Exact no-op batch adds zero transactions and preserves updated_at; changed latest cursor/epoch and stale/missing identities retain current transactional behavior. |
| Verification commands | `npx vitest run tests/core-event-inbox-store.test.ts`; `npm run typecheck`; `npm run build`; `git diff --check` |
| Verification results | Red proved the exact caught-up batch opened a third write transaction. Fresh Green passed 64/64 inbox tests; exact metadata preserved transaction count and updated_at, while latest-cursor and epoch changes remained transactional. Typecheck, build, and diff check exited 0. |
| Commits | `d8e3fae0` |

## Wave W2: `T2`

### - [x] T2: Bound event-driven Core owner ingestion

| Field | Content |
| --- | --- |
| What to build | Replace notification-owner Promise.all fan-out with the existing concurrency-four mapping while preserving deduplication, tails, and unknown-source reconciliation. |
| Spec references | SCN-2, INV-2, ARCH-1 |
| Dependencies | T1 |
| Delegation mode | main-local |
| Mutation ownership | src/coordinator/core-session-ingestion-supervisor.ts, tests/core-session-ingestion.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | More than four distinct known owners never exceed four active ingestions; all complete; duplicate and unknown-source tests remain green. |
| Verification commands | `npx vitest run tests/core-session-ingestion.test.ts`; `npm run typecheck`; `npm run build`; `git diff --check` |
| Verification results | Red showed all eight notified owners entering ingestion concurrently. Fresh Green passed 49/49 ingestion tests; four owners block concurrently, the remaining four start after capacity releases, and all existing dedup/unknown-source behavior remains green. Typecheck, build, and diff check exited 0. |
| Commits | `6960c321` |

## Wave W3: `T3`

### - [x] T3: Make Ring shutdown cleanup-first

| Field | Content |
| --- | --- |
| What to build | Settle active refill/delivery promises during stop, prevent refill failure from overwriting stopping, clear all in-memory state, publish stopped, then report captured failures. |
| Spec references | SCN-3, INV-3, ARCH-1 |
| Dependencies | T2 |
| Delegation mode | main-local |
| Mutation ownership | src/events/ring-delivery-engine.ts, tests/ring-delivery-recovery.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Rejected active refill cannot skip active settlement or cleanup; snapshot reaches stopped with empty caches before stop rejects; normal stop remains successful. |
| Verification commands | `npx vitest run tests/ring-delivery-recovery.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Red showed an active refill rejection overwriting stopping with degraded before a blocked delivery settled. Fresh Green passed 26/26 Ring recovery tests; stop remains stopping, settles delivery, clears every cache, publishes stopped, then reports the injected error. Typecheck, build, 535-file architecture check, and diff check exited 0. |
| Commits | `0cb2bc13` |

## Wave W4: `T4`

### - [x] T4: Close production-shape concurrency and shutdown races

| Field | Content |
| --- | --- |
| What to build | Require nextCursor=latestCursor for the no-write fast path; enforce one supervisor-wide four-owner ingestion permit across overlapping notification calls; stop startup recovery at the shutdown fence; prevent and finally clear scheduler repopulation before stopped. |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, ARCH-1 |
| Dependencies | T3 |
| Delegation mode | main-local |
| Mutation ownership | src/store/sqlite/core-event-inbox-store.ts, src/coordinator/core-session-ingestion-supervisor.ts, src/events/ring-delivery-engine.ts, tests/core-event-inbox-store.test.ts, tests/core-session-ingestion.test.ts, tests/ring-delivery-recovery.test.ts, docs/spec-coder/plans/2026-10-13-ingestion-stability.md |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Repeated lagging empty batch remains transactional; eight independent notification calls never exceed four active ingestions; stop waits a yielded cold-start recovery and starts no later page/refill; a queued successor cannot leave scheduler state after stopped. |
| Verification commands | `npx vitest run tests/core-event-inbox-store.test.ts tests/core-session-ingestion.test.ts tests/ring-delivery-recovery.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Red reproduced four review findings: lagging no-progress bypass, eight overlapping single-source notifications, scheduler repopulation after stop, and a second cold-start recovery page after stop. Fresh Green passed 140/140 affected tests. Supervisor-wide permits, recoveryPromise settlement, refill/makeReady stop fences, final scheduler clear, and strict caught-up eligibility are covered. Typecheck, build, 535-file architecture check, and diff check exited 0. |
| Commits | `e7d1d347` |

## Final delivery checks

Main performs independent Standards/Spec review, repairs findings through TDD,
runs fresh full Vitest, typecheck, build, architecture/docs checks and delivery
artifact validation. After immutable install and restart, compare post-deploy
Core transaction counts/durations and `/health`/`status` latency against the
recorded build `61f204d7` baseline; confirm ready, zero required ingestion
failures, bounded Ring state, and no restart error logs.
