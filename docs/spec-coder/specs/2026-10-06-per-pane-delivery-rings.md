# Per-Pane Delivery Rings

Status: Gate 1 design and Gate 2 specification approved.

Reader: a future Swarm maintainer responsible for implementing and operating the outbound-delivery migration.

After reading this document, that maintainer should be able to decompose the migration into vertical implementation tickets without inventing ownership, ordering, recovery, or failure semantics.

## Problem Statement

The current delivery path has two scheduling layers with different units of work:

```text
durable outbox rows
  -> fine-grained delivery lanes in SQLite
  -> one process-global ring of lane-head references
  -> up to four concurrent Gateway deliveries
```

The global ring contains only `replyId`, lane identity, and live/history class. Every launch therefore reloads the row and materializes its Gateway intent. A wake invalidates all queued references and causes another database refill. The fine-grained lane topology also obscures the user-facing isolation boundary: independent effects for one Pane are spread across Answer, Main Card, Worker, thread, and projection-key lanes even though the desired operational unit is the Pane.

## Solution

The selected design makes the operational topology match Pane ownership:

```text
Conversation/Card Projection
  -> PreparedDelivery + Durable Outbox COMMIT
  -> Scope Router
  -> Primary Pane Ring x N / Global Ring x 1
  -> conditional claim
  -> Gateway execution
  -> durable settlement
```

Each Primary Pane has exactly one bounded in-memory Ring identified only by workspace and Primary Pane ID. Worker delivery shares its trusted parent Primary Pane Ring and never owns a separate Ring. Work without a trusted parent Primary Pane uses the one bounded Global Ring. A Ring item carries the complete frozen delivery plan and its owner-validity fence needed by the hot path. SQLite remains authoritative across restart, overflow, retry, missed notification, cooldown, and recovery.

### Goals

- Isolate a slow or failing Primary Pane from every other Primary Pane.
- Make one Primary Pane, including its Worker delivery, the visible ordering and backpressure scope.
- Remove the process-global payload-reference Ring and fine-grained delivery-lane scheduler.
- Avoid a row SELECT and Gateway-plan materialization on the normal post-commit path.
- Preserve durable outbox idempotency, plan freezing, claim fencing, checkpoints, retries, dead letters, and recovery.
- Preserve bounded live/history fairness between independently runnable Rings.
- Keep the public delivery interface small enough that projection callers cannot manipulate scheduler internals.
- Support an incremental, observable, reversible cutover.

## User Stories

- **SCN-1 — Hot commit:** a projection and prepared outbox row commit atomically; the returned object enters the correct Pane Ring and delivers without a row SELECT or plan re-materialization.
- **SCN-2 — Rollback:** a failed transaction returns no object and performs no external effect.
- **SCN-3 — Missed enqueue:** process death after COMMIT but before Ring enqueue converges through startup cold refill exactly once under existing idempotency guarantees.
- **SCN-4 — Pane isolation:** a blocked Primary Pane and its Workers do not delay another Primary Pane; a blocked Global head does not delay Primary Pane Rings.
- **SCN-5 — Strict scope order:** concurrent notifications, reversed arrival, and cold/hot duplicates cannot overtake the durable scope head.
- **SCN-6 — Fence replacement:** old Primary and Worker owner generations cannot deliver through their replacements and are never retargeted, but a fence change alone does not create another Ring.
- **SCN-7 — Overflow:** item, byte, and process caps spill safely to SQLite; cold refill later delivers in order.
- **SCN-8 — Retry/checkpoint:** transient failure, partial checkpoint, cooldown, and restart hydrate fresh objects with unchanged frozen plans and current retry/checkpoint state.
- **SCN-9 — Uncertain effect:** an uncertain head blocks its Ring until durable recovery resolves it; no successor executes.
- **SCN-10 — Fairness:** multiple runnable Rings observe 3:1 live/history grants without starving either class, while same-Ring FIFO remains absolute.
- **SCN-11 — Cross-Ring dependency:** a successor with an unmet durable prerequisite cannot claim even when its Ring is otherwise runnable.
- **SCN-12 — Migration:** shadow routing, cohort fencing, legacy debt handling, cutover, and pre-contraction rollback preserve every durable row.
- **SCN-13 — Safe head advance:** a replaceable Card-update head whose effect is durably proven not started or rejected may be superseded only by a newer same-target update with a higher `snapshotRevision`; dismissal, successor release, and head advance are one atomic transition.
- **SCN-14 — Pane lifecycle:** `/swarm clear` changes current delivery fences but keeps Primary and Worker work in the same parent Primary Pane Ring; `/swarm reset` creates a new Primary Pane and therefore a new Ring.

