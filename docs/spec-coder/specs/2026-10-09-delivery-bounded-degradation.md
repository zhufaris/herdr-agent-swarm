# Delivery Ring Bounded Degradation

## Problem Statement

The current Delivery Ring preserves external-effect order by selecting the
oldest nonterminal Delivery in a Pane or Global scope. An active quarantine on
that head prevents any later Delivery in the same scope from being claimed.
This is safe for an uncertain effect, but one permanently unresolved card can
therefore freeze every otherwise independent card owned by the same Primary
Pane.

The intended change is live-first bounded degradation: quarantine evidence
remains durable and an uncertain effect is never replayed automatically, while
a persisted failed Delivery immediately isolates only its conflict key. The
scheduler may deliver independent cards or independently creatable later pages
without waiting for a whole-scope grace timer. For replay-safe effects with a
stable idempotency or projection identity, at most one replacement may proceed
after confirmed non-application even if the client can consequently observe one
duplicate version.

This specification changes Delivery ordering and recovery only. It does not
weaken Core event order, Agent Input no-replay, Delivery owner fencing, frozen
Answer pages, prerequisite ordering, or durable audit history.

## Solution

Keep exactly one Delivery Ring for each Primary Pane and one Global Ring.
Worker effects continue to use their parent Primary Pane Ring. Add a frozen
`conflictKey` to each prepared Delivery to identify effects that touch the same
external card, page, element, or create/dependent chain.

Within a scope, the Delivery selector chooses the lowest-order eligible item.
An item is eligible only when it has no older nonterminal item with the same
conflict key, has no unmet explicit prerequisite, has no active claim, and its
conflict key is not isolated. Once a failed outcome and its quarantine are
durably committed, the quarantine is conflict-isolated immediately, allowing
unrelated conflict keys to proceed without releasing, dismissing, or otherwise
terminalizing the quarantined Delivery.

Cross-key skipping and same-key release are separate operations. Cross-key
skipping leaves the original quarantine active. Same-key release is allowed
only after an atomic safe-supersession decision proves that the original effect
was `not-started` or `rejected`, is rebuildable and non-frozen, has a stable
deduplication identity, and has not already consumed its one automatic
replacement generation.

The durable Ring checkpoint remains a contiguous safety watermark. Delivering
an item beyond an unresolved earlier quarantine does not advance the checkpoint
past that gap. Once the gap reaches a terminal recovery state, checkpoint
recomputation can advance across already terminal later rows.

The recovery policy is:

| Effect outcome | Automatic work | Scheduling effect |
| --- | --- | --- |
| `rejected` or `not-started` | At most one safe replacement when the supersession predicate holds; no unbounded replay loop | Persist and immediately isolate the conflict key until replacement ACK or another durable resolution |
| `uncertain` | Receipt, checkpoint, and reconciliation queries only; zero external replay, replacement, or dismissal | Persist and immediately isolate the conflict key |
| permanent failure without positive non-application proof | Human Review and durable audit only | Persist and immediately isolate the conflict key |
| application or gateway cooldown before an individual effect is attempted | Existing global cooldown behavior | No individual quarantine is created solely from cooldown |

Failure timestamps, certainty, quarantine state, and recovery generation survive
restart. Bounded startup or periodic maintenance converts any legacy active
whole-scope grace quarantine to conflict isolation without replaying it.

## User Stories

### SCN-1: Unrelated cards remain live

When an Answer Card effect becomes uncertain, later Main Card, other Answer
Card work, or an
independently creatable later Answer page in the same Primary Pane can be
delivered if it has a different conflict key and no prerequisite on the failed
effect. The failed Answer Card chain remains quarantined and queryable; the
bypass does not release it.

### SCN-2: A conflicting chain never overtakes uncertainty

When a page-zero create is uncertain, updates, finish operations, choices, and
mentions that depend on that card cannot pass it. The create is not replayed or
replaced automatically. Unrelated conflict keys may proceed once the failure
and isolation are durably committed.

