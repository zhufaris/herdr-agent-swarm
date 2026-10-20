# Input-to-Card Latency and Stable Subagent Identity

<!-- spec-coder:artifact-v1 spec -->

Status: Gate 1 design, Gate 2 specification, and Gate 3 implementation plan
approved by the user on 2026-10-10.

## Problem Statement

The durable input-to-card path preserves the required SQLite Outbox, disposable
per-scope Delivery Rings, and checkpoint recovery model, but its current
refill path can hold the SQLite writer lock while performing expensive scope
head discovery and repeated hydration. On the live service, a backlog of
10,611 pending Outbox Entries across nine scopes produced repeated
`sqlite.prepared-delivery-store.write` transactions of roughly 0.8 to 2.1
seconds. During those transactions, unrelated interactive ingress and card
projection work waits behind recovery-oriented discovery.

The same path lacks a low-cardinality end-to-end latency trace. Current logs
can show isolated ingress, SQLite, projection, Ring, or Gateway events, but do
not reliably attribute one visible card update to its durable input and stage
delays without inspecting payload-bearing records.

Session Activity also conflates bounded presentation rows with durable
Subagent identity facts. A live turn spawned 15 Subagents. The eight-item
active presentation bound physically pruned some earlier agent rows. When a
later sparse `wait_agent` or `close_agent` result recreated a pruned terminal
agent, only its UUID and state were available. For example, agent
`01a12717-dd35-7e53-830a-5e7b060cafb1` had authoritative spawn metadata
`Boyle` and `GPT-5.6-Luna`, but its stored terminal item became
`01a12717-dd35-7e53-830a-5e7b060cafb1 · completed`.

No new Delivery Ledger is required. SQLite remains the durable authority;
Delivery Rings remain disposable process-local scheduling and execution
queues; existing delivery checkpoints remain derived recovery accelerators.

## Solution

Split delivery refill into three explicit phases:

1. read-only discovery selects only the bounded IDs and scheduling metadata
   needed to identify one authoritative head per scope;
2. one bounded batch hydration reads the selected work without one query per
   scope;
3. a short fenced compare-and-swap transaction validates that discovery is
   still current before changing a claim, checkpoint, or recovery state.

Read-only discovery never runs under `BEGIN IMMEDIATE`. Stale discovery is a
normal retry outcome, not permission to weaken scope ordering, prerequisites,
owner fencing, replacement rules, or uncertain-effect handling. Interactive
work is allowed to make progress between bounded recovery/refill pages.

Add a payload-free Delivery Trace that carries stable correlation identities
and monotonic timestamps across durable ingress, canonical Core projection,
Outbox preparation, Ring grant, Gateway acknowledgement, and local settlement.
The trace produces structured stage-duration metrics and diagnostics without
persisting human text, model output, card JSON, or provider payloads.

Separate Subagent Identity from the bounded Session Activity presentation
list. A binding/session-fenced identity fact stores the latest known bounded
display name and model for each agent ID. Spawn evidence enriches this fact;
sparse wait/close events may change lifecycle state but cannot erase known
identity. Presentation pruning may remove visible active or terminal rows, but
must not remove identity facts that are still valid for the owning
binding/session. If a later lifecycle event makes a pruned agent visible
again, the item is rebuilt from the identity fact. Retained recovery uses the
same reducer and merge rule as live projection.

## User Stories

### SCN-1: Fast durable ingress during a delivery backlog

When the Outbox contains a large skewed backlog, an ordinary Feishu message
can still reach durable acceptance without waiting for a multi-second scope
discovery writer transaction.

### SCN-2: Read-only bounded scope discovery

When a Ring refill scans many scopes, discovery returns only bounded head
identity and scheduling metadata. It does not select `head.*`, render a card,
hydrate provider payloads, or acquire the SQLite writer lock.

### SCN-3: Batch hydration without N+1 reads

When a discovery page contains multiple scope heads, the selected entries are
hydrated with a bounded number of statements independent of the number of
heads. Query count does not increase by one extra hydration query per scope.

### SCN-4: Stale discovery loses safely

If another transaction changes a head, prerequisite, owner fence, replacement,
claim, due time, or checkpoint after discovery, the short CAS rejects the stale
candidate. The refill loop rereads current state and never delivers the stale
effect.

