# Outbox Recovery Decomposition Design

## Goal

Deepen outbound recovery persistence without changing delivery behavior.
`SqliteOutboxRecoveryStore` remains the only public recovery implementation,
while failure transitions, Answer recovery, replaceable-card recovery, immutable
effect settlement, and manual dead-letter actions become locally understandable
internal protocols.

This is a behavior-preserving refactor. SQLite schema and migrations, public
ports, recovery result shapes, action strings, idempotency keys, delivery order,
effect-certainty decisions, retry timing, lane quarantine, and no-replay rules do
not change.

## Current shape and problem

`SqliteOutboxRecoveryStore` currently combines five protocols in one class:

- classify a delivery failure and atomically update the reply, recovery ledger,
  lane quarantine, app cooldown, and lane head;
- retry recoverable Answer creates and rebuild invalid continuations at startup;
- settle superseded Answer and Worker Main targets;
- dismiss proven-rejected immutable effects and release terminal quarantines;
- authorize, audit, retry, or dismiss a dead letter manually.

These protocols share one durable consistency boundary, but their SQL and proof
conditions are independent enough to reason about separately. The current
implementation makes the transaction boundary less visible than its recovery
branches and requires maintainers to understand unrelated recovery proofs at
once.

The problem is implementation locality, not the public interface. Splitting the
public capability would expose ordering requirements and make callers responsible
for partial recovery.

## Considered approaches

### A. Stable transaction facade with internal protocol modules (chosen)

Keep `SqliteOutboxRecoveryStore` as the public implementation. It owns each outer
transaction and delegates to internal modules that share its `SqliteContext`,
queue store, and delivery store. This preserves a small interface and hides the
proof and mutation sequences behind it.

### B. Pure classification extraction only

Extract failure classification and payload helpers but retain the startup recovery
SQL in the facade. This improves isolated decisions but leaves the longest and
most failure-sensitive protocol undivided.

### C. Multiple public recovery stores

Publish Answer, snapshot, immutable-effect, and dead-letter stores separately.
Callers would then need to understand transaction ordering, quarantine release,
replacement durability, and lane refresh. This creates shallow modules and risks
partial commits.

## Authority and consistency boundary

SQLite remains authoritative for outbound intent, delivery attempts, effect
certainty, recovery records, quarantined lanes, replacement identity, cooldowns,
and lane heads. Lark remains only the external effect target. Startup recovery
must use durable evidence; it must not infer success from visible cards.

The aggregate operation is a recovery transition, not an individual table row.
For one failed reply, its reply state, recovery ledger, quarantine, replacement
intent, related projection checkpoint, and lane-head state commit together when
the existing operation requires them to. Sharing one SQLite transaction does not
merge Answer Projection, Worker Main Projection, and Delivery Operations into one
bounded context; the facade coordinates those durable participants.

## Chosen module shape

```text
Outbound and startup consumer ports
               |
               v
SqliteOutboxRecoveryStore             stable public transaction facade
               |
               +-- OutboundFailureTransition
               |     claim fence, classification, retry/dead-letter/quarantine
               +-- AnswerStreamRecovery
               |     lightweight retry, continuation rollback and rebuild
               +-- ReplaceableCardRecovery
               |     exact Answer and Worker Main supersession proofs
               +-- ImmutableEffectRecovery
               |     rejected effects, notices, and terminal quarantine release
               `-- DeadLetterAction
                     authorization, retry/dismiss mutation, audit