### SCN-3: Confirmed rejection can rebuild safely

When a page-zero create is positively rejected, non-frozen, rebuildable, and
identified by a stable idempotency or projection identity, recovery may
atomically dismiss the failed Delivery as superseded, preserve its effect
certainty and audit/recovery record, render the current authoritative snapshot,
and reserve one new create with a new Delivery identity. Dependent choices,
mentions, and updates remain blocked until the replacement create is
acknowledged. If an older version was visible despite the rejection evidence,
the client may observe at most one duplicate version.

### SCN-4: A newer replaceable snapshot supersedes confirmed non-application

When a replaceable card update is `rejected` or `not-started`, is non-frozen,
has a stable deduplication identity, and a newer authoritative snapshot exists
for the exact target, the old Delivery can be atomically dismissed and linked
to one replacement. This operation is never applied to an `uncertain` effect,
a message deletion, or an update whose remote mutation outcome is uncertain.

### SCN-5: Restart preserves degradation

After restart, the service reconstructs conflict-isolated quarantines, their
conflict identities, replacement links, and human-review escalation state.
Restart neither reintroduces a whole-scope block nor causes an uncertain effect
to be submitted again.

### SCN-6: Checkpoint truth survives out-of-order completion

If delivery orders 12 and 13 complete while order 11 is conflict-isolated, the
scope checkpoint remains at 10. When 11 later becomes delivered, dismissed, or
recovered by an acknowledged replacement, the checkpoint may advance across
12 and 13 in one transactional recomputation.

### SCN-7: Primary, Worker, and Global routing remain coherent

Primary and Worker effects use the same eligibility and degradation policy in
the parent Primary Pane Ring. A Worker never gets a separate Ring. Truly global
effects use the Global Ring and isolate by a global conflict identity.

### SCN-8: Human review is durable and non-recursive

Entering conflict isolation reserves at most one durable Human Review
escalation per quarantine episode. Its mention and controls use an independent
review conflict key, so they do not depend on the failed card surface. An
unavailable gateway leaves the escalation durable for later delivery rather
than silently losing it.

### SCN-9: Skipping does not release quarantine

When an uncertain card-A update is conflict-isolated, a later independent
card-B create may be selected and delivered. The card-A Delivery remains
dead-lettered with its original effect certainty, its active quarantine remains
visible, and later card-A mutations remain blocked. Only a separate durable
resolution can release that quarantine.

## Implementation Decisions

### Domain Model

The affected bounded context is **Delivery**. Conversation and Card Projection
remain producers of immutable Delivery Intent; Lark remains an external effect
boundary and is not workflow authority.

Observed terms:

- **Delivery Scope** identifies one Primary Pane Ring or the Global Ring.
- **Lane Key** groups current coalescing, retry, and recovery behavior.
- **Delivery Ring Checkpoint** is a derived contiguous scan watermark, not
  proof that every greater order has completed.
- **Quarantine** preserves a failed effect and its recovery evidence.

Proposed terms:

- **Conflict Key** is an immutable value identifying effects that may touch the
  same external target or create/dependent chain. Equality is exact string
  equality after deterministic construction; it always includes gateway
  identity and a typed target namespace.
- **Conflict Isolation** is an active quarantine phase that blocks only its
  conflict key while permitting unrelated eligible work in the same scope.
- **Cross-key Skip** is a scheduling decision that selects a later independent
  Delivery without changing the state of the quarantined item.
- **Replay-safe Recovery** is the one-generation retry or replacement allowed
  only for confirmed non-application, reconstructible non-frozen content, and
  a stable idempotency or projection identity. It permits at most one
  client-visible duplicate version; it does not claim provider exactly-once
  delivery.

The conflict-key policy constructs identities from already frozen Delivery
facts:

- Primary Main: gateway plus binding identity and binding generation.
- Primary Answer: gateway plus prompt identity and page index.
- Worker Main: gateway plus Worker identity and Worker session generation.
- Worker Task: gateway plus Worker Turn identity and page index.
- Human Review: gateway plus review episode and surface generation.
- Independent reply or text: gateway plus immutable reply identity.
- Known external surface: gateway plus typed surface/message identity.
- Global effect: gateway plus typed global operation target.

Create and dependent operations that use different lane keys must either map to
the same conflict key or remain connected by a durable prerequisite. The
classifier must reject an invalid or empty key; it must not silently fall back
to the Global scope.

The Delivery aggregate is the scope-local ordered set plus its checkpoint,
quarantines, prerequisites, and claims. SQLite owns the atomic invariants; the
process-local Ring is a bounded cache and scheduler, not state authority.

### Invariants

- **INV-1 — Zero replay under uncertainty:** an `uncertain` Delivery has no
  automatic gateway replay, automatic replacement, or automatic dismissal.
  Grace maintenance may only gather durable evidence.
- **INV-2 — Conflict order:** a Delivery cannot be claimed while an older
  nonterminal Delivery with the same scope and conflict key exists.
- **INV-3 — Prerequisite order:** conflict isolation never bypasses an unmet
  explicit prerequisite.
- **INV-4 — One external effect per Ring:** at most one Delivery claim can be
  active for a Pane or Global scope, including when an earlier order is
  conflict-isolated.
- **INV-5 — Honest checkpoint:** the Ring checkpoint never advances across the
  earliest unresolved nonterminal order merely because a later independent
  item completed.
- **INV-6 — Positive replacement proof:** automatic replacement or safe
  supersession requires `rejected` or `not-started` certainty plus the existing
  exact-target and authoritative-snapshot checks, a non-frozen target, a stable
  deduplication identity, and an unused automatic recovery generation.
- **INV-7 — Durable failure state:** the first-failure time, attempt count,
  certainty, isolation time, recovery generation, and release action survive
  process restart.
- **INV-8 — Fenced ownership:** every claim and settlement retains the existing
  instance lease, owner generation, session generation, parent generation, plan
  hash, and snapshot revision checks.
- **INV-9 — Frozen pages remain frozen:** degradation cannot patch a frozen
  Answer page or redirect later content into it.
- **INV-10 — Durable audit:** isolation changes scheduling eligibility only; it
  does not delete or rewrite failed Delivery, recovery, checkpoint, or audit
  evidence.
- **INV-11 — Bounded duplicate:** one failed Delivery can produce at most one
  automatic replay-safe replacement generation. The original remains
  queryable as `dismissed`/`superseded`, retains its effect certainty, and links
  to the replacement.
- **INV-12 — Conservative mutation effects:** frozen-page effects, message
  deletion, existing-card content updates with uncertain remote outcome, and
  all other `uncertain` effects cannot use automatic release, retry, or
  replacement.

### Architecture

The domain Delivery policy owns conflict-key construction, failure
classification, replay-safety, and candidate eligibility rules. It contains no
SQLite or Lark SDK types.

The outbox reservation path freezes the conflict key with Delivery Scope,
Delivery owner fence, plan hash, idempotency identity, snapshot revision, and
delivery order. `PreparedDelivery` exposes that immutable key to the Delivery
Engine.

The SQLite prepared-delivery store owns:

- atomic failure-to-conflict-isolation transitions;
- selection of the earliest eligible candidate rather than merely the earliest
  nonterminal row;
- enforcement that no older same-key nonterminal or unmet prerequisite exists;
- separation of cross-key candidate bypass from quarantine release;
- scope-wide active-claim exclusion;
- contiguous checkpoint recomputation independent of candidate selection;
- safe supersession, replacement linking, release, and audit writes.

The Delivery Engine continues to own one in-memory Ring per Primary Pane plus
one Global Ring. It does not create a Ring per conflict key. It asks the store
for one eligible candidate at a time, claims it atomically, and re-wakes the
same scope after settlement or a persisted eligibility transition.

