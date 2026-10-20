# Runtime Work Lifecycle Hardening Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification:
`docs/spec-coder/specs/2026-10-16-runtime-work-lifecycle-hardening.md`.
Workspace:
`<repo-root>/.worktree/runtime-work-lifecycle-hardening`
on `spec-coder-runtime-work-lifecycle-hardening`, exact base `7bbb4ed2`.

Gate 1 approved design B: introduce shared lifecycle primitives, then apply
them only to the four confirmed stability gaps. The user approved Gate 2 and
Gate 3 interactively on 2026-10-16; in-scope TDD implementation is authorized.
Tickets update this plan durably and receive independent Conventional Commits.
No ticket may install, restart, deploy, push, or include root-checkout user files.

Fresh baseline records: focused `4dc706c4` (6 files, 105 tests), typecheck
`4f4e1331`, build `c2a07c20`, architecture `206d9956` (546 files), and full
suite `03ca7e2e` (307 files, 5,027 tests), all captured green.

## Wave W1: `T1`

### - [x] T1: Add dependency-free lifecycle primitives

| Field | Content |
| --- | --- |
| What to build | Add `WorkAdmissionGate` and `observeDetached` in a runtime leaf module. Reuse `ActiveWorkTracker` for stable draining or preserve its exact semantics without duplicating workflow state. |
| Spec references | SCN-1, SCN-4, INV-1, INV-2, INV-4, ARCH-1 |
| Dependencies | None |
| Delegation mode | delegate |
| Mutation ownership | `src/runtime/work-lifecycle.ts`, `tests/work-lifecycle.test.ts`, `tests/architecture-boundaries.test.ts` |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Closed admission never invokes work; admitted work drains across resolve/reject; close is monotonic/idempotent; sync throws become rejected Promises; detached rejection is observed once; observer failure cannot become unhandled; runtime dependency direction stays valid. |
| Verification commands | `npx vitest run tests/work-lifecycle.test.ts tests/architecture-boundaries.test.ts --reporter=dot --maxWorkers=2 --testTimeout=30000`; `npm run typecheck`; `git diff --check` |
| Verification results | Main observed Red: focused Vitest failed because `work-lifecycle.js` did not exist. Main observed Green: work-lifecycle plus architecture-boundary suites passed 2 files and 85 tests; `npm run typecheck` and staged diff checks passed; import review confirmed the helper depends only on `ActiveWorkTracker`. |
| Commits | `e5fc912b109c340e0f14cd62af784d5eef7523a0` |

## Wave W2: `T2`, `T3`, `T4`

These tickets have disjoint mutation ownership after T1 and may be executed by
separate workers. Workers must not edit the shared helper contract or each
other's files; main integrates and independently reviews every diff.

### - [x] T2: Fence and drain Lark SDK ingress

| Field | Content |
| --- | --- |
| What to build | Route accepted Lark message and card-action callbacks through one adapter-owned admission gate; implement close-SDK-drain-clear stop order while preserving existing normalization, card responses, metrics, and logging. |
| Spec references | SCN-1, INV-1, INV-2, ARCH-1 |
| Dependencies | T1 |
| Delegation mode | delegate |
| Mutation ownership | `src/adapters/lark-adapter.ts`, `tests/lark-adapter.test.ts` |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Stop waits for callbacks admitted before close; callbacks delivered after close do not invoke message/card ingress; card responses and errors remain SDK-compatible; cache clear happens after drain; existing adapter tests remain green. |
| Verification commands | `npx vitest run tests/lark-adapter.test.ts --reporter=dot --maxWorkers=2 --testTimeout=30000`; `npm run typecheck`; `git diff --check` |
| Verification results | Main observed Red: `stop()` resolved while a previously admitted SDK callback was still pending. Main observed Green in the isolated branch: 46 adapter tests, `npm run typecheck`, and staged diff checks passed. After authoritative integration, the combined T2/T4 focused run passed 3 files and 86 tests; source review confirmed close-SDK-drain-clear ordering and post-close message/card fences. |
| Commits | `4c8954474298c9a7feebeba4ac3eac9fbd136e61` |