All modules share the facade's SqliteContext and primary connection.
Only the facade starts use-case transactions.
```

Internal classes are implementation roles, not public repositories. They are not
published by `SqliteOutboxStore`, the capability graph, or composition.

### `SqliteOutboxRecoveryStore`

The facade retains every current public method and return type. It owns one outer
transaction for failure transition, eligible-dead-letter recovery, retirement of
undelivered Worker Task intents, startup quarantine recovery, retry, and dismiss.
It assembles the existing aggregate startup result and contains no branch-specific
recovery SQL after extraction.

### `OutboundFailureTransition`

Owns exact claim matching and the transition from a pending delivery attempt. It:

- preserves late/stale callback behavior and claim release;
- normalizes effect certainty exactly as today;
- classifies lane and recovery action without weakening fail-closed behavior;
- updates retry state or dead letter, recovery ledger, quarantine, app cooldown,
  and lane head in the existing order;
- returns the existing `OutboundFailureTransition`.

Repeated callbacks for an already dead-lettered reply return the existing durable
action without incrementing attempts or creating another recovery.

### `AnswerStreamRecovery`

Owns startup recovery that requires Answer-specific state and payloads:

- lightweight retry for eligible Answer create intents;
- rollback and reconstruction of invalid continuation state;
- exact page, card, message, gateway, projection, and delivery-order checks;
- bounded rendering with the existing Answer recovery page limit;
- replacement intent persistence before quarantine release.

Frozen pages remain immutable. Canonical source offsets and current projection
checkpoints are preserved. Payload rewriting stays a render-only transformation
of the replacement intent and never rewrites source answer state.

### `ReplaceableCardRecovery`

Owns proof that an uncertain update has been superseded by a newer authoritative
target. Answer recovery requires the exact delivered replacement card and current
static page identity. Worker Main recovery requires the exact gateway, binding,
Worker, session generation, root message, card role, target role, and current view
version. Claimed, previously attempted, mismatched, or older pending work prevents
automatic release.

Only after the replacement is durable does the module settle the recovery, release
the quarantine, dismiss obsolete pending updates, and refresh the lane head.

### `ImmutableEffectRecovery`

Owns startup cases whose durable proof does not require rebuilding a mutable
projection:

- dismiss undelivered notices only under the existing safe conditions;
- dismiss immutable effects proven rejected by the Gateway;
- release Answer quarantines only after the prompt and observation are terminal
  and no pending lane work remains.

An uncertain immutable effect is never converted into a retry merely because the
process restarted.

### `DeadLetterAction`

Owns manual retry and dismiss. It preserves chat authorization, stale/missing
outcomes, reply and recovery mutations, quarantine release, lane refresh, and the
audit row. Retry resets only the existing retry fields; dismiss clears effect
certainty exactly as today.

## Pure policies and payload helpers

Pure helpers may be extracted for effect-certainty normalization, lane
classification, stream page-index decoding, and lightweight Answer-card payload
rewriting. They accept values and return values; they do not query SQLite, enqueue
work, render cards, or refresh lanes. Invalid payloads retain current error text.

No generic recovery framework is introduced. Each proof remains named in the
ubiquitous language of the durable effect it settles.

## Transaction discipline

Internal modules never call `transaction()`, create a connection, commit, or
publish an external effect. The facade retains the existing outer transaction for
each public atomic operation. Queue and delivery collaborators reuse the same
context and their current nested-transaction semantics.

The following orderings remain indivisible:

- failure mutation, recovery ledger, quarantine, cooldown, and lane refresh;
- Answer state rollback/rebuild, replacement intent, recovery settlement,
  quarantine release, and lane refresh;
- supersession proof settlement, obsolete-intent dismissal, quarantine release,
  and lane refresh;
- manual reply mutation, recovery mutation, quarantine release, lane refresh, and
  audit.

If any required mutation fails, the whole public operation rolls back.

## Recovery and error behavior

- `not-started` effects may follow the existing retry path.
- `rejected` effects may be retried or dismissed only where the current recovery
  kind and lane policy permit it.
- `uncertain` effects remain quarantined unless an exact durable supersession or
  terminal proof exists.
- Missing or stale manual actions return their existing outcome and still record
  the existing audit event.
- Startup recovery remains idempotent; a second pass reports zero additional work.
- All current action strings and diagnostic counters remain unchanged.

## Testing and architecture enforcement

Existing SQLite and outbox dispatcher tests remain the behavioral authority. The
implementation adds focused characterization only where a branch or rollback is
not directly asserted. Architecture tests enforce that:

- only `SqliteOutboxRecoveryStore` constructs internal recovery modules;
- files outside the facade/internal directory cannot import them;
- internal modules cannot import coordinators, events, composition, adapters, or
  concrete Gateway implementations;
- internal modules cannot create `SqliteContext` or start transactions.

Final verification includes focused recovery tests, the full Vitest suite,
typecheck, build, architecture check, documentation audit, public audit, and
`git diff --check`.

## Non-goals

- No schema or migration changes.
- No new retry, recovery, or notification behavior.
- No change to Lark payloads, CardKit rendering, or Gateway calls.
- No in-memory queue or second durable authority.
- No public port, composition topology, or operator command changes.
- No push, installation, or service restart as part of this refactor.