## Implementation Decisions

### Authority and Invariants

The following invariants are normative.

**INV-1 — Durable truth:** an in-memory Ring is a disposable hot-path copy. A committed outbox row is the authority for existence, identity, ordering, eligibility, retry, checkpoint, and settlement.

**INV-2 — Commit before enqueue:** a `PreparedDelivery` may enter a Ring only after the transaction that froze and persisted the same delivery has committed. Rollback produces neither durable work nor a Ring item.

**INV-3 — Frozen effect:** the Ring payload, durable Gateway plan, plan hash, projection snapshot identity, destination, idempotency key, delivery scope, and owner fence describe one immutable external effect. They cannot be independently replaced.

**INV-4 — Scope order:** SQLite `delivery_order`, filtered by immutable delivery scope, is authoritative. Ring arrival order is only an optimization and cannot permit a successor to overtake an older blocking effect.

**INV-5 — One effect per Ring:** at most one external effect is in flight for a given Pane Ring or the Global Ring. Different Rings may run concurrently under the process-wide limit.

**INV-6 — Generation fence:** work committed for one Pane owner fence is never retargeted to a later fence. A stale delivery is dismissed, replaced through an explicit recovery transition, or quarantined according to existing effect-certainty rules; the fence does not partition the Pane Ring.

**INV-7 — No inferred cross-Ring order:** time, Ring arrival, and global `delivery_order` do not establish a dependency between different Rings. A required cross-Ring dependency must be durable and explicit.

**INV-8 — No replay coupling:** delivery retry or recovery never repeats Agent Input or changes Core conversation order.

**INV-9 — Checkpoint before advance:** for an executed effect, a provider acknowledgement and all required delivery checkpoints are durably settled before a Ring may advance to its next effect.

**INV-10 — Bounded acceleration:** exceeding a Ring or process cache limit may increase SQLite reads and latency, but cannot reject, drop, reorder, or mutate committed work.

**INV-11 — Durable terminal advance:** a Ring may advance past a head only when SQLite proves it delivered, records an explicit dismissal, or proves its dead letter has a durably completed replacement. An uncertain effect or active human-review quarantine is never terminal and remains blocking.

**INV-12 — Primary-Pane-only Ring identity:** a Pane Ring is identified exactly by a Primary Pane's `workspaceId + paneId`. Worker delivery uses its trusted parent Primary Pane identity; Worker Pane identity and all owner/session/parent fence fields never create another Ring. The Global Ring remains the single scope when no trusted parent Primary Pane exists.

### Delivery Scope Model

Delivery and Operations remains the owning bounded context. Conversation Projection produces immutable Delivery Intents; Delivery and Operations owns their scope, preparation, ordering, claims, execution, and recovery. Feishu remains an outer Gateway adapter and never becomes workflow truth.

The observed model calls each fine-grained ordering partition a Delivery Lane and materializes one head per lane. The proposed model replaces that scheduling meaning with Delivery Scope and Ring. The existing term remains valid only while compatibility metadata and the legacy scheduler exist; it is not an alias for a Pane Ring.

A Delivery Scope identifies either one exact Primary Pane or the Global scope. Primary Pane identity and delivery validity are deliberately separate: the scope selects the Ring, while each `PreparedDelivery` carries an isomorphic Primary/Worker owner fence for claim-time validation. A Worker uses its trusted parent Primary Pane scope; optional parent lineage records the authorization chain without replacing the Worker's own runtime fence:

```ts
type PaneOwnerLineage = Readonly<{
  id: string;
  generation: number;
  sessionGeneration: number;
}>;

type PaneOwnerFence = Readonly<{
  kind: "primary" | "worker";
  id: string;
  generation: number;
  sessionGeneration: number;
  parent?: PaneOwnerLineage;
}>;

type DeliveryScope =
  | {
      kind: "pane";
      workspaceId: string;
      paneId: string;
    }
  | { kind: "global" };
```

The boundary mapping is explicit:

| Delivery producer | `owner.id` | `owner.generation` | `owner.sessionGeneration` | `owner.parent` |
| --- | --- | --- | --- | --- |
| Primary | Binding ID | `bindingGeneration` | `sessionEpoch` | absent |
| Worker | Worker ID | `runtimeGeneration` | `workerSessionGeneration` | parent Binding `id`, `generation`, and `sessionGeneration` mapped from parent Binding ID, `parentBindingGeneration`, and parent session epoch when that authorization lineage is present |

