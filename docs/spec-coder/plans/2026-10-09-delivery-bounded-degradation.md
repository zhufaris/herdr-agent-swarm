# Delivery Ring Bounded Degradation Implementation Plan

Specification:
`docs/spec-coder/specs/2026-10-09-delivery-bounded-degradation.md`

## Prepared Workspace

- Planning workspace: main worktree at
  `0fb9479c02db97f9448a9673c41a489eb2dd0cb6`.
- Fresh baseline: `npm test` passed 298 files and 4436 tests;
  `npm run typecheck` passed; `npm run build` passed.
- Approval state: revised live-first Gate 1 design, Gate 2 specification, and
  Gate 3 implementation authorization are approved. The user authorized
  continuation of all recovered `vdus` tasks on 2026-10-10.
- The main worktree contains overlapping uncommitted changes in
  `prepared-delivery-store.ts` and its test, plus unrelated user-owned files.
  The existing `/tmp/herdr-sqlite-r3` worktree is clean, has no branch-only
  commits, and is an ancestor of this planning baseline. It is the selected
  implementation workspace and must be fast-forwarded to the approved baseline
  before implementation mutation begins.
- Current session policy does not permit proactive subagent creation. Tickets
  are therefore planned as serialized `main-local` waves. If the user later
  explicitly requests delegation, eligibility must be recomputed and every
  mutating worker must receive real isolation.

## Ticket Dependencies

```text
Historical BD1-BD4 implementation
          |
          v
BD5 Immediate conflict isolation and live-first refill
          |
          v
BD6 Exact target-role migration and vdus regression
```

BD1-BD4 record the already implemented design and remain checked for history.
BD5 and BD6 are the reopened correction tickets produced by the newly approved
live-first design. They are serial because both touch Delivery persistence and
must be reviewed against the same production-shaped SQLite evidence.

## Tickets

### - [x] BD1: Persist conflict identity and bounded quarantine state

**What to build**

Every newly reserved Prepared Delivery receives one deterministic, immutable
conflict key. A Delivery failure persists its first-failure time, attempt/time
budget, grace deadline, quarantine phase, and optional degradation time.
Existing actionable Deliveries and active quarantines are classified in
bounded, resumable pages without rewriting terminal history.

**Spec references**

SCN-5, SCN-7; INV-7, INV-8, INV-10; Domain Model; Compatibility & Migration.

**Dependencies**

None.

**Delegation eligibility**

Eligible in principle: inputs and schema ownership are bounded, the migration
and round-trip seams are independently testable, and no production credential
is needed. It is not delegated under the current no-proactive-delegation
session constraint.

**Delegation mode**

Main-local. If explicitly re-authorized for delegation later, use one direct
worker in a clean isolated worktree.

**Ownership and implementation path**

- Delivery domain policy owns conflict-key construction and budget validation.
- Outbox reservation freezes the key with the existing effect identity.
- SQLite migrations add compatible conflict/quarantine fields and indexes.
- SQLite mapping/reconstitution preserves identity and budget exactly across
  reopen.
- A bounded compatibility classifier derives active legacy identities from
  frozen target metadata, using the full gateway-scoped lane key only as the
  conservative fallback.

**Mutation ownership**

- `src/domain/delivery.ts`
- a focused Delivery conflict/budget policy module under `src/domain/`
- `src/store/outbox-lanes.ts`
- `src/store/sqlite-records.ts`
- `src/store/sqlite/outbox-queue-store.ts`
- Delivery-related schema/migration registration under `src/store/sqlite/`
- focused migration, reservation, and domain-policy tests

**Exclusions**

No candidate bypass, checkpoint behavior change, replacement execution,
Human Review delivery, production data mutation, or edits to the pre-existing
retention-compaction repair.

**Isolation**

One main-local serial wave after the pre-existing gate repairs have been
separated. No concurrent mutation of schema, queue, or Delivery domain files.

**Concurrency conflicts**

Conflicts with BD2 and BD3 through Prepared Delivery contracts and migration
state. They cannot share a mutation wave.

**Verification seam**

Domain value/policy tests plus real SQLite migration and close/reopen tests in
the existing migration and prepared-reservation suites. Query plans verify the
new actionable-row classifier uses bounded indexes.

