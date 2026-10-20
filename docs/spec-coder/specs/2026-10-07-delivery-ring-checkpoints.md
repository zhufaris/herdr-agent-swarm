# Delivery Ring Checkpoints

Status: Revised Gate 1 R3-lite design and revised Gate 2 specification approved.

## Problem Statement

Swarm has two durable progress concepts with different names and ownership.
Conversation Projection persists an opaque Core cursor per exact session lane,
while the per-Primary-Pane Delivery Engine reconstructs work by repeatedly
querying the earliest nonterminal outbox row for every delivery scope. Its
process-global scope pagination value is also named `cursor` even though it is
only an ephemeral page token and is not durable progress.

The current Delivery Ring remains correct because SQLite is authoritative and
every effect is conditionally claimed, but restart/refill has no explicit
durable statement of the terminal prefix already consumed by each Pane or the
Global scope. This makes cursor/checkpoint terminology inconsistent, weakens
resume observability, and leaves terminal-prefix advancement distributed among
ACK, dismissal, replacement, quarantine and recovery transitions.

The existing head query already filters to `pending` and unresolved
`dead_letter` rows. A Delivery checkpoint therefore cannot and must not skip an
old row merely because it is old. Ancient nonterminal work remains actionable
until existing supersession, explicit dismissal, completed replacement or
human recovery proves a terminal outcome.

## Solution

Introduce one shared discriminated Checkpoint model while retaining separate
context-specific persistence and position types:

```ts
type ConsumerCheckpoint =
  | {
      consumer: "core-projection";
      scope: CoreLaneIdentity;
      position: { kind: "core-cursor"; value: string };
      updatedAtMs: number;
    }
  | {
      consumer: "delivery-ring";
      scope: DeliveryScope;
      position: { kind: "delivery-order"; value: number };
      updatedAtMs: number;
    };
```

Core Projection continues to store and transport its opaque Core cursor in the
existing `core_event_lane_checkpoints` table. Delivery adds an empty
`delivery_ring_checkpoints` table keyed by immutable Delivery Scope and stores
the greatest `delivery_order` whose scope-local prefix is durably terminal.
There is no generic checkpoint table and no Core checkpoint data migration.

Each Primary Pane scope owns one checkpoint, identified by
`workspaceId + primaryPaneId`. Worker delivery uses its trusted parent Primary
scope. Work without a trusted Primary scope uses the single Global checkpoint.
Owner/session generations remain per-delivery claim fences and never partition
the Ring or checkpoint. `/swarm clear` retains the same scope; `/swarm reset`
creates a new Primary Pane and therefore a new checkpoint.

An existing scope initializes lazily in one SQLite transaction. If it has a
nonterminal head, the initial checkpoint is immediately before that head's
`delivery_order`; if it has none, the checkpoint is the scope's current maximum
order, or zero for an empty scope. Initialization neither rewrites historical
outbox rows nor guesses that nonterminal work is complete.

Prepared Delivery reconciles the checkpoint from current outbox truth inside
the refill transaction. It locates the earliest authoritative nonterminal row,
sets the safe watermark immediately before that row, and returns the same row
as the scope head. The watermark may move forward when terminal work was not
checkpointed, or backward when manual retry/recovery reopens older work. R2's
ACK and safe-supersession updates remain an optional fast path, never a
correctness dependency. In-memory Rings remain disposable caches of full
`PreparedDelivery` values; claims, Gateway checkpoints, effect certainty,
idempotency and SQLite state remain authoritative.

## User Stories

- **SCN-1 — Fresh scope:** The first committed delivery for a new Pane creates
  or observes checkpoint zero, enters the Pane Ring after commit, and advances
  the checkpoint only after its durable terminal transition.
- **SCN-2 — Existing scope bootstrap:** On first access after upgrade, a scope
  with historical terminal rows and one nonterminal head initializes directly
  before that head without rewriting history or skipping it.