For a Worker, the owner fence validates the Worker runtime and session. Its optional `parent` is authorization lineage: it proves which parent Binding authorized the Worker but is not used as the Worker's runtime generation. Every present fence field participates in claim validity, never Ring identity. The Worker's own Pane identity is not a delivery scope; `workspaceId + paneId` always names its trusted parent Primary Pane.

`/swarm clear` may change Primary or Worker owner/session fences while retaining the same parent Primary workspace and Pane ID. Old-fence deliveries remain in that one Ring and fail the current-fence claim predicate; recovery must resolve them without retargeting. `/swarm reset` creates a new Primary Pane ID, so subsequent Primary and child-Worker work routes to a new Ring. The old Primary Pane Ring remains recoverable from its own durable scope until its work is terminal.

The Scope Router applies these rules at durable reservation time:

1. A Primary projection uses its exact workspace and Primary Pane ID as scope, then maps Binding ID, Binding generation, and session epoch into the delivery's common owner fence.
2. A Worker projection uses its trusted parent Primary workspace and Pane ID as scope, never its Worker Pane ID. It maps Worker ID, runtime generation, and Worker-session generation into the common owner fence and maps authoritative parent Binding lineage into the fence's `parent` for claim validation.
3. A projection without a trusted parent Primary workspace and Pane ID uses Global, including Worker delivery whose parent Primary Pane cannot be proven.
4. Once committed, a scope never changes merely because newer runtime ownership appears.
5. A stale Pane-scoped effect is never moved to Global. Global means “unowned when reserved,” not “ownership validation later failed.”

The scope and owner fence are separate immutable delivery attributes, not copies of mutable current Binding or Worker state. Storage may maintain a normalized `scope_key` from only scope kind, workspace, and Pane ID for indexing, but callers use the typed value and do not construct database keys.

### PreparedDelivery Contract

A Ring holds the complete immutable execution snapshot, not a reply reference or lane hint:

```ts
type PreparedDelivery = Readonly<{
  replyId: string;
  scope: DeliveryScope;
  ownerFence: PaneOwnerFence | null;
  deliveryOrder: number;
  workClass: "live" | "history";

  idempotencyKey: string;
  gatewayId: string;
  gatewayProfileId: string;
  preparedPlan: PreparedGatewayDelivery;
  planHash: string;

  projectionKey: string | null;
  snapshotRevision: number;
  rendererRevision: number;
  cardSequence: number | null;

  priorCheckpoints: readonly GatewayDeliveryCheckpoint[];
  nextAttemptAt: string;
  estimatedBytes: number;
}>;
```

`preparedPlan.intent` contains the exact operation and target; duplicating an independently mutable `operation` or `target` beside the plan is forbidden. `planHash` covers the canonical serialized plan plus effect-defining identity. `estimatedBytes` is deterministic accounting metadata and does not participate in effect identity.

The object is immutable. A Primary-Pane-scoped delivery has a complete `ownerFence`. A Global delivery retains any authoritative per-item fence evidence but never invents a parent Primary Pane scope. Retry eligibility and checkpoints are durable mutable state, so a failure or partial checkpoint invalidates the cached object. A later attempt receives a newly hydrated `PreparedDelivery`; the frozen effect fields remain identical while `nextAttemptAt` and `priorCheckpoints` reflect the latest durable state.

The Ring never carries mutable projection entities, SQLite rows, Gateway SDK objects, closures, or credentials.

### Durable Outbox Transaction

The successful reservation path is one transaction:

```text
validate current projection and target
  -> derive Pane-only DeliveryScope and separate owner-validity fence
  -> canonicalize effect identity and sequence
  -> compile provider-neutral Gateway intent
  -> synchronously prepare the Gateway plan
  -> freeze plan + hash + scope + delivery_order in outbox
  -> commit projection and outbox together
  -> return PreparedDelivery to the caller
  -> DeliveryEngine.enqueue(PreparedDelivery)
```

Gateway `prepare()` remains synchronous, deterministic, and free of external I/O. Delivery and Operations owns a consumer-shaped plan-preparation interface; the configured Gateway adapter implements it, and composition injects it into the transactional reservation path. Gateway execution remains outside the transaction.

Canonicalization that depends on durable state, including replaceable-card sequence reuse, occurs before plan preparation inside the same transaction. This prevents a plan from being built from pre-normalized values. The stored plan/hash is the existing effect-freeze boundary and does not increment attempt count or fabricate an external attempt.