Existing recovery components remain responsible for Answer, replaceable-card,
immutable-effect, and dead-letter-specific evidence. They invoke the common
quarantine transition contract rather than implementing their own bypass
rules.

The operations projection exposes aggregate counts and oldest ages for conflict
isolation, isolated uncertainty, bypassed later work, and pending Human Review.
It exposes identities and bounded reasons but no card payload.

### Behavior & Failure Modes

A Delivery failure and its quarantine/recovery transition are committed in one
SQLite transaction. The committed state immediately isolates the failed
conflict key; there is no whole-scope grace interval. For confirmed
non-application, the transaction preserves the original first-failure time and
may reserve the one allowed safe replacement. For uncertainty, it records zero
retry eligibility. Repeating the isolation transition is idempotent and does
not change the failed Delivery, release its conflict chain, or close its
recovery record.

Candidate selection has two independent results:

1. the authoritative earliest unresolved order used to compute the safe
   checkpoint; and
2. the earliest currently eligible Delivery used by the Ring.

They may differ only when an earlier active quarantine has entered conflict
isolation. A later item sharing the conflict key is ineligible even if it is
otherwise ready. A later item with an unmet prerequisite is also ineligible.
An independently creatable later page may proceed when its page-scoped conflict
key differs and it has no prerequisite on the quarantined page.

Automatic recovery of rejected page-zero creates reserves one new Delivery
identity and prerequisite chain in the same transaction that dismisses the old
row as superseded, preserves its effect certainty, and links it to the
replacement. The safe-supersession predicate requires confirmed
non-application, reconstructible current Projection state, a non-frozen target,
a stable idempotency or projection identity, and no prior automatic replacement
generation. Release of dependent work requires the replacement ACK. Failure to
reserve the complete replacement leaves the original quarantine active. A
second automatic replacement from the same failed Delivery is rejected.

Frozen-page effects, `message_delete`, existing-card updates with uncertain
remote outcome, missing stable identity, non-reconstructible content, and any
other `uncertain` effect fail the safe-supersession predicate. They remain
conservatively blocked within their conflict key and dependency chain. Their
quarantine may be bypassed immediately by unrelated keys, but is not released.

Human Review escalation uses an idempotency key derived from the quarantine
episode. Direct retry of an uncertain effect is not an allowed automatic or
one-click action. A retry becomes eligible only after durable reconciliation
proves non-application and records a certainty transition compatible with the
existing recovery policy.

An application-wide cooldown continues to block delivery globally. It does not
increment an individual Delivery attempt or manufacture a quarantine. A lost
process wake-up is repaired by the existing startup, periodic, and retry scans.

### Compatibility & Migration

Persistence changes are additive. Current public Delivery state values and
`delivery_recoveries` states remain compatible. Quarantine records retain
conflict identity, first-failure/isolation timestamps, certainty, recovery
generation, and Human Review state without discarding their existing lane
identity or release actions. Legacy grace/deadline columns may remain readable,
but they no longer gate unrelated candidate eligibility.

New outbound rows persist a conflict key at reservation. Existing delivered or
dismissed history is not rewritten. Existing actionable rows and active
quarantines are classified in bounded pages from frozen target metadata. When
an exact richer identity cannot be reconstructed, the complete gateway-scoped
lane key is the conservative conflict key. Existing prerequisites remain
authoritative and prevent a legacy create/dependent chain from separating.
Existing `auto_recovery_count` or an equivalent recovery-generation constraint
enforces the one-replacement limit without deleting prior recovery evidence.

Migration and startup processing must remain bounded and resumable on the
multi-gigabyte production database. No table-wide payload rewrite, database
replacement, `VACUUM`, or destructive cleanup belongs to this change.

## Testing Decisions

- Domain policy tests cover deterministic conflict-key construction, exact
  equality, invalid inputs, failure classification, and restart-stable
  isolation state.