**Host capacity**

One local execution slot. Re-evaluate only if delegation is explicitly enabled.

**Direct-child boundary**

If delegation is later authorized, the brief must state
`delegation_allowed = false`; the child must not spawn directly or indirectly,
stage, commit, deploy, or mutate files outside BD1 ownership.

**Acceptance criteria and verification**

- New Primary, Worker, and Global Deliveries persist the approved typed key.
- Empty or invalid keys fail closed and never fall back to Global scope.
- Deadlines and phases survive database reopen without resetting.
- Legacy actionable rows are processed in bounded pages; terminal history is
  byte-preserved.
- Conservative legacy fallback retains prerequisite safety.
- Existing Delivery identity and immutable-claim triggers remain effective.
- Focused domain, migration, reservation, and query-plan tests pass, followed
  by typecheck and build.

**Blocked by**

None.

### - [x] BD2: Deliver independent work past an isolated conflict

**What to build**

After the grace budget expires, keep the quarantine active but allow the Pane
or Global Ring to claim the lowest-order independent candidate. Preserve strict
same-key and prerequisite order, one active effect per Ring, and a contiguous
checkpoint that does not advance across the isolated gap.

**Spec references**

SCN-1, SCN-2, SCN-5, SCN-6, SCN-7, SCN-9; INV-1 through INV-5, INV-7 through
INV-10; Architecture; Behavior & Failure Modes.

**Dependencies**

BD1.

**Delegation eligibility**

Eligible in principle, but it owns the central concurrency path and requires
full real-SQLite interleaving evidence. It remains main-local under the current
session constraint.

**Delegation mode**

Main-local, one-ticket wave.

**Ownership and implementation path**

- Prepared-delivery persistence atomically transitions overdue quarantine from
  grace blocking to conflict isolation.
- Scope loading returns both the earliest unresolved checkpoint blocker and
  the earliest eligible candidate.
- Claim predicates reject older same-key work, unmet prerequisites, isolated
  keys, stale fences, and any other active claim in the scope.
- Ring refill and cache behavior consume eligible candidates without treating
  a bypass as quarantine release or checkpoint advancement.
- Startup and periodic bounded maintenance rediscover expired grace phases and
  lost wake-ups.

**Mutation ownership**

- `src/domain/ports/prepared-delivery.ts`
- `src/domain/delivery-engine.ts` where contract shape requires it
- `src/store/sqlite/prepared-delivery-store.ts`
- `src/events/ring-delivery-engine.ts`
- `src/events/prepared-delivery-ring.ts` only if cached candidate semantics
  require an explicit rename or invariant
- focused prepared-store, Ring hot-path/recovery, scheduler, Primary/Worker,
  Global, and query-plan tests

**Exclusions**

No automatic replacement policy, no release of uncertain quarantine, no
Human Review UI, and no change to Core or Agent Input ordering.

**Isolation**

One main-local serial wave after BD1. It cannot overlap any task changing the
prepared-delivery store or Ring engine.

**Concurrency conflicts**

Conflicts with BD3 through claim, supersession, and recovery predicates and
with BD4 through operational Ring snapshots.

**Verification seam**

Real SQLite candidate/claim/checkpoint tests plus Ring-engine tests with
controlled time, restart, competing claims, and lost wake-up recovery.

**Host capacity**

One local execution slot.

**Direct-child boundary**

If delegation is later authorized, the direct child receives
`delegation_allowed = false` and may not spawn, stage, commit, deploy, or alter
BD1/BD3/BD4-owned files beyond explicitly transferred contract edits.

**Acceptance criteria and verification**

- An uncertain card-A effect makes zero further gateway calls.
- After 60 seconds, an independent card-B or dependency-free later page can be
  claimed while card-A remains actively quarantined.
- Later card-A work and explicit dependents remain blocked.
- The scope retains at most one active claim under a competing interleaving.
- The checkpoint remains before the unresolved order and catches up only after
  its legal terminal resolution.
- Restart reconstructs the same candidate and budget state.
- Primary, Worker-in-parent-Pane, and Global scenarios pass.
- Production-shaped `EXPLAIN QUERY PLAN` evidence remains bounded.
- Focused suites, typecheck, build, and architecture checks pass.