### - [x] T3: Fence control effects after asynchronous revalidation

| Field | Content |
| --- | --- |
| What to build | Add a post-revalidation stop fence before rejection/claim/effect in Turn Control and Orchestrator Clear. Preserve all existing behavior once claim/effect has started. |
| Spec references | SCN-2, SCN-3, INV-3, ARCH-1 |
| Dependencies | T1 |
| Delegation mode | delegate |
| Mutation ownership | `src/coordinator/turn-control-dispatcher.ts`, `src/coordinator/orchestrator-clear-workflow.ts`, `tests/turn-control-dispatcher.test.ts`, `tests/orchestrator-clear-workflow.test.ts` |
| Concurrency conflicts | None |
| Acceptance criteria and verification | When stop wins during revalidation, the operation remains `accepted`, no rejection/claim occurs, no Herdr effect starts, and stop drains cleanly; pre-stop and already-claimed paths retain current receipt/uncertain semantics. |
| Verification commands | `npx vitest run tests/turn-control-dispatcher.test.ts tests/orchestrator-clear-workflow.test.ts --reporter=dot --maxWorkers=2 --testTimeout=30000`; `npm run typecheck`; `git diff --check` |
| Verification results | Main observed Red: stop-during-revalidation delivered Turn Control and succeeded Clear instead of preserving `accepted`. Main observed Green in the isolated and authoritative integrated states: 2 files and 22 tests passed; `npm run typecheck` and staged diff checks passed; source review confirmed both fences run before rejection and claim. |
| Commits | `97e7257af9cc037a8dea6a6fbadf034954fb75bc` |

### - [x] T4: Own detached Ring refill and Command Intent scan failures

| Field | Content |
| --- | --- |
| What to build | Observe exact-scope work-subscription refill rejection without inventing delivery state; observe periodic Command Intent scan rejection with a bounded error log and leave durable accepted work retryable. |
| Spec references | SCN-4, INV-1, INV-4, ARCH-1 |
| Dependencies | T1 |
| Delegation mode | delegate |
| Mutation ownership | `src/events/ring-delivery-engine.ts`, `src/coordinator/command-intent-dispatcher.ts`, `tests/ring-delivery-recovery.test.ts`, `tests/command-intent-dispatcher.test.ts` |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Injected exact-scope refill and interval-scan failures produce no unhandled rejection; Command Intent logs one periodic failure and a later scan retries; Ring durable refill discovery and existing global refill ownership are unchanged. |
| Verification commands | `npx vitest run tests/ring-delivery-recovery.test.ts tests/command-intent-dispatcher.test.ts --reporter=dot --maxWorkers=2 --testTimeout=30000`; `npm run typecheck`; `git diff --check` |
| Verification results | Main observed Red: injected exact-scope Ring refill and periodic Command Intent scan failures surfaced as unhandled rejections. Main observed Green in the isolated branch: 2 files and 40 tests, `npm run typecheck`, and staged diff checks passed. After authoritative integration, the combined T2/T4 focused run passed 3 files and 86 tests; source review confirmed Ring remains state-neutral and the periodic scan records a bounded deferred error before a later durable retry. |
| Commits | `5d2e3d2606e594975d69f3afc13a48c45e69e768` |

## Final delivery checks

After all tickets are committed, main performs independent Standards and Spec
review, repairs findings through TDD, then runs:

```text
npx vitest run tests/work-lifecycle.test.ts tests/active-work-tracker.test.ts tests/lark-adapter.test.ts tests/ring-delivery-recovery.test.ts tests/turn-control-dispatcher.test.ts tests/orchestrator-clear-workflow.test.ts tests/command-intent-dispatcher.test.ts --reporter=dot --maxWorkers=2 --testTimeout=30000
npm run typecheck
npm run build
npm run architecture:check
npx vitest run --reporter=dot --maxWorkers=2 --testTimeout=30000
git diff --check
```

Run the spec-coder delivery artifact checker against this spec and plan. Keep
the result in the isolated branch; do not install, restart, deploy, push, or
modify the original checkout.
