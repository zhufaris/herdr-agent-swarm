# Scope-aware Delivery Wake and Bounded Maintenance Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

- Specification: `docs/spec-coder/specs/2026-10-12-scope-wake-bounded-maintenance.md`
- Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`
- Mode: in-place inside the existing isolated deployment worktree; the original user checkout remains untouched.
- Branch: `main`
- Starting revision: `1a41d3e4891e5093c6a2b56b73b6e3bb89dd9f83`
- Initial changes: only the approved specification and this plan.
- Baseline: 139 focused Ring/store tests and `npm run typecheck` passed on the clean starting revision.
- Authority: Gate 2 approved by the user with choice `A`; implementation still requires Gate 3 authorization.

## Wave W1: `T1`

### - [x] T1: Stop exact delivery handoff from triggering global refill

| Field | Content |
| --- | --- |
| What to build | Introduce provider-neutral outbound wake hints so exact prepared work is enqueued directly without a global refill; scope-only hints perform bounded exact-scope refill, while unknown recovery wakes retain global discovery. |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-2, ARCH-1 |
| Dependencies | None |
| Delegation eligibility | Grounded existing notifier/Ring seams, bounded reversible behavior, and independently inspectable call-count tests make this eligible for a direct worker. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Outbound notification owns hint coalescing; `OutboundIntentWriter` emits the most specific post-commit signal; `RingDeliveryEngine` maps exact scope hints to bounded refill and reserves global refill for unknown recovery. SQLite claim/settlement remains unchanged. |
| Mutation ownership | `src/events/outbound-work-notifier.ts`, `src/events/outbound-intent-writer.ts`, `src/events/ring-delivery-engine.ts`, `src/composition/create-outbound-runtime.ts`, `tests/outbound-work-notifier.test.ts`, `tests/outbound-intent-writer.test.ts`, `tests/ring-delivery-recovery.test.ts`, `tests/architecture-boundaries.test.ts` |
| Exclusions | No SQLite schema/store mutation, no Gateway protocol change, no ACK/checkpoint change, no removal of startup/retry/safety global recovery. |
| Isolation | Serial mutation in the prepared worktree; no parallel worker shares this wave. |
| Concurrency conflicts | T2 |
| Verification seam | Red-Green tests count exact-scope versus null-scope loads for prepared work, scope hints, unknown wakes, duplicate wakes, startup, retry, and safety scans; affected notifier/writer/Ring suites and architecture checks follow. |
| Host capacity | One direct worker slot; main rechecks capacity and integrates serially. |
| Direct-child boundary | `delegation_allowed = false`; the child must not spawn, stage, commit, deploy, or alter the plan. |
| Acceptance criteria and verification | Exact prepared handoff causes zero global refills; a scope-only hint refills only that scope; unknown/lost-hint recovery still performs bounded global discovery; duplicate hints remain idempotent; existing no-replay and ordering tests pass. Run `npx vitest run tests/outbound-work-notifier.test.ts tests/outbound-intent-writer.test.ts tests/ring-delivery-recovery.test.ts tests/ring-delivery-hot-path.test.ts tests/architecture-boundaries.test.ts`, `npm run typecheck`, and `npm run build`. |
| Verification commands | `npx vitest run tests/outbound-work-notifier.test.ts tests/outbound-intent-writer.test.ts tests/ring-delivery-recovery.test.ts tests/ring-delivery-hot-path.test.ts tests/architecture-boundaries.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check` |
| Verification results | Main observed exit 0 after spec review repair: 6 focused files / 239 tests passed; typecheck, build, and architecture check passed. All connected prepared-delivery producers now coalesce redundant generic wakes behind an exact scope hint. |
| Commits | `c81903ac`, `671e030f` |
| Blocked by | None |

## Wave W2: `T2`

### - [x] T2: Split global Ring maintenance into bounded writer transactions

| Field | Content |
| --- | --- |
| What to build | Separate expired-claim recovery, rejected-review cleanup, and historical Primary Main coalescing into independently bounded, separately labeled SQLite transactions coordinated once per global maintenance pass. |
| Spec references | SCN-3, SCN-4, INV-1, INV-3, INV-4, ARCH-2 |
| Dependencies | None |
| Delegation eligibility | The store boundary and failure-injection tests are explicit and bounded, so this is eligible for a direct worker after T1 is integrated. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `PreparedDeliveryStore` owns the three maintenance transitions and their CAS revalidation; `RingDeliveryEngine` coordinates bounded slices and yields without changing effect authority or retry semantics. |
| Mutation ownership | `src/domain/ports/prepared-delivery.ts`, `src/store/sqlite/prepared-delivery-store.ts`, `src/events/ring-delivery-engine.ts`, `tests/prepared-delivery-store.test.ts`, `tests/ring-delivery-recovery.test.ts`, `tests/ring-delivery-hot-path.test.ts` |
| Exclusions | No new durable table, no migration, no direct production DB mutation, no replay of uncertain claims, no change to delivery-order or conflict-isolation semantics. |
| Isolation | Serial mutation after W1; it overlaps Ring orchestration and therefore cannot run concurrently with T1. |
| Concurrency conflicts | T1 |
| Verification seam | Failure-injection tests prove each class commits independently, respects its batch limit, revalidates candidates under the writer fence, and remains rediscoverable after a later class fails. Transaction diagnostics must expose separate operation labels. |
| Host capacity | One direct worker slot; main rechecks capacity and integrates serially. |
| Direct-child boundary | `delegation_allowed = false`; the child must not spawn, stage, commit, deploy, or alter the plan. |
| Acceptance criteria and verification | No global maintenance pass holds one writer transaction across all three classes; failure in class two does not roll back class one; class three remains eligible on the next pass; uncertain claims remain quarantined and never replayed. Run `npx vitest run tests/prepared-delivery-store.test.ts tests/ring-delivery-recovery.test.ts tests/ring-delivery-hot-path.test.ts`, `npm run typecheck`, and `npm run build`. |
| Verification commands | `npx vitest run tests/prepared-delivery-store.test.ts tests/ring-delivery-recovery.test.ts tests/ring-delivery-hot-path.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check` |
| Verification results | Main observed exit 0 after delivery review repairs: 3 files / 148 tests passed; the six previously failing integration files passed 111/111; typecheck, build, and architecture check passed. Failure injection proved independent commit and rediscovery; empty slices do not delay startup; runtime failures preserve hint readiness; broad candidate discovery runs outside the writer with bounded ID revalidation inside. |
| Commits | `de8bd8b8`, `0f38d8a1`, `3e27abfd` |
| Blocked by | None |

## Final delivery checks

After both tickets are committed, run independent Standards and Spec reviews,
the complete Vitest suite, focused Ring/store suites, `npm run typecheck`,
`npm run build`, `npm run architecture:check`, `npm run docs:audit`, and the
delivery artifact checker. Installation, restart, live latency comparison, and
production log verification remain separate operator actions after verified
delivery.