**Blocked by**

BD1.

### - [x] BD3: Replace confirmed non-applied Delivery at most once

**What to build**

For a `not-started` or `rejected`, reconstructible, non-frozen Delivery with a
stable idempotency or projection identity, atomically dismiss the original as
superseded, retain its certainty/audit record, link one newly reserved
replacement, and release only that conflict chain. Refuse the operation for
uncertain or mutation-sensitive effects.

**Spec references**

SCN-2, SCN-3, SCN-4, SCN-9; INV-1, INV-3, INV-6, INV-8 through INV-12;
Behavior & Failure Modes.

**Dependencies**

BD2.

**Delegation eligibility**

Eligible in principle because the predicate and recovery scenarios are
bounded and testable, but it shares the authoritative claim/recovery store with
BD2 and remains main-local under current constraints.

**Delegation mode**

Main-local, one-ticket wave.

**Ownership and implementation path**

- A common replay-safety predicate owns certainty, stable identity,
  reconstructibility, frozen-target, provider-operation, and prior-generation
  checks.
- Existing Answer, replaceable-card, immutable-effect, and dead-letter
  recovery paths invoke that predicate rather than duplicating release rules.
- Safe page-zero recovery writes dismissal, preserved certainty, recovery
  link, replacement reservation, and prerequisites in one transaction.
- Replacement ACK remains the only release point for dependent choices,
  mentions, updates, or finish operations.

**Mutation ownership**

- focused replay-safety policy under `src/domain/` or the existing recovery
  policy boundary
- `src/store/sqlite/prepared-delivery-store.ts`
- applicable modules under `src/store/sqlite/outbox-recovery/`
- `src/store/sqlite/outbox-recovery-store.ts` only where the common policy is
  consumed
- focused Answer, message-delete, Human Turn Card, Worker Ring, and recovery
  tests

**Exclusions**

No uncertain replay, no frozen-page patch, no message-delete replay, no second
automatic replacement generation, and no weakening of owner/lease fences.

**Isolation**

One main-local serial wave after BD2. No overlapping prepared-delivery or
outbox-recovery mutation.

**Concurrency conflicts**

Conflicts with BD2 and BD4 through quarantine/recovery transitions. Competing
replacement attempts must be tested, not implemented concurrently by separate
workers.

**Verification seam**

Real SQLite rollback and competing-transition tests, plus end-to-end Answer and
Worker card recovery tests that count replacement rows and gateway calls.

**Host capacity**

One local execution slot.

**Direct-child boundary**

If later delegated, the direct child receives `delegation_allowed = false` and
must not spawn, stage, commit, deploy, or modify observability/UI files.

**Acceptance criteria and verification**

- Every safe-supersession predicate term has an allowed and refusal test.
- The original row remains queryable as dismissed/superseded with its original
  effect certainty and one recovery link.
- One failed Delivery creates at most one automatic replacement.
- The replacement has a new Delivery identity and stable projection or
  idempotency identity.
- Dependents wait for replacement ACK.
- Transaction rollback leaves the original quarantine active and creates no
  partial replacement.
- `uncertain`, frozen page, `message_delete`, uncertain card update, unstable
  identity, and non-reconstructible content never release or replay.
- Focused recovery suites, typecheck, build, and architecture checks pass.

**Blocked by**

BD2.

### - [x] BD4: Escalate isolated recovery debt and expose bounded status

**What to build**

Reserve one durable, independent Human Review escalation when a quarantine
enters conflict isolation, and expose payload-free operational metrics for
grace blocking, isolated conflicts, uncertain debt, bypassed work, and review
age. Update architecture documentation to make skip-versus-release and the
allowed duplicate bound explicit.

**Spec references**

SCN-5, SCN-7, SCN-8, SCN-9; INV-1, INV-7, INV-10 through INV-12;
Architecture; Compatibility & Migration.

**Dependencies**

BD3.

**Delegation eligibility**

Eligible in principle after the persistence and recovery contracts stabilize.
It remains main-local under the current no-proactive-delegation constraint.

**Delegation mode**

