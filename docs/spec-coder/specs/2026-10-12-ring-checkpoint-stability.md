# Ring and Checkpoint Stability

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

The current SQLite-first Delivery Ring and Core session-lane checkpoint design
is sound, but several boundary races can still make the service appear stuck or
create unnecessary replacement work. A Delivery claim can expire while its
Gateway promise is still active. A physical Core session ring can be replaced
without changing the native session identity. Concurrent Core readers can lose
an `ingestBatch` CAS race while the reader reports the transport batch as
accepted. Untyped cursor failures and repeated global maintenance can also
leave one lane degraded for an unbounded time or delay unrelated delivery.

The target behavior is bounded loss over blocking: an uncertain external effect
is never blindly replayed, a broken lane is isolated, safe replaceable snapshots
may be coalesced, and no single claim or quarantine can block unrelated work or
produce a large replacement storm.

## Solution

Keep SQLite as the authority for intent, claims, Core inbox events, checkpoints,
gaps, quarantine and delivery state. Keep the in-memory ring disposable and
bounded. Add identity-fenced claim renewal while a Gateway call is active,
identity-fenced Core source replacement for the same terminal/agent/session,
and reader handling that reloads the durable checkpoint after `stale_rebase`.

Normalize unknown Core cursor failures into one bounded recovery attempt followed
by a durable lane gap and a source-notification-driven process cooldown; do not invent cursors. Run global quarantine and
snapshot maintenance once per safety cycle instead of once per refill page.
Allow only unclaimed, replaceable Main snapshots to be coalesced, with bounded
batch and target-safety checks. Preserve stream ordering and all uncertain
effect no-replay rules.

## User Stories

### SCN-1: A slow Gateway call remains one claim

When a Gateway call is still active near its claim deadline, the engine renews
the exact claim under the current instance lease. The call may settle normally
without creating a replacement or quarantine solely because it was slow.

### SCN-2: A lost claim fence never causes automatic replay

When claim renewal or settlement loses its fence, the original effect is
classified as uncertain/stale and is not re-submitted automatically. The active
promise may finish, but its late result cannot mutate a different claim.

### SCN-3: A physical Core ring is replaced without changing session identity

When a fresh v2 ring has a different physical source ID but the current
terminal, agent kind and native session remain exact, SQLite performs one CAS
source transition, records a bounded projection gap, and resumes from Core's
explicit safe boundary. A different session or agent identity still fails
closed.

### SCN-4: A concurrent Core reader loses its checkpoint race

When `ingestBatch` returns `stale_rebase`, the reader does not count the batch or
report transport-level catch-up. It reloads the durable cursor and continues
from the winner's checkpoint with a bounded retry.

### SCN-5: An untyped cursor failure cools down one lane

An untyped `invalid_cursor` may be retried once after reopening the verified
source. If Core supplies no safe resume evidence, the lane records a durable
gap and enters an in-memory cooldown that is released by a new source
notification or explicit recovery. It does not hot-loop and does not block
other lanes.

### SCN-6: Maintenance does not repeatedly lock SQLite

Global quarantine cleanup and safe snapshot coalescing run in one bounded
maintenance pass per safety cycle. Scope-page loading remains short and
scope-local, so a large backlog does not repeatedly delay live delivery.

### SCN-7: Live delivery can bypass disposable historical snapshots

An arriving live item may invalidate unclaimed replaceable historical snapshot
references in the same in-memory scope ring and trigger a durable refill. It
never reorders stream content/finish or bypasses an unresolved same-conflict
effect.

## Implementation Decisions

### Domain Model

The affected bounded contexts are Delivery and Canonical Core Session Ingestion.

Observed authoritative objects remain:

- a Delivery claim, fenced by attempt, owner, instance lease, plan hash and
  snapshot revision;
- a Core event lane checkpoint, fenced by lane, source, epoch, agent kind,
  session and read cursor;
- a durable projection gap describing bounded loss or recovery ambiguity;
- a disposable process-local Ring reference.

New operations are explicit: Claim Renewal, Core Source Transition, Cursor
Cooldown, and Historical Snapshot Coalescing. They are not inferred from cards
or from arbitrary transport errors. SQLite owns atomic state transitions; the
reader and engine own bounded coordination; adapters only normalize external
payloads and errors.

The invariants are:

#### INV-1: Active claim renewal is exact and lease-bound

A live Gateway promise keeps its exact claim renewable only while
  the instance lease and claim fence still match.

#### INV-2: Uncertain claims are never automatically replayed

An expired claim is not treated as safe to replay; uncertain
  effects never receive an automatic replacement.

#### INV-3: Core source transition preserves stable session identity

A Core source transition changes only physical source identity
  when terminal, agent kind and native session evidence remain exact.

#### INV-4: Checkpoint changes are fenced CAS operations

Every checkpoint advance or source transition is a SQLite CAS;
  losing readers reload durable state and never count rejected batches.

#### INV-5: Unknown cursors never advance durable progress

Unknown cursor errors never advance a checkpoint without explicit
  Core resume evidence.

#### INV-6: Maintenance is bounded and lane-isolated

