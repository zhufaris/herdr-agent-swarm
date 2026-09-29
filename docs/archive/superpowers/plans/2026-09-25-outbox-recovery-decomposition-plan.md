# Outbox Recovery Decomposition Implementation Plan

## Objective

Implement the approved Outbox Recovery decomposition while preserving all
observable delivery behavior and the existing SQLite schema.

Design authority:
`docs/superpowers/specs/2026-09-25-outbox-recovery-decomposition-design.md`.

## Non-negotiable invariants

- `SqliteOutboxRecoveryStore` remains the only published recovery facade.
- Every public atomic operation retains one outer `SqliteContext.transaction()`.
- Internal recovery modules share the facade context and never start a transaction.
- Effect certainty, retry timing, delivery order, lane quarantine, and lane-head
  behavior remain unchanged.
- Replacement intent is durable before a quarantine or lane is released.
- Uncertain external effects are not automatically replayed.
- Schema, migrations, public ports, payloads, idempotency keys, action strings,
  error text, and result shapes do not change.

## Task 1: Characterize recovery protocols

Map the existing cases in `tests/sqlite-store.test.ts`,
`tests/lark-outbox-dispatcher.test.ts`, and `tests/answer-page-workflow.test.ts`
to failure transition, Answer recovery, replaceable-card recovery, immutable
effect recovery, and manual actions. Add only missing rollback/idempotency cases.

Verify with:

```bash
npx vitest run tests/sqlite-store.test.ts tests/lark-outbox-dispatcher.test.ts tests/answer-page-workflow.test.ts
```

## Task 2: Extract pure recovery policies and payload helpers

Create `src/store/sqlite/outbox-recovery/policies.ts` for effect-certainty
normalization, lane classification, stream page-index decoding, and lightweight
Answer payload rewriting. Add focused tests for exact decisions and error text.
No helper may access SQLite or mutate source projection state.

## Task 3: Extract failure transition

Create `src/store/sqlite/outbox-recovery/failure-transition.ts`. Move claim
fencing, retry/dead-letter selection, recovery classification, replacement
reservation, quarantine mutation, cooldown effects, and lane refresh behind one
internal operation. Keep the facade-owned transaction and existing return value.

## Task 4: Extract Answer startup recovery

Create `src/store/sqlite/outbox-recovery/answer-stream.ts`. Move lightweight
create retry, invalid continuation rollback, and failed-content reconstruction.
Preserve exact page/card/message/gateway checks, bounded rendering, frozen pages,
canonical offsets, idempotency keys, and replacement-before-release ordering.
Return only the existing Answer result fragments.

## Task 5: Extract replaceable and immutable recovery

Create:

- `src/store/sqlite/outbox-recovery/replaceable-card.ts`;
- `src/store/sqlite/outbox-recovery/immutable-effect.ts`.

Move superseded Answer/Worker Main proofs to the first module. Move safe notice
dismissal, rejected immutable-effect settlement, and terminal quarantine release
to the second. Each module returns its existing counters and never starts a
transaction.

## Task 6: Extract manual actions and small recovery operations

Create `src/store/sqlite/outbox-recovery/dead-letter-action.ts` for retry/dismiss,
authorization, lane release, recovery mutation, and audit. Keep eligible transient
recovery and Worker Task intent retirement either in a narrow internal module or
as small facade delegates, choosing the shape with the smallest interface.

## Task 7: Reduce the facade and enforce the seam

Make `SqliteOutboxRecoveryStore` construct the internal modules and retain only
public transaction wrappers and aggregate result assembly. Extend architecture
tests so any import of `store/sqlite/outbox-recovery/*` outside its facade or
internal directory fails, and internal files cannot import outer layers, create a
context, or call `.transaction()`. Update `docs/architecture.md` with the resulting
implementation shape.

## Task 8: Completion audit

Prove no schema, migration, public port, CardKit payload, idempotency key, action
string, retry/no-replay rule, or composition topology changed. Run:

```bash
npm test
npm run typecheck
npm run build
npm run architecture:check
npm run docs:audit
npm run public:audit
git diff --check
```

Commit only after all gates pass. Push, installation, and restart remain outside
this slice.
