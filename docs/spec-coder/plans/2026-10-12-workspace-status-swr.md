# Workspace Cache and Status SWR Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification: `docs/spec-coder/specs/2026-10-12-workspace-status-swr.md`.
Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`, existing
isolated clean worktree on `main`, base
`0597f3cadf08358b434753cb1be660c13e863e2a`. The original checkout is excluded.
Baseline `0d967e768850487fa2902c4a8a0365d4` passed 92 affected tests. Design and
Gates 1-3 were auto-selected under the active goal's autonomous/default
authority.

## Wave W1: `T1`

### - [x] T1: Fence direct workspace publication against older global refresh

| Field | Content |
| --- | --- |
| What to build | Advance aggregate generation and invalidate aggregate cache whenever a direct workspace refresh publishes successfully. |
| Spec references | SCN-1, INV-1, ARCH-1 |
| Dependencies | None |
| Delegation mode | Default direct worker |
| Mutation ownership | src/runtime/workspace-snapshot-cache.ts, tests/workspace-snapshot-cache.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Deterministic direct-before-global completion preserves the direct workspace cache; stale global result cannot publish/coalesce; existing invalidation/coalescing/copy tests pass. Run workspace cache tests, typecheck, build, and diff check. |
| Verification commands | `npx vitest run tests/workspace-snapshot-cache.test.ts`; `npm run typecheck`; `npm run build`; `git diff --check` |
| Verification results | Main observed Red when the older global result overwrote direct `v2` with `v1`. Fresh integrated Green passed 26/26 cache tests, typecheck, build, and diff check. |
| Commits | `e8f3c5a1` |

## Wave W2: `T2`

### - [x] T2: Serve stale readiness to status while refreshing once

| Field | Content |
| --- | --- |
| What to build | Add one stale-while-refresh SnapshotCache read used only by status; keep ready and cold status strict. |
| Spec references | SCN-2, SCN-3, INV-2, INV-3, ARCH-1 |
| Dependencies | None |
| Delegation mode | Default direct worker |
| Mutation ownership | src/health/health-snapshot-collector.ts, tests/health-snapshot-collector.test.ts, tests/health-server.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Warm expired status resolves with stale readiness before blocked refresh; concurrent status coalesces; successful refresh replaces the value; readiness and cold status await fresh observation; failures preserve stale status but fail strict readiness. Run collector/server tests, typecheck, build, architecture check, and diff check. |
| Verification commands | `npx vitest run tests/health-snapshot-collector.test.ts tests/health-server.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed Red because warm expired status remained blocked. Fresh integrated Green passed 68/68 collector/server tests; stale status resolved before the shared refresh, strict readiness awaited and observed failure, and later status saw the refreshed value. Typecheck, build, 535-file architecture check, and diff check exited 0. |
| Commits | `d5f75a1e` |

## Wave W3: `T3`

### - [x] T3: Bound failed SWR retries and expose stale failure state

| Field | Content |
| --- | --- |
| What to build | Apply cache-local bounded exponential backoff after a background workspace-readiness refresh fails; expose refresh state in status; keep strict readiness able to probe immediately. Replace wall-clock race assertions with deterministic promise gates. |
| Spec references | SCN-2, SCN-3, INV-2, INV-3, ARCH-1 |
| Dependencies | T2 |
| Delegation mode | main-local |
| Mutation ownership | src/health/health-snapshot-collector.ts, tests/health-snapshot-collector.test.ts, tests/health-server.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Repeated status reads during backoff do not probe Herdr; one refresh starts after the deadline and concurrent reads coalesce; status exposes stale/failure/retry state and degrades after a refresh failure; strict readiness bypasses the status backoff. No production timer or worker is added. |
| Verification commands | `npx vitest run tests/health-snapshot-collector.test.ts tests/health-server.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Red reproduced repeated refresh eligibility and missing failure diagnostics. Fresh Green passed 70/70 collector/server tests. Deterministic clock/gate coverage proves backoff suppression, deadline retry coalescing, strict readiness bypass, and stale failure visibility. Typecheck, build, 535-file architecture check, and diff check exited 0. |
| Commits | `1f70e3ab` |

## Wave W4: `T4`

### - [x] T4: Own workspace refresh shutdown and close review coverage gaps

| Field | Content |
| --- | --- |
| What to build | Stop admitting background workspace refreshes during health shutdown and settle an active refresh before stop completes. Decouple workspace and SQLite retry options, retain bounded failed-workspace IDs, and close strict-wait, exponential-cap, and direct/global no-coalescing test gaps. |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, ARCH-1 |
| Dependencies | T3 |
| Delegation mode | main-local |
| Mutation ownership | src/health/health-snapshot-collector.ts, tests/health-snapshot-collector.test.ts, tests/workspace-snapshot-cache.test.ts, docs/spec-coder/specs/2026-10-12-workspace-status-swr.md, docs/spec-coder/plans/2026-10-12-workspace-status-swr.md |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Health stop remains pending until an active SWR refresh settles and starts no later refresh; status identifies bounded failed workspace IDs; readiness retry tuning is independent from SQLite diagnostics; exponential backoff reaches its cap; strict readiness is proven pending; a post-direct global read cannot coalesce onto an older global refresh. |
| Verification commands | `npx vitest run tests/health-snapshot-collector.test.ts tests/health-server.test.ts tests/workspace-snapshot-cache.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Red showed stop returning before a blocked workspace refresh settled, absent failed-workspace IDs, coupled retry defaults, and the missing coverage seams. Fresh Green passed 98/98 collector/server/workspace-cache tests. Typecheck, build, 535-file architecture check, and diff check exited 0. |
| Commits | `3587aaa1` |

## Final delivery checks

Main runs independent Standards/Spec reviews, TDD repairs, fresh full Vitest,
typecheck, build, architecture/docs checks, and artifact validation. After
immutable install and restart, sample `/status` across TTL boundaries, confirm
ready remains strict, workspace cache failures stay zero, and Core/Delivery
health and latency remain stable.