If deterministic rendering, target validation, plan preparation, or plan serialization fails, the transaction records the existing bounded permanent/rejected outbox failure and its quarantine evidence but returns no `PreparedDelivery`. A SQLite, lease, or transaction failure rolls back and remains an application failure; it is not misclassified as malformed presentation data.

The transaction returns the committed object only after COMMIT succeeds. Callers do not separately reconstruct it from input arguments.

### Hot Delivery Path

The public module is deliberately small:

```ts
interface DeliveryEngine {
  start(): void;
  enqueue(delivery: PreparedDelivery): void;
  stop(): Promise<void>;
  snapshot(): DeliverySnapshot;
}
```

`enqueue()` is a non-blocking, process-local acceleration call. It is valid only for a committed object returned by the durable reservation module. Duplicate calls are harmless. Overflow, shutdown, or a stale object causes a diagnostic/refill request, not an exception that reverses the already committed workflow transition.

The normal path is:

```text
Ring.pop PreparedDelivery
  -> conditional claim UPDATE
  -> Gateway.execute(preparedPlan, claim context)
  -> persist intermediate checkpoints when emitted
  -> durable ACK or failure settlement
  -> schedule the same Ring again
```

The claim is one atomic conditional write. It validates at least:

- `replyId`, pending state, due time, and no active claim;
- the service lease owner/fencing token;
- scope key and complete owner generation fence;
- `planHash`, `snapshotRevision`, and immutable plan identity;
- the effect-specific current-target predicate formerly enforced during just-in-time materialization, such as active Answer page, Worker session, Main Card, thread alias, or projection revision ownership;
- absence of an older blocking row in the same scope;
- satisfaction of any explicit durable prerequisites;
- absence of an active scope quarantine or Gateway cooldown.

On success, the write returns only claim identity and fence data. Gateway execution uses the Ring's plan and checkpoints; there is no pre-execution row SELECT or re-materialization. On zero changed rows, the object is discarded and that scope enters cold refill. A failed CAS cannot call the Gateway.

An intermediate Gateway checkpoint is written immediately against the claim. Once a checkpoint changes, the cached object must not be reused. ACK/failure settlement is conditional on the same attempt and lease fences. A stale settlement cannot advance the Ring.

#### Module responsibilities and source dependencies

- The **Delivery Reservation module** is the application seam used by projection workflows. It coordinates canonicalization and one transaction, and returns the committed `PreparedDelivery`.
- The **Scope Router** is a pure Delivery and Operations policy. It accepts already-authorized Primary, Worker, and projection ownership facts and returns a valid `DeliveryScope`; it never queries Herdr or Feishu.
- The **Delivery Engine** owns Ring lifecycle, memory accounting, scheduling, timers, hot/cold selection, and shutdown. Callers see only its four-method interface.
- The **Prepared Delivery Store** interface is owned by Delivery and Operations. It expresses transactional reservation, bounded head hydration, conditional claim, checkpoint, and settlement semantics. The SQLite adapter implements it.
- The **Gateway Plan Preparer/Executor** interfaces are owned by the Gateway contract. A configured Gateway adapter provides deterministic preparation and external execution.
- The composition root constructs the SQLite and Gateway adapters and injects them into reservation and delivery. Projection modules depend on the reservation and engine interfaces, not on SQLite tables, Ring implementations, or the Feishu SDK.

Source dependencies point toward the consumer-owned Delivery/Gateway contracts. Runtime control flows outward to SQLite and the Gateway adapter. `PreparedDelivery` and normalized claim/settlement results are the only data crossing those seams; database rows and provider SDK responses do not.

### Cold Recovery Path

SQLite is used whenever the fast-path copy is absent or invalid:

- process startup or restart;
- COMMIT followed by process death before `enqueue()`;
- Ring or process byte/item overflow;
- missed, duplicate, or reordered enqueue notification;
- CAS mismatch;
- retry becoming due;
- provider cooldown expiry;
- partial checkpoint or uncertain-effect recovery;
- dead-letter release, dismissal, or replacement;
- periodic safety reconciliation.

Cold refill pages eligible scope heads and hydrates complete `PreparedDelivery` objects in bounded batches. It verifies the stored plan/hash, Primary-Pane scope identity, and separate owner fence while decoding. Invalid persisted data is durably quarantined; it is never sent with a guessed plan or owner.

Future-due work remains in SQLite. The engine arms a bounded timer for the earliest due head and performs a low-frequency safety scan so timer loss is harmless. Retry failure does not mutate and reinsert the old object; settlement writes the new retry state and the timer later hydrates a fresh object.