- **SCN-3 — Empty existing scope:** A scope with only terminal history
  initializes at its current maximum order; a later committed delivery has a
  greater order and remains discoverable after a missed enqueue notification.
- **SCN-4 — Fast ACK:** Gateway acknowledgement and required provider/delivery
  checkpoints still commit atomically with the outbox terminal state. The hot
  path may also advance the Delivery checkpoint; if that optional update is
  missed, the next refill reconciles it from outbox truth.
- **SCN-5 — Terminal alternatives:** Explicit dismissal, safe supersession and
  a dead letter with a durably completed exact replacement change authoritative
  outbox/recovery state only. Refill derives the resulting safe watermark
  without requiring those writers to call a checkpoint module.
- **SCN-6 — Blocking uncertainty:** An uncertain effect, unresolved dead
  letter, incomplete replacement or active human-review quarantine prevents
  checkpoint advancement for its scope but not another Pane or Global scope.
- **SCN-7 — Restart/refill:** Startup, safety scan, retry wake and missed
  enqueue recovery reconcile the durable scope checkpoint against the earliest
  current nonterminal row, then preserve strict scope order and existing 3:1
  cross-Ring live/history fairness.
- **SCN-8 — Pane lifecycle:** Worker generations and `/swarm clear` continue in
  the parent Primary Pane checkpoint; `/swarm reset` uses the new Pane's new
  checkpoint and never retargets old-scope effects.
- **SCN-9 — Compatibility:** A database upgrade creates only an empty Delivery
  checkpoint table. Core cursor values, outbox state and retained history are
  not migrated or rewritten.
- **SCN-10 — Ephemeral paging:** Process-global scope discovery may use a
  transient page token but never persists or presents it as consumption
  progress.
- **SCN-11 — Reopened older work:** If manual retry or recovery makes a row at
  or before the stored checkpoint nonterminal again, reconciliation moves the
  watermark backward to immediately before that row and exposes it as the Ring
  head. The repair may cause extra scanning but never loses work.

## Implementation Decisions

### Domain Model

Delivery and Operations owns the **Delivery Ring Checkpoint**: a durable,
rebuildable scan watermark derived from scope-local outbox/recovery truth. It
normally advances, but may rebase backward when older work becomes nonterminal
again. It is not a Gateway checkpoint, Core cursor, delivery attempt, Ring head,
irreversible commit log or retention watermark.

The relevant existing aggregate remains Prepared Delivery plus its durable
outbox/recovery evidence. The checkpoint is a derived projection maintained at
the Prepared Delivery seam; terminal writers outside that module do not depend
on it and it does not become a separate scheduler or source of effect truth.

The following invariants are normative:

- **INV-1 — Typed positions:** Core cursor and Delivery order share Checkpoint
  language but are never compared, copied or decoded across consumers.
- **INV-2 — Scope identity:** A Delivery checkpoint is keyed only by immutable
  Pane or Global Delivery Scope. Owner and session generations remain claim
  fences, not checkpoint identity.
- **INV-3 — Safe watermark:** A Delivery checkpoint never remains at or beyond
  the earliest scope row that is nonterminal under the authoritative
  terminal/replacement predicate.
- **INV-4 — Atomic reconciliation:** Recomputing the safe watermark, persisting
  it and selecting the corresponding head occur in one SQLite transaction.
  Terminal writers need not participate; a crash may leave the watermark stale
  but cannot make it skip work.
- **INV-5 — Rebasable position:** A Delivery position may advance or move
  backward to `earliestNonterminal - 1`. A backward rebase is a safe recovery
  event and never changes outbox state.
- **INV-6 — Conservative bootstrap:** Lazy initialization places the checkpoint
  before the earliest nonterminal scope row. Age, generation drift and a newer
  snapshot alone are not terminal proof.
- **INV-7 — Uncertainty blocks:** Uncertain effects and active human-review
  quarantine remain nonterminal until existing recovery records prove a
  terminal outcome.
