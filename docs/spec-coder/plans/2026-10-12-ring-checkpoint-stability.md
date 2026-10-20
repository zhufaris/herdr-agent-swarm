# Ring and Checkpoint Stability Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

- Specification: `docs/spec-coder/specs/2026-10-12-ring-checkpoint-stability.md`
- Workspace: `/tmp/herdr-agent-swarm-ring-stability-20261012`
- Mode: isolated; original checkout has overlapping user changes.
- Branch/base: `fix/ring-checkpoint-stability` from `76870059be2459eab7523a9d7546fb1ef92c3905`.
- Baseline: 298 files / 4453 tests, typecheck, build, architecture check and docs audit green.
- Main owns integration, explicit staging, atomic commits, final review and any deployment authorization. Direct children have `delegation_allowed = false`.

## Wave W1: `T1`, `T2`

### - [x] T1: Renew active Delivery Ring claims

| Field | Content |
| --- | --- |
| What to build | Add a fenced SQLite claim-renewal operation and an engine heartbeat around each active Gateway promise. |
| Spec references | SCN-1, SCN-2, INV-1, INV-2 |
| Dependencies | None |
| Delegation eligibility | Eligible; bounded store/engine change with deterministic fake Gateway and clock seams. |
| Delegation mode | delegate |
| Ownership and implementation path | Delivery claim aggregate is enforced by `PreparedDeliveryStore`; `RingDeliveryEngine` owns timer lifetime; settlement remains fenced by existing claim identity. |
| Mutation ownership | `src/domain/ports/prepared-delivery.ts`, `src/store/sqlite/prepared-delivery-store.ts`, `src/events/ring-delivery-engine.ts`, `tests/ring-delivery-recovery.test.ts`, `tests/ring-delivery-hot-path.test.ts`, `tests/prepared-delivery-store.test.ts` |
| Exclusions | No retry policy changes, no uncertain replay, no schema redesign, no deployment. |
| Isolation | Serial mutation in this worktree. |
| Concurrency conflicts | None |
| Verification seam | Controlled-clock slow Gateway, lease loss, renewal CAS and late settlement tests. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Direct-child boundary | `delegation_allowed = false`; no indirect delegation, staging, commit, deploy or restart. |
| Acceptance criteria and verification | Active claims renew before expiry; expired claims still recover once; renewal/settlement fences reject stale owners; no new Gateway execution is created by renewal failure; focused tests, typecheck and build pass. |
| Verification commands | `npx vitest run tests/prepared-delivery-store.test.ts tests/ring-delivery-hot-path.test.ts tests/ring-delivery-recovery.test.ts`, `npm run typecheck`, `npm run build`, `git diff --check` |
| Verification results | Exit 0; 89 focused tests passed; typecheck, build and diff check passed; observed and rechecked by main. |
| Commits | `28e4e3fc` |
| Blocked by | None |

### - [x] T2: Add Core source-transition CAS and stale-batch reload

| Field | Content |
| --- | --- |
| What to build | Allow a v2 physical ring replacement only under stable identity, add an atomic projection-gap/checkpoint transition, and make the reader honor `stale_rebase`. |
| Spec references | SCN-3, SCN-4, INV-3, INV-4, INV-8 |
| Dependencies | None |
| Delegation eligibility | Eligible; bounded Core reader/store change with existing SQLite and fake Herdr seams. |
| Delegation mode | delegate |
| Ownership and implementation path | Core domain port defines transition input/result; SQLite owns CAS and gap atomicity; reader validates fresh ring identity and reloads durable checkpoint. Legacy streams retain strict source checks. |
| Mutation ownership | `src/domain/core-event-inbox.ts`, `src/runtime/herdr-events-reader.ts`, `src/store/sqlite/core-event-inbox-store.ts`, `tests/core-session-ingestion.test.ts`, `tests/core-event-inbox-store.test.ts` |
| Exclusions | No Core protocol change, no historical Worker-lane reuse, no Agent Input replay, no production DB edits. |
| Isolation | Serial mutation in this worktree. |
| Concurrency conflicts | None |
| Verification seam | Same-session/new-ring fixture, identity rejection, transition race/rollback, stale batch not counted and checkpoint reload. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Direct-child boundary | `delegation_allowed = false`; no indirect delegation, staging, commit, deploy or restart. |
| Acceptance criteria and verification | Valid ring replacement converges with one deterministic gap; source/session/agent mismatch fails closed; losing CAS does not mutate; stale batch is reread from durable cursor and cannot report false caught-up; focused tests, typecheck and build pass. |
| Verification commands | `npx vitest run tests/core-event-inbox-store.test.ts tests/core-session-ingestion.test.ts tests/herdr-events-reader.test.ts`, `npm run typecheck`, `npm run build`, `git diff --check` |
| Verification results | Exit 0; 137 focused tests passed; typecheck, build and diff check passed; observed and rechecked by main. |
| Commits | `e3108801` |
| Blocked by | None |

## Wave W2: `T3`, `T4`

### - [x] T3: Bound unknown cursor recovery

