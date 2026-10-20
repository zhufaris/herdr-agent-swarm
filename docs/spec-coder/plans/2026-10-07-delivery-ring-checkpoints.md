# Delivery Ring Checkpoints Plan

Specification:
[Delivery Ring Checkpoints](../specs/2026-10-07-delivery-ring-checkpoints.md)

## Workspace, ownership, and baseline

- Workspace: `/workspace/herdr-agent-swarm`.
- Mode: in-place. Tracked files were clean at Ring planning time; preserved
  unrelated untracked paths are `.tmp-build/`,
  `docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- Branch and Ring implementation starting revision: `main` at `a80bcce2`, 57
  commits ahead of `origin/main`. The preceding five Pane-only Choice commits
  are accepted separate work and are not part of Ring ticket ownership.
- Dependencies are installed from the repository lockfile.
- Fresh baseline: `npx vitest run --maxWorkers=1` passed 286 files / 4,120
  tests; `npm run typecheck`, `npm run architecture:check`, `npm run build`, and
  `npm run public:audit` passed.
- `npm run docs:audit` remains blocked only by stale links in the pre-existing
  untracked research document named above.
- Revised Gate 1 and Gate 2 approved the R3-lite design; revised Gate 3
  authorized the remaining R3-lite ticket.
- No production installation, restart, live database mutation, history cleanup,
  push or external publication is authorized by this plan.

## Tickets

- [x] **R1: Add typed Delivery checkpoint storage and lazy scope bootstrap**

  | Field | Plan |
  | --- | --- |
  | What to build | Add the shared discriminated Checkpoint vocabulary, an empty idempotently migrated `delivery_ring_checkpoints` table, typed Delivery checkpoint hydration/validation, and one transactional lazy-bootstrap operation that positions a scope immediately before its earliest authoritative nonterminal row or at its current maximum when no such row exists. Keep the current Ring refill path unchanged. |
  | Spec references | SCN-1 through SCN-3 and SCN-9; INV-1, INV-2, INV-5, INV-6 and INV-8; Domain Model, Architecture, Compatibility & Migration. |
  | Dependencies | None. |
  | Delegation eligibility | Eligible: bounded durable foundation with explicit SQLite and domain test seams, no external effects or credentials, reversible before cutover. |
  | Delegation mode | Default serialized direct worker. |
  | Ownership and implementation path | Delivery and Operations owns Delivery-order positions; Core Projection retains its existing cursor persistence. The domain module owns typed construction; Prepared Delivery's consumer-owned persistence seam owns bootstrap because it already owns the authoritative nonterminal predicate and transaction. SQLite validates scope shape/key and nonnegative orders. |
  | Mutation ownership | New/extended checkpoint domain types; Prepared Delivery port/store checkpoint foundation; SQLite schema/migration modules; focused domain, migration, reopen, bootstrap and query-plan tests; this plan checkbox only after main acceptance. |
  | Exclusions | No Core table rewrite, no refill cutover, no terminal transition wiring, no Gateway/card behavior, no history backfill, no production mutation. |
  | Isolation | Serialized shared-workspace mutation from recorded base; no parallel mutation. |
  | Concurrency conflicts | Conflicts with R2/R3 through the new checkpoint store seam and SQLite tests; cannot share a wave. |
  | Verification seam | Red bootstrap/migration tests at the Prepared Delivery and real SQLite seams; rollback and competing-handle evidence; query-plan evidence; existing refill behavior preservation; focused tests, typecheck, architecture check and build. |
  | Host capacity | One direct-child slot; recheck live capacity at dispatch. |
  | Direct-child boundary | `delegation_allowed = false`; child cannot spawn/delegate, stage, commit, deploy, restart, or touch unrelated files. |
  | Acceptance criteria and verification | Empty, terminal-only, earliest pending, unresolved dead letter, completed replacement and interleaved scope-order fixtures initialize correctly; migration/reopen is idempotent and rewrites neither Core checkpoints nor outbox rows; malformed scope/position fails closed; competing handles converge on one valid row; injected failure persists nothing. |
  | Blocked by | None. |

  Suggested atomic commit: `feat(delivery): add durable ring checkpoints`

- [x] **R2: Advance checkpoints with hot delivery terminal transitions**

  | Field | Plan |
  | --- | --- |
  | What to build | Extend prepared ACK and safe pre-claim supersession/dismissal transitions so the exact scope checkpoint initializes if needed and advances through the largest newly terminal prefix in the same transaction. Retryable, rejected-but-unresolved and uncertain failure paths leave it unchanged. This is an optional fast path; correctness belongs to R3-lite reconciliation. |
  | Spec references | SCN-4 through SCN-6; INV-3 through INV-5, INV-7 and INV-9; Behavior & Failure Modes. |
  | Dependencies | R1 supplies typed persistence and bootstrap/advance capability. |
  | Delegation eligibility | Eligible after R1: bounded transactional behavior with deterministic Gateway-free store/engine seams and injected rollback tests. |
  | Delegation mode | Default serialized direct worker. |
  | Ownership and implementation path | Prepared Delivery aggregate owns ACK/supersession terminality and checkpoint consistency. Reuse one authoritative nonterminal predicate; the engine consumes returned scope wake data and never calculates a position. ACK still requires provider and Gateway checkpoint evidence. |
  | Mutation ownership | Prepared Delivery hot-path claim/ACK/failure/supersession store operations; Ring hot-path tests; focused SQLite concurrency/rollback tests. |
  | Exclusions | Recovery/maintenance terminal-writer callbacks, refill reconciliation, status/docs, Core and Feishu protocol changes. |
  | Isolation | Serialized shared-workspace mutation after R1 commit. |
  | Concurrency conflicts | Conflicts with R3 through shared checkpoint advancement helpers and store tests. |
  | Verification seam | Red ACK/supersession transaction tests, competing attempt fences, injected rollback, unchanged retry/uncertain positions, engine Gateway-call counts, affected checks and architecture evidence. |
  | Host capacity | One direct-child slot; recheck after R1. |
  | Direct-child boundary | `delegation_allowed = false`; child cannot spawn/delegate, stage, commit, deploy, restart, or touch unrelated files. |
  | Acceptance criteria and verification | ACK + provider checkpoints + outbox state + scope checkpoint commit atomically; stale ACK cannot advance; safe supersession records dismissal before advance; retry/uncertain/unresolved dead letter does not advance; another scope progresses; restart rehydrates the same monotonic position. |
  | Blocked by | R1. |

  Suggested atomic commit: `feat(delivery): checkpoint terminal ring effects`

- [x] **R3: Reconcile rebasable checkpoints at the refill seam**

  | Field | Plan |
  | --- | --- |
  | What to build | Make exact-scope, startup, safety, retry and overflow refill reconcile each bounded scope checkpoint from the current authoritative nonterminal head before returning work. Move a stale-behind watermark forward and rebase an ahead watermark backward when older work is reopened. Rename ephemeral scan `cursor` fields to `pageToken`, retain R2 only as an optional fast path, and add bounded checkpoint/rebase diagnostics plus current architecture/operator documentation. |
  | Spec references | SCN-3, SCN-5 through SCN-11; INV-2 through INV-10; Architecture, Behavior & Failure Modes, Observability and Testing Decisions. |
  | Dependencies | R1 supplies typed persistence/bootstrap; R2 supplies the optional hot-path optimization. |
  | Delegation eligibility | Eligible after R1/R2: one deep Prepared Delivery refill seam, deterministic SQLite/engine fixtures, no live external effects or credentials. |
  | Delegation mode | Default serialized direct worker. |
  | Ownership and implementation path | Outbox/recovery stores remain sole owners of terminal facts and do not import checkpoint logic. Prepared Delivery reuses the indexed authoritative nonterminal predicate to calculate, persist and return `{checkpoint, head}` in one transaction. Delivery Engine iterates returned pages only; operations consumes aggregate diagnostics. |
  | Mutation ownership | Delivery checkpoint/refill port and Prepared Delivery store; Delivery Engine page-token integration; bounded status/health types and projections; focused checkpoint/refill/recovery/safety/status/query-plan tests; `docs/architecture.md` and `docs/feishu-group-usage.md`. |
  | Exclusions | Terminal-writer callback propagation, new recovery policies, age-based skipping, history deletion, checkpoint pruning, new fairness ratios, Delivery Scope changes, deployment/restart, Core/Gateway/Feishu protocol changes. |
  | Isolation | Serialized shared-workspace mutation after R2 acceptance. |
  | Concurrency conflicts | Touches the integrated checkpoint/refill/store/engine seam and must run as a one-ticket wave. |
  | Verification seam | Red tests for stale-behind advance, below-watermark manual retry/backward rebase, exact-scope and paged refill, uncertain/quarantine blockers, missed enqueue, page-token ephemerality, bounded diagnostics and existing 3:1 fairness; query-plan evidence; full affected checks. |
  | Host capacity | One direct-child slot; recheck before dispatch. |
  | Direct-child boundary | `delegation_allowed = false`; child cannot spawn/delegate, stage, commit, deploy, restart, or touch unrelated files. |
  | Acceptance criteria and verification | Refill always returns the current authoritative head; checkpoint advances when behind and rebases before reopened work when ahead; uncertain/incomplete/active-quarantine heads block; no later row passes a blocker; no recovery, Binding, notification or presentation writer knows checkpoint; Pane/Global isolation and 3:1 fairness remain; diagnostics are bounded/payload-free; no Agent Input or Gateway effect is replayed. |
  | Blocked by | R1 and R2. |

  Suggested atomic commit: `refactor(delivery): reconcile ring checkpoints on refill`

## Dependency and execution waves

```text
Wave 1: R1 foundation
             |
             v