### SCN-5: Ordering and uncertainty remain unchanged

Entries in one Delivery Scope retain the current ordering, conflict bypass,
prerequisite, quarantine, replacement, checkpoint, and owner-fence semantics.
A possible remote effect remains uncertain and is never automatically replayed
without positive safe-retry evidence.

### SCN-6: Interactive work has priority over maintenance

When interactive ingress, projection, or Ring work is pending, background
refill and recovery stop after their current bounded page and reschedule with
bounded backoff. Maintenance cannot monopolize the SQLite writer.

### SCN-7: Payload-free latency attribution

For one accepted input and its visible card updates, operators can correlate
stage timestamps and durations using IDs already safe for structured logs.
No message text, answer text, CardKit JSON, frozen Presentation Snapshot, or
secret-bearing provider response is added to logs or a new ledger.

### SCN-8: Stable live Subagent identity

After spawn reports `{agent_id, nickname}` and the spawn request records a
model, later wait/close events display `nickname · model` even if those events
contain only agent ID and state.

### SCN-9: Stable identity after presentation pruning

If more agents are active than the visible Session Activity limit, pruning the
visible list does not erase identity facts. When a previously hidden agent
completes, it reappears as `Boyle · GPT-5.6-Luna`, not as its UUID.

### SCN-10: Stable identity after restart and retained recovery

After SQLite reopen, retained settled spawn plus sparse wait/close evidence is
reduced deterministically to the same name, model, and terminal state as live
projection. Repeated recovery is idempotent and does not duplicate visible
agents or mutate Core records.

### SCN-11: Honest fallback for genuinely unknown identity

If no valid spawn, explicit agent activity, or persisted identity fact exists,
the UUID remains an allowed fallback. The system does not invent a name or
model and records a low-cardinality missing-identity diagnostic.

## Implementation Decisions

### Domain Model

Delivery discovery returns a narrow immutable candidate rather than a hydrated
Gateway effect:

```ts
type DeliveryHeadCandidate = Readonly<{
  replyId: string;
  scopeKey: string;
  deliveryOrder: number;
  stateVersion: number;
  dueAt: string | null;
  ownerFenceHash: string;
  prerequisiteVersion: number;
}>;
```

The exact fields may map to existing columns rather than introduce literal
hash/version columns, but the CAS must compare every mutable fact whose change
can invalidate eligibility. The discovery result is advisory. Only the fenced
write authorizes claim or checkpoint mutation.

`PreparedDeliveryScopePage` continues to expose complete Ring work to its
consumer, but the store constructs it from narrow discovery plus batch
hydration. The port does not expose raw SQLite rows or ask the Ring to enforce
durable correctness.

A Subagent Identity Fact is durable projection state, not a new source of
truth:

```ts
type SessionAgentIdentity = Readonly<{
  scopeKey: string;
  producerKind: "primary" | "worker";
  producerId: string;
  producerGeneration: number;
  producerSessionGeneration: number;
  agentId: string;
  displayName: string | null;
  model: string | null;
  sourceLaneSequence: number;
  sourceEventId: string;
}>;
```

It is fenced by the same producer and binding/session identity as Session
Activity. Newer sparse events preserve known fields; newer explicit non-empty
identity fields may enrich them. Old-generation or old-session evidence is
rejected. Deleting or replacing the owning snapshot removes its identity facts
transactionally.

The following invariants are normative:

#### INV-1: Durable authority remains SQLite

The Outbox Entry, durable projection state, identity facts, and checkpoints are
authoritative. Ring contents and refill candidates are disposable.

#### INV-2: Discovery performs no durable mutation

Head discovery runs outside the writer transaction and cannot claim, advance a
checkpoint, settle, supersede, quarantine, or recover work.

#### INV-3: Short fenced mutation

Every mutation derived from discovery validates current row identity,
eligibility, ordering, prerequisites, replacement state, effect certainty, and
owner fence in one short transaction.

#### INV-4: Bounded query count

One refill page uses a bounded number of statements independent of scope count;
there is no per-head hydration loop.

#### INV-5: No cross-system exactly-once claim

The optimization does not change remote-effect certainty. A provider effect
that may have happened remains non-replayable under the existing contract.

#### INV-6: Presentation bounds do not erase identity

Pruning Session Activity items may change visibility only. It cannot destroy a
known name/model needed to render a later state transition in the same fenced
session.