An object larger than a Ring's byte budget is not cached. Cold recovery may claim and execute one such valid row directly as an oversized cold item, still under per-scope serialization and process-wide concurrency. Oversized-item bytes are reported separately; the cache budget is not a persistence or delivery size limit.

### Pane Ring Lifecycle

A Primary Pane Ring is created lazily when committed or recovered Primary or Worker work first appears for its exact parent `workspaceId + paneId` scope. It contains one FIFO of `PreparedDelivery` snapshots ordered by durable `deliveryOrder`, even when adjacent items come from different Workers or carry different owner fences.

Initial limits are:

- at most 32 cached items per Pane Ring;
- at most 1 MiB of cached serialized delivery data per Pane Ring;
- at most one active external effect per Pane Ring.

The Ring rejects a duplicate `replyId`. When enqueue arrival reveals a gap or lower durable order than the cached tail, the Ring marks itself dirty and cold-refills rather than sorting untrusted arrival into authority.

A Pane Ring becomes runnable when its head is due, prerequisites are satisfied, it is not quarantined, and the Gateway is not in cooldown. A transient failure blocks that Ring at its durable head until retry. An uncertain effect blocks it until recovery establishes the outcome. A permanent rejected/dead-letter effect blocks later work until an explicit durable dismissal, replacement, or release transition permits advance. Delivered heads, explicitly dismissed heads, and dead letters with a durably completed replacement are terminal and do not block. Active human-review quarantine remains blocking. This Pane-level head-of-line blocking, except for durably proven terminal or safely superseded heads, is intentional.

An empty Ring may be evicted after an idle interval only when it has no active claim, no queued wake, and a bounded durable head check finds no runnable work. Eviction loses no authority. `/swarm clear` does not retire or fork the Ring; `/swarm reset` creates a new Pane scope and leaves the old Pane Ring's durable work in the old scope.

### Global Ring Lifecycle

There is exactly one Global Ring for work that lacked a trusted parent Primary Pane at reservation time. It has the same claim, settlement, recovery, and strict FIFO semantics as a Primary Pane Ring.

Initial limits are:

- at most 64 cached items;
- at most 2 MiB of cached serialized delivery data;
- at most one active external effect.

The Global Ring is not a fallback destination for stale Pane work and is not privileged by the scheduler. One unresolved Global effect can block unrelated later Global effects. That trade-off is accepted to keep non-Pane topology simple; operational metrics must make it visible.

### Cross-Ring Scheduler

The scheduler queues runnable Ring identities, not a second global payload queue. Each Ring has at most one ready token. Repeated wakes coalesce.

The initial process-wide external-delivery concurrency remains four. A scheduler grant lets one Ring claim and settle one effect; the Ring then yields and rejoins the ready set if its next head is runnable. This prevents a continuously busy Pane from monopolizing all permits.

Fairness is applied between Ring heads:

- preserve the existing 3:1 live/history selection when both classes have runnable Ring heads;
- use round-robin order within each class;
- count the Global Ring as one ordinary Ring;
- never reorder two effects within a Ring to satisfy the ratio;
- allow the available class to use idle grants when the preferred class is empty.

Therefore a live item behind an older history item in the same Pane still waits. The fairness policy protects independent Panes from bulk history work; it does not violate scope order. Scheduler metrics must expose wait age by class so the ratio can be tuned from evidence without changing persistence.

A Gateway-wide cooldown temporarily makes affected Rings non-runnable and releases their concurrency permits. Cooldown expiry wakes eligible Rings through cold recovery.

### Coalescing and Supersession

Coalescing remains a projection/convergence decision before an external effect is frozen. Durable view revisions may accumulate under the existing normal, interactive, or terminal debounce policy. When convergence reserves a delivery, it prepares and freezes the selected revision.

After the outbox transaction commits:

- the prepared effect cannot be mutated into a newer snapshot;
- an exact replay returns the existing immutable effect;
- a conflicting same-key replay fails with the existing idempotency conflict;
- a newer semantic revision creates or selects the explicitly defined successor effect;
- existing Answer-page, Worker-card, and Main-card supersession policies may dismiss or replace work only through their durable recovery transitions.

The low-cost head-of-line optimization is limited to replaceable Card updates. SQLite may supersede the current head only when durable effect certainty proves that its Gateway effect was not started or was rejected, and only when a successor targets the same exact Card, has a strictly higher `snapshotRevision`, and is itself durably reserved. One transaction revalidates the head and successor, records the explicit dismissal and replacement relation, releases the successor, and advances the authoritative head. A stale cache may only observe the result and refill; it cannot perform or infer the transition.