Main-local, one-ticket wave.

**Ownership and implementation path**

- SQLite recovery coordination reserves at most one escalation per quarantine
  episode with an independent review conflict key.
- Existing Human Review projection/card paths render a mention and only actions
  allowed by the final recovery state; uncertain direct retry is absent.
- Operations projections aggregate phase counts and bounded ages without card
  payload.
- Architecture and operator documentation describe cross-key bypass, safe
  release, duplicate bounds, and recovery actions.

**Mutation ownership**

- focused quarantine-review reservation code under `src/store/sqlite/`
- existing Human Review projection/card modules only as needed for the new
  episode source
- `src/store/sqlite/operations-store.ts`
- operational domain/status types and health projection wiring as needed
- `docs/architecture.md` and the applicable operator reference
- focused Human Review, operations, health snapshot, documentation, and
  integration tests

**Exclusions**

No remote TraeX high-risk approval, no payload exposure, no automatic uncertain
retry button, no deployment/restart, and no retention or physical compaction.

**Isolation**

One main-local serial wave after BD3. UI/status edits must not overlap other
card or health work in the same checkout.

**Concurrency conflicts**

Depends on final BD2/BD3 phase and action semantics. It cannot run in parallel
with changes to the same Human Review, operations, or health projection files.

**Verification seam**

Real SQLite idempotency tests for one escalation per episode, card rendering
tests for mention/action safety, operations/health snapshot tests for counts and
ages, and documentation audits.

**Host capacity**

One local execution slot.

**Direct-child boundary**

If later delegated, the direct child receives `delegation_allowed = false` and
must not spawn, stage, commit, deploy, or alter Delivery eligibility/recovery
semantics beyond the already approved contracts.

**Acceptance criteria and verification**

- Repeated maintenance or restart reserves one escalation, not duplicates.
- The review effect has an independent conflict key and remains durable during
  gateway outage.
- Uncertain recovery offers no direct retry; an action can retry only after
  durable non-application evidence satisfies BD3.
- Status distinguishes grace-blocked scopes from isolated conflict keys and
  reports oldest ages and bypass counts without payload.
- Architecture documentation states that skip does not release quarantine and
  permits at most one replay-safe visible duplicate.
- Human Review, operations, health, documentation, typecheck, build,
  architecture, and full test suites pass.

**Blocked by**

BD3.

### - [x] BD4-R1: Prevent recursive quarantine-review escalation

Production evidence exposed rejected Human Review create failures recursively
creating another review for the failed review. A bounded maintenance repair now
terminalizes only rejected, unclaimed, uncheckpointed review creates, preserves
their certainty and recovery audit, releases their quarantine, and prevents a
review projection from reserving another review. Uncertain, claimed,
checkpointed, delivered, and non-review effects remain untouched. The focused
Prepared Delivery Store regression, typecheck, and build pass.

### - [x] BD4-R2: Coalesce historical unclaimed Main snapshots

Ring maintenance now dismisses only older Primary/Worker Main snapshots that
were never attempted, claimed, checkpointed, delivered, referenced by a
recovery, or connected by a prerequisite, and only when an exact newer safe
snapshot exists for the same scope, conflict, projection, and target. Work is
bounded and set-based; attempted history and the newest authoritative snapshot
remain intact.

### - [ ] BD5: Isolate a persisted failure immediately and keep live work moving

**What to build**

Remove whole-scope 60/120-second grace gating from candidate eligibility. In
the same transaction that persists a failed Delivery and its quarantine,
isolate only that Delivery's conflict key. Keep the contiguous checkpoint as a
safety watermark, but make Ring refill and ready-candidate selection independent
of the unresolved earlier order. Convert legacy active grace rows to conflict
isolation in bounded maintenance without replaying or dismissing them.

**Spec references**

SCN-1, SCN-2, SCN-5, SCN-6, SCN-9; INV-1 through INV-5, INV-7, INV-10,
INV-12; Behavior & Failure Modes; Compatibility & Migration.

**Dependencies**

Historical BD1-BD4 implementation.

**Mutation ownership**