#### INV-7: Identity is monotonic within a session fence

An omitted name or model preserves the prior non-empty value. A UUID fallback
is presentation of missing evidence, not a value that overwrites known
identity.

#### INV-8: Live and retained reduction agree

The same lifecycle translator and identity merge policy process live correlated
tool pairs and retained settled pairs. Restart cannot produce a weaker label
than the equivalent uninterrupted run.

### Architecture

The affected flow is:

```text
Lark event
  -> durable inbound acceptance
  -> Core canonical event/checkpoint
  -> projection + Outbox Entry
  -> read-only narrow scope discovery
  -> bounded batch hydration
  -> short fenced CAS
  -> disposable per-scope Ring
  -> Feishu Gateway
  -> SQLite-local settlement/checkpoint
```

`src/store/sqlite/prepared-delivery-store.ts` owns discovery, hydration, and
fenced mutations. `src/events/ring-delivery-engine.ts` continues to consume
complete work and does not gain SQL knowledge. The current Outbox schema and
checkpoint remain the only durable delivery queue and recovery cursor.

Latency correlation is attached at existing domain and log boundaries rather
than through a parallel event store. Existing identifiers such as event ID,
binding ID, segment/page identity, reply ID, scope key, and provider request or
receipt identity are propagated where already available. Metrics use bounded
stage and outcome dimensions; UUIDs remain log correlation fields rather than
metric labels.

`src/runtime/multi-agent-tool-lifecycle.ts` remains the protocol adapter for
spawn/wait/close evidence. `src/store/sqlite/session-activity-store.ts` owns
identity merge, fencing, visible item reconstruction, pruning, and retained
recovery. Card renderers continue to consume `SessionActivityView` and do not
read tool payloads or identity tables directly.

### Behavior and Failure Modes

- A discovery read that races with settlement or a newer revision returns a
  stale candidate; CAS returns a typed stale outcome and makes no mutation.
- A batch containing one corrupt or missing row isolates that row under the
  existing poison/gap behavior; it does not silently skip a blocking head.
- Ring enqueue failure after commit remains recoverable by refill.
- Process exit between discovery and CAS loses no work.
- Process exit after CAS but before Ring enqueue follows the existing claim and
  uncertain-effect recovery rules; this change does not infer an external call.
- Background maintenance yields between pages when interactive work is
  observed; a periodic safety scan remains the convergence fallback.
- A malformed or truncated spawn result creates no identity fact.
- A sparse terminal event with no identity fact may show UUID, but emits a
  bounded missing-identity diagnostic and remains eligible for later retained
  enrichment.
- Conflicting older-session identity is ignored rather than merged.

### Compatibility and Migration

The delivery change is an internal store/port refactor. Existing prepared and
semantic Outbox rows, frozen plans, Ring scopes, retries, replacements,
quarantines, and checkpoints remain valid. No Delivery Ledger, durable Ring
snapshot, or second delivery queue is introduced.

The identity change uses an additive SQLite migration for a companion identity
projection (or an equivalent normalized identity representation). Existing
Session Activity rows continue to render. Startup retained recovery may enrich
identity facts only from exact, settled, uncompacted, uniquely correlated tool
pairs under the active binding/session fence. Migration never scans or rewrites
human/model payloads into logs.

## Performance and Observability Targets

The first implementation wave targets these p95 stage budgets under a healthy
Gateway, excluding model generation time:

- Feishu ingress to durable acceptance: less than 100 ms;
- canonical Core event to projection commit: less than 200 ms;
- projection commit to Ring grant: less than 200 ms;
- Ring grant to Feishu acknowledgement: less than 500 ms;
- canonical Core event to visible card acknowledgement: less than 1 second.

Tests must prove structural bounds even when wall-clock SLOs are not stable in
CI: no writer transaction around discovery, bounded statement count per page,
bounded CAS duration inputs, and maintenance yielding at page boundaries.

Operational diagnostics must expose, without payloads:

- per-stage latency and outcome;
- discovery page size and duration;
- batch hydration statement count and missing/corrupt count;
- stale CAS count;
- writer transaction duration by operation;
- maintenance yield/reschedule count;
- missing Subagent identity count and retained enrichment count.

## Testing Decisions

### Baseline