This optimization does not apply to creates, deletes, messages, streams or frozen Answer pages, different targets, equal or lower revisions, uncertain effects, or active human-review quarantine. It adds neither a `conflictKey` ordering partition nor intra-Pane concurrency: the same Pane Ring still exposes and executes at most one authoritative effect at a time.

Ring compaction may discard a cached item only after SQLite proves that item is no longer runnable. It cannot infer supersession from a newer Ring item. Stream sequence and frozen Answer-page rules remain unchanged.

### Failure and Recovery Semantics

The existing external-effect classifications remain authoritative:

| Outcome | Durable action | Ring action |
| --- | --- | --- |
| Prepared and acknowledged | Persist receipt/checkpoints as delivered | Drop cached head and offer next scope head |
| Definitely not started / transient | Persist retry time and clear claim | Drop cached object; arm cold retry |
| Provider rejected / permanent | Persist dead letter and quarantine | Block scope pending explicit recovery policy |
| Effect uncertain | Persist uncertainty and recovery evidence | Block scope; never blindly resend or advance |
| Stale owner generation | Persist approved dismissal/replacement/quarantine outcome | Never retarget to a new scope |
| Checkpoint or settlement write fails | Preserve claim/uncertainty for reconciliation | Stop advancing scope; cold recovery owns resolution |
| Lease fence lost | Reject claim/settlement and stop engine progress | New lease owner recovers from SQLite |
| Ring overflow or missed enqueue | No durable state change | Cold refill later hydrates the row |

Delivered and explicitly dismissed rows are terminal for scope-head selection. A dead letter is also terminal once its linked replacement is durably completed. All other dead letters remain blocking until an approved recovery transition; an active human-review quarantine and every uncertain effect remain blocking regardless of any newer snapshot. For an eligible replaceable Card update, the atomic safe-supersession transition above is the only automatic dismissal-and-release path.

Cross-Ring prerequisites, where needed, are represented by durable reply-to-reply prerequisite records. Claim succeeds only when each prerequisite has the explicitly required settled state. The scheduler never interprets timestamps or likely creation order. If a relationship can instead remain within one Pane scope, scope order is preferred over adding a prerequisite.

Checkpoint subscribers run after durable delivery settlement. Subscriber failure requests later convergence but cannot rewrite an acknowledged effect or make the Ring resend it.

### Memory and Backpressure Limits

The delivery cache is bounded simultaneously by count and estimated serialized bytes:

- Pane Ring: 32 items and 1 MiB;
- Global Ring: 64 items and 2 MiB;
- all Rings combined: 32 MiB;
- active Gateway calls: four initially;
- active external effects per Ring: one.

Admission checks both limits before retaining an object. The process-wide budget is allocated on demand; a hot Pane cannot reserve its theoretical maximum in advance. When any limit is reached, the object stays only in SQLite and the scope is marked for bounded refill. Durable producers are not rejected and projection transactions do not wait for memory.

Backpressure is therefore observational and convergence-based. Projection-level coalescing may reduce replaceable effects before reservation, but after COMMIT neither Ring pressure nor process pressure may discard durable effects. Count, bytes, overflow, refill, and oldest-head age are exposed per scope and in aggregate.

### Observability

`DeliverySnapshot` exposes bounded summaries, never payloads or credentials:

```ts
interface DeliverySnapshot {
  state: "starting" | "running" | "stopping" | "stopped" | "degraded";
  ringCount: number;
  runnableRings: number;
  activeDeliveries: number;
  cachedItems: number;
  cachedBytes: number;
  processByteLimit: number;
  overflowedScopes: number;
  quarantinedScopes: number;
  oldestReadyAt: string | null;
  oldestLiveReadyAt: string | null;
  oldestHistoryReadyAt: string | null;
  nextRetryAt: string | null;
  lastRefillAt: string | null;
  lastDeliveryAt: string | null;
  lastFailureAt: string | null;
}
```

Structured events include `replyId`, scope kind, safe scope key, Pane/owner identity, delivery order, work class, plan hash, snapshot revision, claim attempt, lease fence, cache source (`commit` or `cold`), Ring wait duration, external duration, checkpoint duration, and outcome.

Required counters/histograms include:

- cache enqueue accepted, duplicate, overflow, stale, and oversized;
- hot claims versus cold hydrations and CAS misses;
- Ring occupancy/bytes and process cache bytes;
- runnable wait and head age by live/history and scope kind;
- external/checkpoint/settlement latency;
- retry, cooldown, quarantine, uncertain effect, and stale-fence outcomes;
- safety-scan discoveries of work missed by the hot path.