- **INV-8 — Durable-first Ring:** Memory Ring contents are dispensable. Startup,
  overflow, missed notifications and retry timers converge from SQLite.
- **INV-9 — No Agent replay:** Delivery checkpoint recovery never submits or
  repeats Agent Input and cannot change Core conversation order.
- **INV-10 — Ephemeral pagination:** Scope scan page tokens are local to one
  bounded read and are never stored as Checkpoints.

### Architecture

A small domain module owns the discriminated Checkpoint vocabulary and valid
position construction. Context-specific ports retain their meaningful
operations: Core event ingestion continues to accept opaque Core cursors;
Prepared Delivery storage owns Delivery checkpoint initialization and
reconciliation because only it already evaluates the authoritative
outbox/recovery nonterminal predicate and selects Ring heads.

The Delivery checkpoint adapter persists at least:

```text
scope_key PRIMARY KEY
scope_kind
scope_workspace_id NULLABLE
scope_pane_id NULLABLE
committed_delivery_order INTEGER >= 0
created_at
updated_at
```

The stored scope fields must reconstruct exactly the same `DeliveryScope` and
normalized `scope_key`; malformed or conflicting rows fail closed. The Global
row has no workspace/Pane fields. Pane rows require both.

The Prepared Delivery store exposes deep operations rather than a generic
table API:

- load or lazily initialize the exact scope checkpoint and its first
  nonterminal head;
- page current scope heads after each scope's checkpoint;
- reconcile one scope watermark and select its head in one transaction;
- page authoritative scope heads while reconciling only the bounded scopes in
  that page;
- optionally advance from ACK/safe supersession as a fast optimization;
- report a bounded checkpoint snapshot for operations.

The Delivery Engine consumes complete results and never calculates a durable
position. SQLite reuses one authoritative nonterminal predicate for bootstrap,
reconciliation, head selection and claim order so these paths cannot disagree.
Composition wires the existing SQLite adapter to the existing Delivery Engine
port; presentation and Gateway SDK layers do not import checkpoint storage.

Rename the refill interface's process-local `cursor` / `nextCursor` fields to
`pageToken` / `nextPageToken`. This token remains a scope-key pagination value
used only during one bounded scan. It does not cross the domain checkpoint
interface and is not persisted.

### Behavior & Failure Modes

Lazy initialization runs under a transaction and exact scope key. For a first
nonterminal order `N`, the initial position is `max(0, N - 1)`; gaps from other
scopes are harmless because the position is interpreted only with the same
scope. With no nonterminal row, initialization uses the scope's current maximum
order or zero. A concurrently inserted delivery receives a globally greater
order and therefore remains after the checkpoint.

At refill, SQLite finds the earliest current nonterminal order `N` for the
scope. The safe checkpoint is `max(0, N - 1)`, or the current scope maximum when
no nonterminal row exists. If the stored position is behind, it advances; if it
is ahead because older work was reopened, it rebases backward. The update and
head selection share one transaction.

Retryable and uncertain failure remains nonterminal. A rejected or permanent
failure also remains nonterminal while its dead letter/recovery is unresolved.
Explicit dismissal or completed replacement changes that authoritative
predicate; no callback into checkpoint storage is required. A terminal writer
transaction can commit even if checkpoint state is stale, because the next
refill derives the safe value again.

Startup and periodic refill continue to use the indexed authoritative head
query across the whole scope; they do not trust `delivery_order > checkpoint`
until after reconciliation. The in-memory cache may be empty or stale; a
conditional claim still verifies exact scope head, plan hash, snapshot,
owner/session fence, prerequisites, quarantine and Gateway cooldown. A missed
post-commit enqueue or below-watermark retry is recovered by the next bounded
scan.

### Compatibility & Migration

- Add one empty `delivery_ring_checkpoints` table and supporting indexes through
  the normal idempotent schema migration path.
- Do not backfill checkpoint rows during migration; each scope initializes on
  first use.