At starting revision `8fa321c5162207cdb3673ce8a6c744fda5ab78e6`:

- `npm run typecheck` passed;
- `npm run build` passed and generated build identity
  `sha256:33e42362d19788659cfa18e52fc4abf34d721c34cde218175044334d6534b2d2`;
- `npm test` executed the visible suite without a reported failed test, but the
  Vitest process did not exit after sustained silence and was interrupted with
  exit 130. This is recorded as a non-green full-suite baseline and must be
  rechecked during delivery rather than concealed.

### Delivery Refill Tests

Focused tests in `tests/prepared-delivery-store.test.ts` and the Ring recovery
suites must prove:

- discovery is read-only and does not begin an immediate/write transaction;
- a 64-scope page uses a bounded statement count with no per-scope hydration;
- skewed backlogs retain the authoritative earliest nonterminal head;
- stale discovery loses to claim, settlement, supersession, prerequisite,
  replacement, and owner-fence changes;
- same-scope ordering, independent conflict bypass, Global scope behavior,
  retry wakeups, quarantine, dead letter, and checkpoint rebasing are unchanged;
- restart and missed enqueue reconstruct the same complete Ring work;
- maintenance yields to interactive work without losing eventual convergence.

### Latency Trace Tests

Tests must prove:

- correlation survives ingress, projection, Outbox, Ring, and settlement paths;
- duration calculations are monotonic and tolerate a missing optional stage;
- metrics have bounded label cardinality;
- structured logs and persisted trace data contain no message text, answer
  text, tool result, card JSON, Presentation Snapshot, credential, or token.

### Subagent Identity Tests

`tests/session-activity-store.test.ts` gains a fixture based on the observed
modern lifecycle sequence:

1. 15 spawn calls are projected before their 15 results;
2. Boyle's spawn call requests `GPT-5.6-Luna` and its result reports
   `{agent_id: "01a12717-dd35-7e53-830a-5e7b060cafb1", nickname: "Boyle"}`;
3. active presentation pruning removes Boyle's visible item;
4. a later wait/close result contains only agent ID and terminal state;
5. the rebuilt terminal item is `Boyle · GPT-5.6-Luna`;
6. SQLite is closed and reopened, retained recovery is rerun, and the same
   label/state remains without duplicates.

Additional tests cover explicit `agent_activity` enrichment, malformed spawn
results, unknown-identity UUID fallback, old session fences, terminal-over-
nonterminal precedence, compaction, idempotent repeated recovery, and deletion
of identity facts with their owning projection.

### Verification Commands

Each implementation ticket runs its nearest focused Vitest files. Final
delivery runs:

```bash
npx vitest run tests/prepared-delivery-store.test.ts
npx vitest run tests/session-activity-store.test.ts
npx vitest run tests/ring-delivery-recovery.test.ts
npm run typecheck
npm run build
npm test
```

The full-suite open-handle baseline must either be fixed by an in-scope cause
or reported separately with evidence; it is not permission to omit focused
verification.

## Out of Scope

- adding a Delivery Ledger, durable Ring snapshot, second MQ, or alternate
  delivery authority;
- claiming cross-system exactly-once delivery;
- automatically replaying uncertain Feishu effects;
- changing CardKit visual design, pagination policy, or provider-neutral
  Presentation Snapshot semantics;
- globally parallelizing inbound routing or Core event projection in this
  first wave;
- optimizing repeated Turn Card renders, answer-page serialization, or the
  250 ms debounce in this first wave;
- changing the user-visible active/terminal Session Activity limits;
- inferring Subagent model from child transcript files at runtime. Runtime
  identity comes from canonical parent tool/lifecycle evidence.

## Further Notes

- The selected delivery design is approach A: read-only narrow discovery,
  bounded batch hydration, and a short fenced CAS.
- The live Subagent evidence confirms the expected final label is
  `Boyle · GPT-5.6-Luna`; the UUID-only label is not an acceptable terminal
  representation once that spawn evidence was durably observed.
- Secondary latency findings remain valid candidates for later waves: repeated
  full Turn Card rendering, approximately quadratic answer-page measurement,
  trailing debounce without a maximum age, one-event Core projection, and
  globally sequential inbound routing.
- Gate 2 approval authorizes planning only. Implementation tickets and code
  changes begin after this specification is approved.