Readiness remains based on the lease, SQLite, Gateway, Core, and project state. Ring emptiness alone is not readiness.

### Schema Migration

The durable outbox gains immutable Primary Pane scope fields plus separate common owner-fence fields, optional all-or-none parent-lineage fence fields, and an indexed normalized `scope_key`. The normalized key contains only scope kind, parent Primary workspace, and Primary Pane ID. Owner kind selects fence interpretation rather than a different column shape; Primary rows omit parent lineage, while Worker parent lineage participates in claim validity whenever present. Existing `delivery_order`, plan/hash, checkpoint, claim, snapshot, retry, failure, and idempotency fields remain authoritative.

The scope migration also moves current just-in-time target guards into claimable durable identity and SQL predicates. A target whose validity depends on a mutable projection must carry the corresponding immutable target identifier/revision in the outbox. This lets the conditional claim reject stale work atomically without reintroducing a read/materialize step.

The target indexes support:

- earliest pending row by `(scope_key, delivery_order)`;
- eligible scope heads by state and `next_attempt_at`;
- active claims and expired-claim recovery;
- live/history head selection without scanning full payloads;
- owner-generation diagnostics.

The final design does not require `outbox_lane_heads`. Cold head discovery uses scope indexes and bounded queries; query plans and large-backlog timing are release gates. If evidence shows a derived head projection is necessary, it may be introduced as an internal SQLite optimization only after a separate reviewed decision; it must not restore public Delivery Lane semantics.

Historical rows are not assigned a Primary Pane scope from a current mutable Binding alone. Backfill uses only durable evidence that proves the exact historical Primary workspace and Pane ID, and reconstructs owner fences separately. Worker rows require durable evidence of their parent Primary Pane; rows without it remain unscoped during shadow validation and require an explicit durable Global classification or completion under the legacy scheduler before cutover.

No migration rewrites a frozen Gateway plan, idempotency key, delivery order, effect certainty, or checkpoint.

### Incremental Cutover

Cutover proceeds in independently reversible stages:

1. **Scope schema:** add nullable shadow scope fields, constraints, and indexes. Keep the existing scheduler authoritative.
2. **Shadow writes:** every new outbox reservation derives and persists scope while continuing to write legacy lane metadata. Compare route/fence decisions in diagnostics.
3. **Prepared commit:** move deterministic Gateway preparation into the durable reservation transaction. Continue legacy delivery from the now-prepared rows and verify plan-freeze behavior.
4. **Cold reader:** implement bounded scope-head hydration and compare its candidates with durable legacy behavior without executing them.
5. **Ring shadow:** feed full post-commit objects into bounded Pane/Global Rings, record scheduling decisions, but leave external execution disabled.
6. **Scoped execution:** enable Ring execution for a controlled cohort while preventing the legacy dispatcher from claiming the same rows. Verify hot-path SELECT removal, CAS fencing, ACK settlement, restart, overflow, retry, and cooldown.
7. **Full cutover:** make the Delivery Engine authoritative for every scoped row. Legacy scheduler continues only for explicitly unscoped migration debt.
8. **Legacy drain:** classify or finish all unscoped actionable rows. Require zero ambiguous rows before disabling the legacy scheduler.
9. **Contraction:** remove fine-grained lane scheduling and `outbox_lane_heads` only after sustained cold-refill, integrity, backlog-age, and rollback-window verification. Retire obsolete `laneKey` APIs in a later behavior-preserving cleanup.

At no stage may both schedulers claim the same row. A persisted scheduler ownership/cutover marker or mutually exclusive claim predicate fences cohorts during transition.

### Rollback

Before contraction, rollback stops new Ring claims, waits for or fences active Ring attempts, and re-enables the legacy scheduler for rows whose legacy metadata is still maintained. Prepared plans remain valid and do not need rebuilding. Cached objects are discarded.

Rollback never:

- deletes or rewrites committed effects;
- clears uncertain claims without reconciliation;
- moves Pane work to Global;
- changes delivery order or idempotency identity;
- retries an effect merely because its in-memory copy was lost.

After lane-table/API contraction, rollback requires deploying a release that understands the new scope schema rather than reconstructing deleted lane state. The rollback window must therefore close explicitly before contraction, with a verified database backup/restore procedure and no unresolved unscoped work.

## Testing Decisions

Each SCN-1 through SCN-14 scenario has an observable test path through the following seams.