- Do not move or rewrite `core_event_lane_checkpoints`.
- Preserve all `outbound_replies`, recovery, quarantine, Gateway plan and
  checkpoint data.
- Keep existing public Delivery Engine methods and Feishu behavior unchanged.
- Internal refill page-token field names change atomically across their callers.
- No checkpoint pruning policy is introduced in this change; the number of
  rows is bounded by observed Delivery scopes and empty historical rows are
  harmless.

### Observability

Extend the Delivery snapshot/status projection with bounded aggregate evidence:

- initialized checkpoint scope count;
- lazy initialization count;
- last checkpoint advancement time;
- forward reconciliation and backward rebase counts;
- lowest blocking nonterminal age/order without exposing payloads;
- counts blocked by uncertain effect or active quarantine.

Logs may include scope key, checkpoint order and blocking reply identity under
existing identifier policy, but never Gateway payloads, credentials or prompt
text.

## Testing Decisions

- Domain tests prove typed Core/Delivery positions cannot be mixed and reject
  invalid Delivery orders.
- SQLite migration/reopen tests prove the table is added idempotently and no
  historical outbox/Core checkpoint row is rewritten.
- Bootstrap tests cover empty scope, terminal-only history, earliest pending,
  unresolved dead letter, completed replacement, interleaved global order gaps,
  competing SQLite handles and rollback.
- Settlement tests retain R2 evidence that ACK/safe supersession can advance the
  fast-path position without making other terminal writers depend on it.
- Reconciliation tests cover stale-behind advancement, below-watermark manual
  retry and backward rebase, uncertain effect, active quarantine, explicit
  dismissal, completed replacement, process reopen and missed enqueue without
  Gateway or Agent Input duplication.
- Delivery Engine tests prove startup/safety/retry scans use durable positions,
  retain per-scope serialization and 3:1 live/history fairness, and treat scan
  page tokens as ephemeral.
- Query-plan tests prove bootstrap/refill/advance use existing or new bounded
  scope/order indexes under a production-shaped skewed backlog.
- Operations tests verify checkpoint counts/lag/blocking evidence is bounded and
  payload-free.
- Run focused Prepared Delivery, Ring recovery/hot-path, migration, status and
  concurrency tests, then `npm run typecheck`, `npm run architecture:check`,
  `npm run build`, `npm run public:audit`, and the full Vitest suite.

## Out of Scope

- Skipping or deleting old pending, uncertain or quarantined work solely by
  age, generation or snapshot revision.
- A generic physical checkpoint table or migration of Core checkpoint data.
- Replacing durable outbox state with an in-memory Ring or checkpoint payload.
- Changing Delivery Scope identity, adding Worker Rings, or adding generation
  to Ring identity.
- Changing Core, Gateway or Feishu public protocols.
- Production installation, restart, live database mutation or historical data
  cleanup.
- Checkpoint-row retention/pruning.

## Further Notes

- Workspace: `/workspace/herdr-agent-swarm`.
- Mode: in-place; tracked files were clean when this specification was written.
- Branch and implementation starting revision: `main` at `a80bcce2`. The five
  intervening Pane-only Choice commits are accepted separate work and are not
  part of the Ring change.
- Preserved initial untracked paths: `.tmp-build/`,
  `docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- Fresh baseline after the separate Choice delivery: `npx vitest run
  --maxWorkers=1` passed 286 files / 4,120 tests; `npm run typecheck`,
  `npm run architecture:check`, `npm run build`, and `npm run public:audit`
  passed.
- `npm run docs:audit` remains blocked only by stale links in the pre-existing
  untracked research document named above.
- Gate 1 first approved explicit terminal-writer advancement. Implementation
  evidence showed that terminal writers are distributed across many stores;
  revised Gate 1 approved R3-lite: checkpoint is a derived, rebasable watermark
  reconciled at the Prepared Delivery refill seam, with R2 retained only as a
  fast-path optimization.