| Field | Content |
| --- | --- |
| What to build | Preserve typed expiry, classify untyped invalid cursor, perform one verified reopen/retry, then record lane-local cooldown/gap instead of retrying forever. |
| Spec references | SCN-5, INV-5, INV-6 |
| Dependencies | T2 |
| Delegation eligibility | Eligible; adapter/supervisor behavior has focused fake RPC and retry seams. |
| Delegation mode | delegate |
| Ownership and implementation path | Adapter normalizes external error shape; supervisor owns retry/cooldown scheduling; Core checkpoint store remains the only checkpoint mutator. |
| Mutation ownership | `src/adapters/herdr-events-adapter.ts`, `src/coordinator/core-session-ingestion-supervisor.ts`, `src/domain/core-event-inbox.ts`, `src/domain/herdr-events.ts`, `src/domain/types.ts`, `src/runtime/herdr-events-reader.ts`, `src/store/sqlite/core-event-inbox-store.ts`, `tests/herdr-adapter.test.ts`, `tests/core-session-ingestion.test.ts`, `tests/core-event-inbox-store.test.ts` |
| Exclusions | No invented cursor, no global service stop, no automatic Agent Input resubmission. |
| Isolation | Serial mutation in this worktree. |
| Concurrency conflicts | None |
| Verification seam | Invalid-cursor one-retry/cooldown test and healthy-lane isolation test. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Direct-child boundary | `delegation_allowed = false`; no indirect delegation, staging, commit, deploy or restart. |
| Acceptance criteria and verification | Unknown cursor does not advance checkpoint, does not busy-loop, records durable lane evidence, and does not prevent unrelated lanes; affected tests/typecheck/build pass. |
| Verification commands | `npx vitest run tests/herdr-adapter.test.ts tests/core-session-ingestion.test.ts tests/core-event-inbox-store.test.ts tests/herdr-events-reader.test.ts`, `npm run typecheck`, `npm run build`, `git diff --check` |
| Verification results | Exit 0; 206 focused tests passed; typecheck, build and diff check passed; observed and rechecked by main. |
| Commits | `365548c3` |
| Blocked by | T2 |

### - [x] T4: Separate global maintenance from paged refill

| Field | Content |
| --- | --- |
| What to build | Run global quarantine cleanup/coalescing once per safety cycle and make historical Main coalescing bounded and target-safe. |
| Spec references | SCN-6, INV-6, INV-7 |
| Dependencies | None |
| Delegation eligibility | Eligible; store/engine maintenance seam has deterministic SQLite fixtures. |
| Delegation mode | delegate |
| Ownership and implementation path | Engine owns cycle orchestration; store owns short transactional global maintenance and scope-local page loading. |
| Mutation ownership | `src/events/ring-delivery-engine.ts`, `src/store/sqlite/prepared-delivery-store.ts`, `tests/prepared-delivery-store.test.ts`, `tests/ring-delivery-recovery.test.ts` |
| Exclusions | No new delivery ledger, no broad history deletion, no stream reorder. |
| Isolation | Serial mutation in this worktree. |
| Concurrency conflicts | None |
| Verification seam | Call-count/maintenance-cycle test, bounded coalescing safety test, SQLite lock-duration/query behavior checks. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Direct-child boundary | `delegation_allowed = false`; no indirect delegation, staging, commit, deploy or restart. |
| Acceptance criteria and verification | Global maintenance executes once per cycle, coalescing never touches claimed/checkpointed/prerequisite/recovery-linked rows, and scope refill remains live; affected tests/typecheck/build pass. |
| Verification commands | `npx vitest run tests/prepared-delivery-store.test.ts tests/ring-delivery-recovery.test.ts tests/ring-delivery-hot-path.test.ts`, `npm run typecheck`, `npm run build`, `git diff --check` |
| Verification results | Exit 0; 91 focused tests passed after main's fallback/skip-global repair; typecheck, build and diff check passed. |
| Commits | `2e4bd3f3` |
| Blocked by | None |

## Wave W3: `T5`

### - [x] T5: Invalidate only safe historical ring references on live work

| Field | Content |
| --- | --- |
| What to build | Let a live notification invalidate unclaimed replaceable history references and refill the exact scope without reordering stream content or bypassing same-conflict work. |
| Spec references | SCN-7, INV-7, INV-8 |
| Dependencies | T4 |
| Delegation eligibility | Eligible; bounded in-memory ring behavior with existing ring/scheduler tests. |
| Delegation mode | delegate |
| Ownership and implementation path | `PreparedDeliveryRing` owns disposable references; SQLite remains authoritative; engine performs scope refill and scheduler wake. |
| Mutation ownership | `src/events/prepared-delivery-ring.ts`, `src/events/ring-delivery-engine.ts`, `tests/prepared-delivery-ring.test.ts`, `tests/ring-delivery-recovery.test.ts`, `tests/ring-delivery-hot-path.test.ts` |
| Exclusions | No reordering of stream create/content/finish and no durable dismissal without the existing store policy. |
| Isolation | Serial mutation in this worktree. |
| Concurrency conflicts | None |
| Verification seam | Live-after-history latency fixture, stream FIFO preservation and exact-scope refill. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Direct-child boundary | `delegation_allowed = false`; no indirect delegation, staging, commit, deploy or restart. |
| Acceptance criteria and verification | Safe stale cache refs are dropped, live work becomes runnable after refill, unsafe history remains ordered, and unrelated scopes remain unaffected; affected tests/typecheck/build pass. |
| Verification commands | `npx vitest run tests/prepared-delivery-ring.test.ts tests/ring-delivery-recovery.test.ts tests/ring-delivery-hot-path.test.ts`, `npm run typecheck`, `npm run build`, `git diff --check` |
| Verification results | Exit 0; 36 focused tests passed; typecheck, build and diff check passed; observed and rechecked by main. |
| Commits | `7276e001` |
| Blocked by | T4 |

## Final delivery checks

Main reviews each complete diff against the specification, runs affected tests,
`npm run typecheck`, `npm run build`, `npm run architecture:check`,
`npm run docs:audit`, `git diff --check`, and the full `npm test` suite freshly.
No deployment, restart, push or production database mutation is included.