- Prepared-delivery store tests prove SCN-1, SCN-2, SCN-4, SCN-6, and SCN-9 through
  real SQLite rows, including a later unrelated Delivery that is claimable
  immediately after failure persistence while the checkpoint remains before an
  isolated gap and the original quarantine remains active.
- Recovery integration tests prove SCN-3: rejected page-zero create is
  dismissed and linked to one new identity; dependent actions remain blocked
  until replacement ACK; rollback leaves the original quarantine active.
- Uncertainty tests count gateway calls and prove INV-1 across maintenance,
  restart, newer snapshots, and Human Review actions.
- Replay-safe recovery tests prove the full supersession predicate, at-most-one
  replacement generation, preserved original certainty/audit, and refusal for
  frozen pages, message deletion, unstable identity, non-reconstructible
  content, and uncertain card updates.
- Concurrency tests interleave candidate selection, claim, degradation, and
  release to prove one active claim per scope and losing conditional writes.
- Primary/Worker integration tests prove identical parent-Ring eligibility and
  owner/parent fencing. Global Ring tests prove the corresponding global
  conflict behavior.
- Migration tests reopen legacy schemas and classify legacy actionable rows
  without rewriting terminal history or weakening immutable Delivery triggers.
- Target-role migration tests reproduce the `vdus` production shape and prove
  that a shared `root_message_id` alone cannot classify or dismiss a Turn Card
  update as an `operation_result`. Classification requires matching
  `projection_key`, `target_role`, `card_role`, exact message/card identity, and
  the applicable owner/session fence.
- Query-plan tests use production-shaped skew to prove candidate and
  checkpoint queries remain bounded by scope/order/conflict indexes.
- Operations tests verify new counts and oldest ages without exposing payload.
- Full verification requires focused Delivery/recovery/migration tests,
  `npm run typecheck`, `npm run build`, `npm run architecture:check`, and
  `npm test`.

## Out of Scope

- Changing Core conversation ordering or Agent Input eligibility.
- Creating per-card or per-Worker Delivery Rings.
- Automatically replaying, replacing, or dismissing uncertain external
  effects.
- Promising zero visible duplicates for replay-safe replacement; the approved
  contract permits at most one duplicate version.
- Removing quarantine, recovery, dead-letter, or audit history.
- Patching frozen Answer pages.
- Changing remote TraeX approval authority.
- D3 installation, restart, retention enablement, production cleanup, physical
  database compaction, or T14/D4 work.
- Pushing a branch, opening a pull request, or publishing an external issue.

## Further Notes

- Workspace: `/tmp/herdr-sqlite-r3`.
- Mode: existing isolated Git worktree, retained because the broader SQLite R3
  work and production gate repairs are already isolated from `main`.
- Branch: `feat/sqlite-r3`.
- Starting revision: `3a46c247a3f89a4e6b3cfa35cd0d5449c61b8502`.
- Current planning baseline is `main@0fb9479c02db97f9448a9673c41a489eb2dd0cb6`.
  The main worktree contains pre-existing overlapping Prepared Delivery changes
  and unrelated user-owned files; implementation must use a clean updated
  worktree or explicitly separate those changes before mutation.
- Fresh baseline on 2026-10-10: `npm test` passed 298 files and 4436 tests;
  `npm run typecheck` passed; `npm run build` passed and generated build identity
  `sha256:190136aec5bc346fa97e610341b79db3c3593e78d87a17c643ea6c85d8e30a41`.
- Gate 1 approved the live-first conflict-isolation design: failed work does
  not block unrelated keys, uncertainty is never replayed automatically, and
  confirmed non-application permits at most one safe replacement. Gate 2
  approved this revised written specification and the BD5/BD6 ticket boundary;
  Gate 3 implementation authorization was granted when the user asked to
  continue all recovered `vdus` tasks on 2026-10-10.