Maintenance is bounded by batch, scope and cycle; one failing lane
  cannot hold a process-wide execution permit or SQLite write loop.

#### INV-7: Coalescing applies only to safe replaceable snapshots

Only unclaimed, replaceable, non-prerequisite snapshots with a
  newer safe target may be coalesced; stream ordering and uncertain effects are
  excluded.

#### INV-8: Core and Delivery order remain authoritative

Core events remain in Core order and Delivery checkpoints remain
  monotonic/contiguous; no Feishu output is workflow authority.

### Architecture

`PreparedDeliveryStore` gains one exact-claim renewal operation. The Delivery
Engine starts a short-lived renewal timer immediately after a claim and stops it
in `finally`; renewal failure fences the local settlement but never initiates a
new Gateway call.

`CoreEventInboxStore` gains a source-transition CAS that validates the old
source/epoch/cursor and stable session identity, records one deterministic gap,
and updates the checkpoint to Core's safe transition cursor. The reader uses
this path only for v2 session rings and reloads the result before reading.

The reader checks `ingestBatch`'s result. `accepted` advances local counters;
`stale_rebase` reloads the durable checkpoint and retries within a small bound.
The adapter preserves typed `cursor_expired` and exposes a structured
`invalid_cursor` classification without fabricating a cursor. After one fresh
source reopen, the reader records a deterministic projection gap without
advancing the checkpoint. The supervisor keeps that owner in process-local
cooldown until a source notification or explicit recovery wakes it.

Global maintenance is separated from paged scope refill. The coalescing query
uses a bounded page, current-target compatibility and no active claim,
checkpoint, prerequisite or recovery dependency. The ring may discard only
unclaimed cache references and then refill from SQLite.

### Behavior & Failure Modes

Normal delivery is `claim -> renew while active -> checkpoint/ack`. A crash or
lost fence leaves SQLite evidence and does not replay an uncertain effect.

Normal Core recovery is `open -> compare identity -> source-transition CAS if
needed -> read -> ingest`. A stale CAS result always reloads SQLite. One source
transition and one typed retained-window rebase remain the maximum actions in a
single ingestion attempt. A second transition, missing safe cursor, or
ambiguous identity fails closed for bounded retry/cooldown.

Maintenance failure degrades only the maintenance pass and preserves existing
durable work. It must not delete claims or rewrite Core checkpoints outside the
explicit CAS operations. Coalescing is intentionally lossy but limited to
replaceable snapshots and emits counters for dismissed items.

### Compatibility & Migration

No new durable ledger is introduced. Existing claim, outbox, checkpoint and gap
tables remain compatible. Claim renewal is an additive store/port operation.
Source transition and cursor cooldown use existing checkpoint/gap structures;
if a new failure code is needed it is additive and deterministic. Existing
legacy streams retain their source identity checks. Production installation,
restart, database mutation and push are out of scope for this implementation
pass.

## Testing Decisions

Add focused Red-Green coverage at existing seams:

- Delivery Engine/Store: slow Gateway beyond the original TTL with successful
  renewals, failed renewal, lease loss, late settlement and no replacement;
- Core reader/Store: source ID replacement with stable session identity,
  identity mismatch rejection, competing transition winner, rollback, and
  `stale_rebase` reload without false catch-up/counts;
- Adapter/Supervisor: typed expiry remains unchanged, unknown invalid cursor
  performs one reopen/retry then enters lane cooldown;
- Maintenance/Ring: one global maintenance pass per cycle, bounded coalescing,
  stale-target protection, live cache invalidation, and preserved stream FIFO;
- architecture/import, typecheck, build, docs audit and full Vitest suite.

## Out of Scope

- Adding a Delivery Ledger or making the in-memory Ring durable;
- changing Herdr Core's ring protocol or Core JSONL ordering;
- automatic replay of uncertain Gateway effects or Agent Inputs;
- reordering stream content/finish operations;
- manual production SQLite edits, deployment, restart or push;
- dependency upgrades and unrelated Feishu/CardKit presentation changes.

## Further Notes

- Workspace: isolated Git worktree `/tmp/herdr-agent-swarm-ring-stability-20261012`.
- Mode: isolated because the original checkout contains user-owned uncommitted
  changes overlapping `prepared-delivery-store.ts` and its tests.
- Branch: `fix/ring-checkpoint-stability`.
- Starting revision: `76870059be2459eab7523a9d7546fb1ef92c3905`.
- Dependencies: `npm ci` completed from `package-lock.json`; npm reported seven
  pre-existing high-severity audit findings, not addressed here.
- Fresh baseline: build, test (298 files / 4453 tests), typecheck, architecture
  check (531 source files) and docs audit all passed. Captured evidence record
  IDs: build `0385b0efb5e4407cbb89b27fe7e1988d`, test
  `3365670d51714d049b5bc38389df8d8e`, typecheck
  `1f3c4ae7c2cb4788b8c04f7d4d73a465`, architecture
  `72e99ab1e5344fc7b8613fc9992b8b67`, docs
  `04f7fb808a7a499383eea39de130646f`.
- Approval: user selected `1` (fix issues) from the completed review gate; the
  implementation scope is limited to the findings and exclusions above.