Wave 2: R2 hot terminal transitions (optional acceleration)
             |
             v
Wave 3: R3-lite refill reconciliation + diagnostics/docs
```

All tickets are delegation-eligible and execute as serialized direct workers in
the authoritative in-place workspace. The active main rechecks base, Git
ownership and Host capacity before every wave. Each brief contains
`delegation_allowed = false`; workers never stage or commit. Main owns Red
evidence, diff acceptance, checkbox updates, explicit staging, atomic commits,
review aggregation and completion claims.

## Coverage check

| Requirement | Responsible ticket(s) |
| --- | --- |
| SCN-1 through SCN-3 | R1, R3 |
| SCN-4 | R2 |
| SCN-5 | R2, R3 |
| SCN-6, SCN-7 | R3 |
| SCN-8 | R1, R3 |
| SCN-9 | R1 |
| SCN-10, SCN-11 | R3 |
| INV-1, INV-2 | R1, R3 |
| INV-3 through INV-5 | R1, R2, R3 |
| INV-6 | R1 |
| INV-7 through INV-10 | R3 |

Every requirement has an implementation owner, no dependency cycle exists,
and refill correctness never depends on exhaustive terminal-writer callbacks.

## Final delivery checks

After revised R3 is committed:

1. run independent Standards and Specification review passes from `a80bcce2`;
2. route material findings through the owning ticket's Red-Green repair;
3. run focused checkpoint, Prepared Delivery, Ring hot/recovery/safety,
   migration, status, concurrency and query-plan suites;
4. run `npm run typecheck`, `npm run architecture:check`, `npm run build`,
   `npm run public:audit`, `git diff --check`, and the full Vitest suite with a
   stable worker count;
5. inspect every task commit for unrelated paths and automated co-author
   trailers; do not push;
6. report installation, restart and live database activation as pending
   separate authorization.
