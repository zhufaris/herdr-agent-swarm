# Gateway Plan Effect Freeze

## Problem Statement

Outbound delivery persists a provider-neutral Gateway plan before claiming an outbox row. In the crash window between plan persistence and claim, the row still has `attempt_count = 0` and `first_claimed_at = NULL`. The current same-key enqueue path therefore permits a newer payload, intent, or revision to overwrite that row without replacing its persisted plan. Recovery can then execute plan A while checkpointing durable payload/revision B.

An exact projection replay after plan persistence also falls through the mutable UPSERT path because the caller does not carry the derived plan fields. Although the effect bytes remain the same, this needlessly rewrites row metadata instead of being an idempotent no-op. A post-deploy startup pass separately observed an `outbound_idempotency_conflict` for one historical Answer view; this slice prevents plan/payload divergence but does not assume that historical row has the same cause.

## Solution

Treat the first persisted Gateway plan/hash as the durable effect-freeze boundary, equivalent to a claim for mutation safety but not for attempt accounting. Once frozen:

- an exact same-effect enqueue returns the existing row even when the caller omits derived plan/checkpoint fields;
- a changed payload, intent, target, kind, renderer revision, view/card sequence, or explicitly conflicting Gateway state fails with `outbound_idempotency_conflict`;
- SQLite rejects direct mutation of effect-defining columns;
- the unchanged frozen row remains claimable and executes its original plan.

## User Stories

- **G1 — Crash recovery:** after plan persistence and process restart, re-enqueuing a changed same-key projection cannot pair a new payload with the old plan.
- **G2 — Idempotent convergence:** after plan persistence and process restart, replaying the exact same delivery intent returns the original row without changing its plan or timestamps.
- **G3 — Storage enforcement:** direct SQL mutation of an effect-defining field after plan persistence is rejected by the database invariant.
- **G4 — Delivery continuity:** the unchanged prepared row remains eligible for normal claim, execution, retry, and checkpoint handling.

## Implementation Decisions

### Domain Model

The Outbox Delivery aggregate owns one immutable external effect per idempotency key. The caller-supplied effect identity consists of Gateway identity, destination and owner identities, delivery kind, canonical payload/intent, renderer revision, view/card/stream sequence, lane, and projection snapshot identity. The Gateway plan/hash is derived execution evidence. Persisting that evidence freezes the effect identity even before the first claim.

`workClass` is scheduling metadata rather than external-effect identity. Rediscovering the exact same effect through live and history convergence returns the original row and preserves its original work class; changing any effect field still conflicts.

`attempt_count` and `first_claimed_at` keep their existing meanings; plan persistence does not fabricate an attempt. Exact replay compares effect identity independently from omitted derived execution evidence.

### Architecture

`SqliteOutboxQueueStore.enqueue()` distinguishes caller effect equality from compatible optional Gateway state. Equality uses the canonical card sequence that the same transaction would persist after replaceable-status normalization. Its freeze predicate includes `gateway_plan_json` or `gateway_plan_hash` in addition to existing claim/checkpoint evidence. The `outbound_replies_immutable_claim` trigger converges on startup to enforce every stored destination field, including shortcut-panel ownership, when either first claim or first plan exists.

The delivery executor and Gateway interface remain unchanged. The existing plan-first, claim-second recovery contract remains authoritative.

Alternatives rejected:

- clearing/rebuilding the plan when payload changes, because it weakens frozen execution evidence and creates another replacement race;
- preparing only after claim, because it changes attempt/failure semantics and the broader dispatcher state machine.

### Behavior & Failure Modes

An exact replay is a no-op. A conflicting replay of a frozen row fails before any coalescing or UPSERT side effect regardless of whether the row is pending, delivered, dismissed, or dead-lettered. A database-level bypass raises `immutable_outbound_revision`. Legacy rows without a plan, claim, attempt, or card checkpoint retain the existing pre-effect coalescing behavior.

### Compatibility & Migration

No table or public API migration is required. Startup trigger convergence replaces the older trigger definition when it lacks the plan-freeze predicate. Existing prepared rows become protected immediately; their data is not rewritten.

## Testing Decisions

Add focused SQLite integration tests that create file-backed prepared rows and prove G1-G4 across payload, destination, owner, lane, projection snapshot, normalized status-card sequence, work-class rediscovery, terminal-row conflicts, and direct shortcut-panel mutation. Retain existing tests for pre-claim mutation, claim immutability, prepared-plan reuse, retry, and dispatcher execution.

Run the focused SQLite claim tests, full `tests/sqlite-store.test.ts`, dispatcher tests, typecheck, build, full suite, and two-axis review.

## Out of Scope

- changing Gateway plan representation or removing duplicated plan payloads;
- classifying Gateway preparation poison pills;
- repairing existing historical projection conflicts;
- binding-less dead-letter administration.

## Further Notes

- Workspace: `/workspace/herdr-agent-swarm`, in-place on `main`.
- Starting revision: `b9a64a09abb2c236fedaa5d3c4ac6376891e5e27`.
- Preserved user changes: modified `TODO.md`; untracked research, Core-gap spec, and `handoff.md`.
- Fresh baseline: 274 files / 3,952 tests passed; `npm run typecheck` and `npm run build` passed.
- Approval: covered by the user's standing authorization to implement, test, commit, install, and deploy the recommended delivery-stability repairs without per-step confirmation.