- Pure tests cover Primary/Worker boundary mapping, Worker-to-parent-Primary routing, optional parent-lineage validation, Primary-Pane-only Ring-key equality, owner-fence equality independent of Ring identity, Ring count/byte limits, duplicate detection, dirty-gap behavior, and scheduler fairness.
- SQLite integration tests cover transaction atomicity, immutable scope/plan triggers, indexed head discovery, CAS head/fence predicates, expired claims, prerequisites, settlement, atomic safe supersession and terminal-head classification, and cold hydration.
- Delivery Engine integration tests use a fake Gateway executor and a query-counting store to prove the hot path performs only claim/checkpoint/settlement writes.
- Concurrency tests interleave two claims for one scope, multiple scopes under four permits, a lease change, a checkpoint failure, and a shutdown.
- File-backed restart tests cover every crash window: before COMMIT, after COMMIT/before enqueue, after claim/before provider call, after provider ACK/before settlement, and after settlement/before next scheduling.
- Pane-lifecycle tests prove `/swarm clear` changes Primary/Worker claim fences without creating another parent Primary Ring, Worker delivery never creates a Ring, and `/swarm reset` creates a new Primary Pane ID and Ring.
- Migration tests start from representative current schemas containing live/history, frozen plans, retries, quarantines, Worker rows, and ambiguous legacy ownership.
- Performance tests use a production-shaped backlog to validate bounded scope-head queries before removing `outbox_lane_heads`.

Affected focused tests, TypeScript typecheck, build, the full Vitest suite, SQLite integrity checks, and non-mutating service diagnostics are required before deployment.

## Trade-offs and Rejected Alternatives

### Selected: full-data Ring per Primary Pane plus one Global Ring

This matches the user-visible isolation unit, makes parent Primary ordering apply to Worker delivery, removes the hot-path read/materialization cost, and keeps the durable outbox as recovery truth. Its costs are Primary-Pane-level head-of-line blocking, more cached bytes than reference-only queues, explicit scope/fence migration, and a scheduler over dynamically created Rings.

### Rejected: one global reference Ring over fine-grained lanes

This is the current shape. It keeps memory small but repeatedly reads/materializes work, invalidates global cached references on wakes, and makes fine-grained lane topology the operational model.

### Rejected: wake-only per-Pane actors

Wake-only mailboxes make misuse difficult and minimize cache memory, but every effect still requires SQLite selection and hydration. That does not achieve the approved hot-path read reduction.

### Rejected: opaque committed-work tickets

An opaque ticket can prevent callers from choosing a wrong scope, but it hides the concrete committed data and adds a second capability abstraction without improving durability. The transactional reservation module already owns scope derivation and returns a typed immutable object.

### Rejected: full-data fine-grained lane Rings

This retains the current Answer/Main/Worker/projection scheduling complexity and does not make Pane the backpressure boundary.

### Rejected: a Ring per Gateway target or card

This increases throughput inside one Pane but recreates cross-target ordering and dependency problems. The approved simplification accepts one in-flight effect and head-of-line blocking per Pane.

### Rejected: Ring as authority

Persisting only on overflow or shutdown creates loss and ambiguous-effect windows. SQLite COMMIT remains mandatory before every enqueue.

## Out of Scope

- The Ring is not a durable queue and is not restart truth.
- This change does not alter Agent Input, Core event order, Conversation Projection semantics, CardKit rendering, or Gateway protocol version 1.
- It does not promise ordering across two Panes, across a Pane and Global, or across two generations of the same physical Pane.
- It does not remove the durable outbox, delivery checkpoints, dead-letter recovery, or the process instance lease.
- It does not add remote approval, a new Gateway, distributed workers, or a cross-process queue.
- It does not optimize away Pane-level head-of-line blocking. That is an accepted simplification.

## Further Notes

The selected topology, full-data Ring payload, durable-outbox authority, Pane/Global split, bounded memory, per-Ring serialization, 3:1 cross-Ring live/history fairness, and incremental migration were approved at Gate 1. The synthesized specification was approved at Gate 2.

There are no unresolved product semantics blocking planning. Implementation planning must still measure production-shaped scope-head query plans before authorizing removal of `outbox_lane_heads`; failure of that performance gate changes the internal SQLite optimization, not the public Pane/Global Ring model.

Workspace evidence for this design: in-place `main` at revision `edb258da7f6e1390a5a911bf5410653bb5b3ce1c`. The pre-existing modified `TODO.md` and untracked research, Core-gap specification, and `handoff.md` remain untouched. The fresh baseline passed TypeScript typecheck, build, and 274 Vitest files / 3,962 tests.