- `src/store/sqlite/prepared-delivery-store.ts`
- the smallest necessary prepared-delivery migration/policy contract files
- `src/events/ring-delivery-engine.ts` only if refill still treats checkpoint
  position as candidate eligibility
- focused Prepared Delivery, Ring hot-path, restart, and query-plan tests

**Acceptance criteria and verification**

- Once an `uncertain`, rejected, or otherwise terminal failed result is
  committed, a later ready Delivery with a different conflict key is claimable
  on the next scheduling pass; no grace clock is consulted.
- Same-key work and explicit dependents remain blocked.
- `uncertain` produces zero automatic gateway replay, replacement, dismissal,
  or fabricated ACK across maintenance and restart.
- Only proven `not-started` or `rejected` work satisfying the full replay-safety
  predicate can reserve one automatic replacement generation.
- An unresolved lower order keeps the checkpoint behind it without preventing
  selection and completion of independent higher orders.
- Restart/refill does not promote old quarantines into a Pane-wide head and
  bounded maintenance converts legacy grace rows without payload rewrites.
- Real-SQLite interleavings retain at most one active claim per scope and use
  bounded indexes under production-shaped skew.
- Focused tests, typecheck, build, architecture checks, and full tests pass.

**Isolation and exclusions**

Implement in a clean updated worktree after separating the overlapping current
changes. Do not mutate production SQLite, replay historical `vdus` failures,
patch frozen pages, deploy, restart, push, or modify unrelated user files.

### - [ ] BD6: Prevent shared-root target-role misclassification

**What to build**

Replace the broad `root_message_id IN (...)` inference in
`CardOutboxMigrations.ensureOutboundTargetRole()` with exact target identity
classification. A shared root message is threading context, not proof that a
Turn Card update targets an operation-result card. Classification and any
dismissal must agree on projection key, target role, card role, exact
message/card identity, and applicable owner/session fence.

**Spec references**

SCN-1, SCN-5; INV-8, INV-10; Compatibility & Migration; Testing Decisions.

**Dependencies**

BD5, so the regression proves both correct classification and independent live
delivery after a historical failure.

**Mutation ownership**

- `src/store/sqlite/migrations/card-outbox-migrations.ts`
- the narrow target-role classifier if extraction is needed
- focused migration and prepared-delivery regression tests

**Acceptance criteria and verification**

- A production-shaped `vdus` fixture with a Turn Card update and an
  `operation_result` sharing `root_message_id` preserves the Turn Card row and
  its target role.
- Only an exact operation-result target is reclassified or dismissed.
- Owner/session generation mismatch fails closed.
- Migration is idempotent on reopen and does not rewrite unrelated terminal
  history.
- The three known historical failure shapes remain audit-visible; they do not
  become ready candidates or block later independent work.
- Focused migration/store tests, typecheck, build, architecture checks, and full
  tests pass.

**Isolation and exclusions**

No production data repair, broad historical cleanup, Lark replay, install,
restart, push, or edits outside the exact migration/test boundary.

## Proposed Execution Waves

The reopened waves are serial because they share authoritative Delivery
persistence and current session policy does not authorize new subagents.

1. Pre-wave: prepare a clean updated worktree and prove the current overlapping
   Prepared Delivery changes remain intact and outside the ticket diff.
2. Wave 1: BD5, main-local after Gate 3 authorization.
3. Wave 2: BD6, main-local after BD5 commit and fresh affected verification.

Each completed reopened ticket receives one atomic Conventional Commit after
its Red-Green evidence, affected checks, complete diff review, and checkbox
update. No push, pull request, install, restart, or production mutation is
authorized.

## Final Delivery Checks

- Reconcile every SCN and INV in the specification against at least one ticket
  and passing test.
- Review the complete bounded-degradation commit range against repository
  standards and the approved specification.
- Run focused Delivery, migration, recovery, Ring, Human Review, operations,
  health, and documentation suites.
- Run `npm run typecheck`, `npm run build`, `npm run architecture:check`,
  `npm test`, `git diff --check`, and `npm run public:audit`.
- Reinspect outgoing commits for sensitive data and injected attribution before
  any separately authorized push.
- Keep D3 installation/restart paused until delivery-coder reports a passing
  final review and the user separately authorizes production mutation.
