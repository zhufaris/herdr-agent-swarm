# Per-Pane Delivery Rings Implementation Plan

Specification: [Per-Pane Delivery Rings](../specs/2026-10-06-per-pane-delivery-rings.md)

Status: Gate 1 design and Gate 2 specification approved; Gate 3 implementation authorization pending.

Workspace: in-place `/workspace/herdr-agent-swarm` on `main` at starting revision `edb258da7f6e1390a5a911bf5410653bb5b3ce1c`. In-place work is appropriate because the task owns new delivery artifacts and later delivery/store changes; existing user changes do not overlap and must remain unstaged.

Preserved initial changes:

- modified `TODO.md`;
- untracked `docs/research/2026-10-02-session-message-jsonl-dependencies.md`;
- untracked `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`;
- untracked `handoff.md`.

Dependency preparation: existing locked dependencies are installed. Fresh baseline: `npm run typecheck`, `npm run build`, and `npm test` passed; Vitest reported 274 files and 3,962 tests. Documentation checks subsequently passed 2 files and 7 tests.

## Ticket Order

```text
T1 scope shadow persistence
  -> T2 atomic Primary Turn Card reservation
       -> T2A common Pane-owner correction
            -> T3 indexed cold discovery + prerequisites
            -> T4 bounded shadow Ring engine
                 -> T5 Primary Turn Card CAS hot execution
                      -> T5A safe replaceable-Card head advance
                           -> T6 cold recovery and lifecycle
                                -> T7 remaining Primary Pane families
                                     -> T8 Worker/Global migration + scoped cutover
                                          -> R1 operational contraction gate
                                               -> T9 remove legacy lanes
```

T3 and T4 may be implemented in either order after T2A. All other arrows are functional dependencies. Each ticket must keep the legacy production delivery path green until its stated cutover point.

## Tickets

### - [x] T1: Persist generation-fenced Delivery Scopes in shadow mode

**What to build**

Add the `DeliveryScope` and `PaneOwnerFence` value model, a pure Scope Router, and nullable immutable scope columns on durable outbox rows. New reservations write a parent Primary Pane or Global scope from authoritative ownership facts; Worker delivery uses its trusted parent Primary scope and never owns a separate scope or Ring. Keep the legacy lane scheduler as the only executor. Add a per-row scheduler-owner field whose initial value is `legacy`; it is the cutover fence that prevents two engines claiming one row.

**Spec references**

SCN-4, SCN-6, SCN-12; INV-1, INV-4, INV-6, INV-7; Delivery Scope Model; Schema Migration; Incremental Cutover steps 1-2.

**Ownership and implementation path**

Delivery and Operations owns scope meaning and equality. The Scope Router consumes already-authorized Primary/Worker ownership facts and must not query Herdr or Feishu. The SQLite adapter persists normalized `scope_key`, typed owner columns, and `scheduler_owner` constraints in the same transaction as each outbox row. Global is selected only when trusted parent Primary Pane evidence is absent at reservation; stale Primary-Pane-scoped work is never reclassified Global. Continue writing current lane metadata for rollback compatibility.

**Acceptance criteria and verification**

- Primary scope equality includes only workspace and Primary Pane ID; Binding generation and session epoch are separate claim-fence fields.
- Worker delivery scope equality uses the trusted parent Primary workspace and Pane ID; Worker runtime/session and parent Binding lineage remain separate claim fences.
- Owner/session generation changes do not change the scope key for an existing Primary Pane; a different Primary workspace or Pane ID does.
- Missing trusted parent Primary Pane evidence produces Global; later fence staleness does not mutate scope.
- Database constraints reject partial/mixed owner shapes and scope mutation after effect freeze.
- Existing databases migrate idempotently without guessing historical owner generations or changing plans, order, checkpoints, certainty, or delivery state.
- Existing lane selection/delivery tests remain green because `scheduler_owner` defaults to `legacy`.
- Verify with focused scope-policy tests, SQLite migration/round-trip tests, architecture-boundary checks, typecheck, and build.

**Blocked by:** None.

### - [x] T2: Atomically reserve PreparedDelivery for canonical Primary Turn Cards

**What to build**

Introduce the reusable Delivery Reservation module and migrate the canonical Primary Turn Card create/update family through it as the first complete vertical slice. Canonicalize target and sequence, derive scope, compile the Gateway intent, synchronously prepare/serialize the plan, persist projection plus outbox effect, and return the complete immutable `PreparedDelivery` only after COMMIT. Keep the legacy dispatcher consuming those prepared rows. Other delivery families remain on the existing compatible reservation path until T7/T8.

**Spec references**

SCN-1, SCN-2, SCN-6, SCN-8; INV-2, INV-3, INV-6, INV-9; PreparedDelivery Contract; Durable Outbox Transaction; Coalescing and Supersession.

**Ownership and implementation path**

The Turn Card projection workflow depends on the consumer-owned reservation interface. The SQLite adapter owns atomic canonicalization/persistence; the injected Gateway Plan Preparer owns deterministic provider-neutral conversion and performs no I/O. The returned object is constructed from canonical committed values, not caller arguments. Existing frozen-plan/idempotency triggers remain authoritative. The seam must support later delivery families without importing their rendering policy or changing Gateway execution.

Preparation or serialization poison is persisted once as the existing permanent/rejected outbox failure and yields no Ring object. SQLite/lease failures roll back and propagate. Projection debounce/coalescing stays before reservation; committed prepared effects never coalesce by mutation.

**Acceptance criteria and verification**

- COMMIT returns a full object containing scope, durable order, class, idempotency, frozen plan/hash, projection identity, checkpoints, eligibility, and byte estimate.
- Rollback and storage failure return no object and emit no notification.
- The persisted plan exactly matches the returned plan/hash after sequence normalization.
- Exact same-key replay returns the original frozen effect; changed identity conflicts.
- Preparation/serialization failure creates bounded permanent/rejected evidence, does not call execute, and cannot poison unrelated work.
- Canonical Turn Card create/update and recovery reservations use the new seam; Answer stream, Worker, Main Card, thread, deletion, and other producers preserve their current durable behavior until later tickets.
- Verify focused reservation/store tests, frozen-plan and preparation-failure suites, projection integration tests, typecheck, build, and full suite.

**Blocked by:** T1.

### - [x] T2A: Separate Pane Ring identity from the common owner-validity fence

**What to build**

Make Pane `DeliveryScope` contain only a Primary Pane's `workspaceId + paneId`, with Global unchanged. Worker delivery uses those fields from its trusted parent Primary Pane and never its Worker Pane. Move the common immutable owner fields—`kind`, `id`, `generation`, and `sessionGeneration`, plus optional all-or-none parent lineage—onto `PreparedDelivery` as a separate validity fence. Correct the shadow schema, normalized Primary-Pane-only scope key, scope router, reservation round trip, and already-written shadow rows before cold discovery or Ring shadow execution depends on the shape.

**Spec references**

SCN-4, SCN-6, SCN-12, SCN-14; INV-1, INV-4, INV-6, INV-12; Delivery Scope Model; Durable Outbox Transaction; Schema Migration; Incremental Cutover steps 1-3.

**Ownership and implementation path**

Delivery and Operations owns parent-Primary scope equality separately from owner-fence equality. Boundary adapters perform the only native-name mapping: Primary maps Binding ID, `bindingGeneration`, and `sessionEpoch`; Worker maps Worker ID, `runtimeGeneration`, and `workerSessionGeneration`. Worker routing requires trusted parent Primary workspace/Pane identity; when Worker authorization includes a parent Binding, map its ID, generation, and session epoch into the optional parent lineage. Parent lineage is authorization provenance and participates in claim validity when present, never in Ring identity.

**Acceptance criteria and verification**

- Primary and Worker serialize, persist, hydrate, compare, hash, and claim-fence through the same four required owner fields stored separately from `DeliveryScope`.
- Primary maps `bindingGeneration` to `owner.generation` and `sessionEpoch` to `owner.sessionGeneration`, with no parent lineage.
- Worker maps `runtimeGeneration` to `owner.generation` and `workerSessionGeneration` to `owner.sessionGeneration`; authoritative parent Binding lineage maps to the optional common parent fields.
- Parent lineage is either wholly absent or complete, is accepted only for Worker ownership, and affects claim validity whenever present; it never substitutes for the Worker's owner generation or changes Ring identity.
- The normalized Pane scope key is exactly the parent Primary workspace plus Pane ID; changing any Primary/Worker owner/session/parent fence does not change that key.
- Worker Main/Task/stream/thread delivery routes to its trusted parent Primary Ring and never allocates a Worker Ring; without trusted parent Primary Pane identity it routes to Global.
- `/swarm clear` keeps Primary and Worker work in the existing parent Primary Pane Ring while making stale-fence claims fail; `/swarm reset` creates a new Primary Pane ID and therefore a new Ring.
- The corrective migration is idempotent and preserves delivery order, frozen plans, idempotency, checkpoints, certainty, scheduler ownership, and legacy lane compatibility while rebuilding any owner-contaminated normalized scope key.
- Constraints and boundary tests reject partial parent lineage, provider-specific mixed shapes, swapped Worker generation mappings, and scope mutation after freeze.
- Existing Primary reservation and legacy delivery behavior remains green; verify focused scope/router tests, SQLite migration/reopen tests, reservation round trips, typecheck, build, and full suite.

**Blocked by:** T2.

### - [x] T3: Discover and hydrate authoritative scope heads without lane heads

**What to build**

Add bounded SQLite operations that discover eligible scope heads, hydrate complete `PreparedDelivery` snapshots, recover expired claims, report the earliest future eligibility, and validate explicit cross-Ring prerequisites. Run them initially as a read-only shadow comparator; do not execute scoped rows and do not remove `outbox_lane_heads`.

**Spec references**

SCN-3, SCN-5, SCN-8, SCN-9, SCN-11, SCN-12; INV-1, INV-4, INV-7, INV-10; Cold Recovery Path; Failure and Recovery Semantics; Schema Migration.

**Ownership and implementation path**

The Prepared Delivery Store interface expresses bounded head paging and hydration; its SQLite adapter implements indexed queries over immutable scope and durable order. Add durable reply-to-reply prerequisites with explicit required settled state. Decode/verify plan hash, owner shape, target identity, checkpoint, and retry data at the adapter boundary. Invalid durable representations follow existing quarantine semantics rather than receiving guessed defaults.

**Acceptance criteria and verification**

- Head discovery returns at most one earliest nonterminal candidate per scope in durable order and in bounded pages.
- Future-due, quarantined, cooldown-blocked, claimed, and unmet-prerequisite heads are classified without allowing successors to overtake.
- Cold hydration round-trips the complete effect and current retry/checkpoint state.
- An unmet cross-Ring prerequisite fails claim eligibility; its settlement wakes the dependent scope.
- Lost-notification and restart fixtures rediscover committed work.
- Shadow comparison reports mismatches without claiming or mutating delivery rows.
- `EXPLAIN QUERY PLAN` and production-shaped fixture timings prove indexed bounded behavior before T9; record the evidence in the plan.
- Verify SQLite store/integrity/reopen tests, query-plan assertions, typecheck, and build.

**Blocked by:** T2A.

### - [x] T4: Run bounded full-data Pane and Global Rings in shadow mode

**What to build**

Implement the four-method `DeliveryEngine` with one lazy Ring per Primary `workspaceId + paneId`, one Global Ring, count/byte budgets, process-wide memory accounting, duplicate/gap handling, idle eviction, a four-permit scheduler, and 3:1 live/history fairness. Worker items enter their parent Primary Ring. Feed committed and cold-hydrated `PreparedDelivery` objects into it with external execution disabled.

**Spec references**

SCN-4, SCN-5, SCN-7, SCN-10, SCN-14; INV-4, INV-5, INV-10, INV-12; Hot Delivery Path interface; Pane Ring Lifecycle; Global Ring Lifecycle; Cross-Ring Scheduler; Memory and Backpressure Limits; Observability.

**Ownership and implementation path**

Delivery Engine hides Ring instances, ready tokens, timers, memory accounting, and scheduler internals. It depends only on consumer-owned prepared-store, Gateway executor, clock, lease, and observability interfaces. Producers call `enqueue()` only with a post-COMMIT object. Shadow mode records the Ring and scheduling decision but never claims or executes a row.

**Acceptance criteria and verification**

- Pane Rings cap at 32 items/1 MiB, Global at 64 items/2 MiB, process cache at 32 MiB.
- Multiple Primary and Worker owner/session generations under one Primary Pane share one Ring; Worker items never add a Ring, `/swarm clear` does not add one, and `/swarm reset` does because it creates a new Primary Pane ID.
- Duplicate IDs are harmless; reversed or suspicious arrival marks the scope dirty and requests refill.
- Overflow leaves durable state untouched and schedules bounded refill.
- One ready token per Ring coalesces wake storms.
- Scheduler grants are round-robin within class and 3:1 across runnable live/history heads without violating same-Ring FIFO.
- One blocked Pane or Global does not consume a permit needed by another runnable Ring.
- Idle eviction requires no active claim/wake and a durable empty check.
- Snapshot/log metrics expose counts, bytes, head age, overflow, source, and wait without payloads or credentials.
- Verify pure Ring/scheduler tests with a fake clock/store, shadow integration tests, architecture-boundary tests, typecheck, and build.

**Blocked by:** T2A. T3 is not required for pure Ring construction, but is required before execution cutover.

### - [x] T5: Execute Primary Turn Cards through the full-data CAS hot path

**What to build**

Add the Ring-owned conditional claim and execution path for the prepared Primary Turn Card cohort assigned to `scheduler_owner=ring`. A successful claim returns only claim/fence identity; execute the cached plan and checkpoints directly, persist intermediate checkpoints, and conditionally settle ACK/failure. The hot path must not SELECT/reload the row or re-materialize its plan. All other delivery families stay on the legacy executor.

**Spec references**

SCN-1, SCN-4, SCN-5, SCN-6, SCN-8, SCN-9, SCN-11; INV-3 through INV-9; Hot Delivery Path; Failure and Recovery Semantics; Incremental Cutover step 6.

**Ownership and implementation path**

The SQLite adapter owns one atomic claim predicate over pending/due state, lease and attempt fences, `scheduler_owner=ring`, immutable parent-Primary scope and separate owner fence, plan hash, snapshot revision, target-specific current ownership, scope-head order, prerequisites, quarantine, and cooldown. Delivery Engine owns orchestration; the Gateway adapter receives only the frozen plan and normalized claim context. Existing failure classification, checkpoint persistence, and post-settlement subscribers are reused behind the new engine seam.

**Acceptance criteria and verification**

- Two concurrent claims for one scope produce one winner; the loser performs no Gateway call.
- A successor cannot claim while any older blocking effect in its scope remains unresolved.
- Primary generation, Turn Card page, projection revision, prerequisite, cooldown, and lease mismatches fail atomically for this cohort.
- A query-counting integration test proves the post-enqueue hot path performs claim/checkpoint/settlement writes and no row SELECT or plan preparation.
- One Ring has at most one external effect; four different Rings may execute concurrently.
- ACK settles before advance; stale checkpoint/settlement fences cannot advance.
- Transient, permanent/rejected, uncertain, and checkpoint-write failures preserve the specified scope behavior.
- The legacy dispatcher cannot claim `ring` rows, and the Ring engine cannot claim `legacy` rows.
- Verify focused CAS/store tests, Gateway executor tests, concurrency tests, typecheck, build, and full suite.

**Blocked by:** T2A, T3, T4.

### - [x] T5A: Advance safely past superseded replaceable Card-update heads

**What to build**

Add the low-cost head-of-line optimization for replaceable Card updates. When the authoritative scope head is durably proven not started or rejected, and a durably reserved successor addresses the same exact Card with a higher `snapshotRevision`, perform dismissal, replacement linkage, successor release, and authoritative head advance in one SQLite transaction. Treat delivered and explicitly dismissed rows, plus dead letters whose linked replacement is durably completed, as terminal for head discovery.

**Spec references**

SCN-5, SCN-9, SCN-13; INV-4, INV-5, INV-9, INV-11; Pane Ring Lifecycle; Coalescing and Supersession; Failure and Recovery Semantics.

**Ownership and implementation path**

The Prepared Delivery Store owns one atomic compare-and-transition operation over the current head, exact Card target identity, effect certainty, replacement identity, and strictly increasing snapshot revision. The transition persists the explicit dismissal and replacement relation before it releases the successor and exposes the next durable head. Delivery Engine discards stale cached objects and refills from the returned scope wake; it does not infer supersession, add another ordering key, or execute more than one effect for the Pane.

**Acceptance criteria and verification**

- Only replaceable Card updates with effect certainty `not-started` or `rejected` are eligible; uncertain effects and active human-review quarantine remain blocking.
- The replacement is already durably reserved, targets the same exact Card, and has a strictly higher `snapshotRevision`; creates, deletes, messages, streams, frozen Answer pages, different targets, and equal/lower revisions cannot use this transition.
- Dismissal, replacement linkage, successor release, and authoritative head advance commit atomically or make no change.
- Concurrent supersession and claim attempts produce one valid winner; a stale Ring item cannot call the Gateway or advance the scope.
- Delivered and explicitly dismissed heads do not block; a dead letter stops blocking only after its linked replacement is durably completed. Other dead letters, uncertain effects, and active human-review quarantine continue to block.
- The optimization introduces no `conflictKey`, secondary intra-Pane partition, or intra-Pane concurrency; one Pane Ring still has at most one external effect.
- Verify focused store/CAS tests, terminal-head discovery tests, race tests, Delivery Engine refill tests, typecheck, build, and full suite.

**Blocked by:** T5.

### - [x] T6: Converge restart, overflow, retry, cooldown, and shutdown through cold recovery

**What to build**

Complete Delivery Engine lifecycle behavior: startup discovery, missed-enqueue recovery, overflow refill, retry timers, Gateway cooldown wake-up, partial-checkpoint rehydration, expired-claim handling, oversized cold execution, periodic safety scans, and graceful stop. Cached retry objects are discarded and rehydrated; Ring state is never required for correctness.

**Spec references**

SCN-3, SCN-7, SCN-8, SCN-9, SCN-13; INV-1, INV-5, INV-8 through INV-11; Cold Recovery Path; Pane/Global Ring Lifecycle; Failure and Recovery Semantics; Rollback.

**Ownership and implementation path**

Delivery Engine owns timers, refill requests, quiescence, and cache invalidation. SQLite owns eligibility and recovery facts. Gateway cooldown remains durable and makes affected Rings non-runnable. The instance lease fences all recovered claims. An oversized valid item bypasses cache but still uses scope serialization and the global permit.

**Acceptance criteria and verification**

- Crash before COMMIT produces no work; crash after COMMIT/before enqueue is recovered.
- Crash after claim/before call, after provider ACK/before settlement, and after settlement/before reschedule follows existing certainty/idempotency rules without blind replay.
- Retry/cooldown expiry hydrates current checkpoints and eligibility, not the stale cached object.
- Overflowed and oversized work eventually executes in scope order without exceeding cache accounting.
- Startup and safety scans are bounded and coalesced.
- Stop starts no new effects, waits for tracked active settlement to its deadline, and leaves all remaining work discoverable.
- Lease loss stops authoritative progress; a new owner recovers durable work.
- Verify file-backed restart/fault-injection tests, fake-clock lifecycle tests, runtime-shutdown tests, typecheck, build, and full suite.

**Blocked by:** T5A.

### - [x] T7: Migrate all remaining Primary Pane delivery families

**What to build**

Migrate Primary Main Cards, Answer pages and streams, Pane/thread entry surfaces, Primary operation results, message deletions, and their recovery replacements through atomic PreparedDelivery reservation and the scoped Delivery Engine. Preserve each family's existing target guards, CardKit sequence rules, coalescing, supersession, and frozen-page behavior. Keep Worker and truly non-Pane Global work on the legacy executor.

**Spec references**

SCN-1, SCN-4 through SCN-10, SCN-12, SCN-13; INV-1 through INV-11; Coalescing and Supersession; Failure and Recovery Semantics; Incremental Cutover steps 6-7.

**Ownership and implementation path**

Each Primary producer uses the common reservation seam but retains its domain-owned rendering and supersession policy. The composition root selects the executor from durable `scheduler_owner`; claim predicates remain mutually exclusive. Existing target checks become atomic claim predicates using persisted projection/page/thread identities. Recovery transitions return replacement work through the same reservation path.

**Acceptance criteria and verification**

- Primary Main/Answer/Pane/thread/delete effects are frozen before COMMIT and delivered from their correct Primary Pane Ring.
- Existing first-paint, interactive coalescing, terminal flush, stream sequence, continuation-page, replacement, and deletion outcomes remain unchanged.
- Target staleness and recovery replacements are rejected or rebuilt through existing durable policies without cross-generation retargeting.
- A blocked Primary Pane affects no other Pane, while all effects in that Pane retain strict scope order.
- Mixed Primary-Ring and Worker/Global-legacy execution has exactly one eligible executor per row.
- Focused family tests, outbox/recovery tests, typecheck, build, full suite, and architecture review pass.

**Blocked by:** T6.

### - [x] T8: Migrate Worker and Global families and complete scoped cutover

**What to build**

Migrate Worker Main/Task/stream/thread delivery and non-Pane Global effects through PreparedDelivery reservation and the Delivery Engine. Backfill only historically proven parent Primary scopes and owner fences, restrict the legacy dispatcher to explicitly legacy/unscoped debt, expose final Ring diagnostics through health/status/restart gates, and implement the pre-contraction rollback procedure. Remove shadow-only comparison after its mismatch budget reaches zero.

**Spec references**

SCN-1, SCN-4 through SCN-14; INV-1 through INV-12; Worker-to-parent-Primary scope; Global Ring Lifecycle; Observability; Schema Migration; Incremental Cutover steps 7-8; Rollback.

**Ownership and implementation path**

Worker delivery routes by its trusted parent Primary workspace and Pane ID, maps Worker ID, runtime generation, and Worker-session generation into the separate common owner fence, and includes optional parent Binding authorization lineage in claim validity when present. A Worker Pane ID never forms delivery scope. Global is reserved when no trusted parent Primary Pane exists. Migration maintenance converts a legacy row to `ring` only when durable data proves its complete parent Primary scope and delivery fence and no active/uncertain claim exists. Ambiguous rows stay legacy for explicit classification or drain. Operational summaries translate old lane-centric fields compatibly until T9.

**Acceptance criteria and verification**

- Worker Main/Task/stream/thread effects enter the exact parent Primary Ring and reject stale Worker/runtime/parent fences atomically; no Worker delivery creates a Ring.
- Non-Pane effects use the single Global Ring; stale Pane effects never fall back to it.
- Every actionable row has exactly one eligible executor throughout mixed operation.
- Proven rows migrate idempotently; ambiguous or uncertain rows are not guessed, dropped, or retargeted.
- Pane isolation and live/history fairness remain visible under a production-shaped mixed backlog.
- Health, status, logs, integrity, and restart safety report Ring counts/bytes, scoped backlog, legacy debt, active claims, cooldown, quarantine, and oldest ages.
- Rollback fences active Ring attempts, discards caches, and restores legacy execution for rows retaining compatibility metadata without rewriting frozen effects.
- Startup/recovery and service lifecycle tests pass in legacy-only, mixed, ring-only, and rollback configurations.
- Run typecheck, build, full suite, public audit, a non-mutating real-user smoke, and staged-service status before requesting operational cutover.

**Blocked by:** T7.

### - [x] R1B: Preserve the ready handoff after an active Ring attempt

**What to build**

Repair the scheduler handoff when a completed or unclaimable head causes a
refill while its Ring still owns an active permit. A successor discovered by
that refill must become runnable after the permit is released. Periodic safety
and retry refills must also re-evaluate cached due heads whose earlier ready
notification was not admitted. Do not immediately requeue the same
unclaimable head and create a hot loop.

**Spec references**

INV-4 scope order, INV-6 fair scheduling, INV-7 restart recovery, INV-10
bounded acceleration, and the R1 safety-scan requirement.

**Ownership and implementation path**

`RingDeliveryEngine` owns the ordering between attempt completion, scheduler
permit release, refill and `makeReady`. `PreparedDeliveryRing` and
`DeliveryReadyScheduler` retain their existing single-token and single-active
grant invariants. No durable row, claim predicate, ordering key, retry state,
quarantine policy or Gateway effect is changed.

**Acceptance criteria and verification**

- A successor discovered while its predecessor still owns the permit executes
  after release.
- A cached due head with a lost ready signal is restored by the next safety
  scan.
- The same still-unclaimable head is not immediately hot-looped.
- Existing ACK, failure, retry, fairness and cold-recovery tests remain green;
  typecheck, build, architecture checks and the full suite pass.
- Deploying the fix advances the affected `xlcq` Pane Ring without replaying an
  uncertain effect.

**Blocked by:** None.

### R1: Operational contraction gate

This is a release gate, not a code ticket and not authorization to deploy. T9 remains blocked until all evidence is recorded:

- zero actionable unscoped or `legacy` rows and zero scheduler-ownership mismatches;
- zero unexplained safety-scan discoveries over the agreed observation window;
- no stale/uncertain active claims and no unresolved migration-specific integrity findings;
- scope-head query plans use the intended indexes and meet the measured backlog budget;
- Ring memory, overflow, oldest-head age, 3:1 fairness, retry, cooldown, and Gateway latency remain within existing operational expectations;
- rollback rehearsal succeeds before the rollback window is explicitly closed.

Production installation, restart, observation duration, and rollback-window closure require their normal explicit operational authorization; Gate 3 authorizes code implementation, tests, and atomic commits only.

Evidence recorded on 2026-10-06:

- Deployed `f49a3e93` reports zero legacy, scoped-legacy, and unscoped-legacy debt, zero active Ring claims, matching service/build identity, ready dependencies, and healthy SQLite integrity.
- The indexed 20,000-row/200-scope fixture returned a bounded 64-head page in about 655 ms, below its 2,000 ms budget.
- Before the rehearsal snapshot restart, deployed `767236d2` completed a 33-minute observation window with 65 safety scans, zero safety-scan discoveries, no Delivery Engine failure, and no overflowed scope. The controlled snapshot restart reset the process-local counters, so a final post-rehearsal window remains open.
- A 123-second non-mutating real-user smoke completed with zero status-poll failures. Its explicit human Feishu interaction remains outstanding.
- The repository-wide public release audit passes after commits `ee642f2d` and `bebcbdc4` replaced historical personal paths and literal co-author trailer examples with neutral documentation/test fixtures.
- A stopped-service SQLite online backup produced a 4.2 GiB consistent copy with `quick_check=ok`. Running the official offline rollback on that copy moved all 51 safe pending rows to legacy and reported `ringOwnedPending=0`, `legacyDebt=51`; the production database stayed in Ring mode and the temporary copy was removed after verification.
- The deployed build completed more than 30 minutes of observation with zero
  safety-scan discoveries, zero overflow, no Delivery Engine failure, and no
  legacy/unscoped debt. The post-rehearsal process also remained ready with zero
  discoveries through 48 recorded safety scans.
- The user explicitly authorized completing the remaining tasks and closed the
  rollback window on 2026-10-06 after the successful rehearsal and stable
  observations. T9 contraction is authorized; rollback now means deploying a
  pre-contraction release with its compatible database restore procedure, not
  switching this database back to lane mode.

### - [x] T9: Remove the legacy lane scheduler and contract compatibility schema

**What to build**

After R1 passes, remove the global reference Ring, `OutboundLaneDrain`, lane-head maintenance, `outbox_lane_heads`, obsolete lane-selection interfaces, dual scheduler ownership, and legacy-only diagnostics. Keep only scope-indexed cold discovery and the Pane/Global Delivery Engine. Update current architecture and Delivery and Operations language from fine-grained Delivery Lane scheduling to Delivery Scope/Ring semantics.

**Spec references**

SCN-1, SCN-4, SCN-5, SCN-10, SCN-12; INV-1, INV-4, INV-5, INV-10, INV-12; Schema Migration; Incremental Cutover step 9; Rollback; Trade-offs and Rejected Alternatives.

**Ownership and implementation path**

Use an expand-contract migration that verifies no actionable legacy ownership before dropping the derived lane-head table. Remove obsolete runtime and port surfaces rather than wrapping them. Preserve `delivery_order`, frozen effect identity, recovery/audit history, and any retained historical `lane_key` data needed for old audit interpretation until a separately justified retention migration exists.

**Acceptance criteria and verification**

- Migration refuses contraction when actionable legacy/unscoped work exists.
- Reopen after contraction discovers and delivers scoped work without lane tables or lane APIs.
- No runtime source imports or constructs the old global reference Ring or lane drain.
- Health/status and docs describe Pane/Global scopes and retain necessary compatibility field translation for stored history.
- Large-backlog cold discovery stays within the R1 measured query budget.
- Migration, architecture-boundary, docs, integrity, restart, and delivery tests pass; typecheck, build, full suite, and public audit pass.
- Review the complete outgoing diff and commit range before any separately authorized push.

Evidence recorded on 2026-10-06:

- Schema migration 109 refuses actionable legacy, unscoped, or otherwise invalid Delivery Scope debt before contraction, including scheduler-less partial-contraction databases, and rejects Global rows carrying Pane owner fences.
- Production composition now runs only the Pane/Global `RingDeliveryEngine`; legacy dispatcher, executor, reference Ring, lane drain, scheduler mode, lane-head table, rollback command, and production exact-ID claim capability are removed.
- Exact pending recovery replacements retain the failed head's effective Ring priority, so unrelated later work cannot pass them through either cold discovery or exact-scope refill.
- Fresh verification passed: 605 suites and 4,055 tests, TypeScript typecheck, build, 504-file architecture import check, public release audit, and diff check. The tracked-document set passes documentation audit; the repository-wide command additionally reports only stale links in the preserved user-owned untracked research note.
- Independent standards and specification reviews found no remaining blocking issue after the migration-scope and replacement-priority repairs.

**Blocked by:** T8 and R1.

## Coverage Check

| Specification guarantee | Responsible tickets |
| --- | --- |
| SCN-1 atomic hot commit | T2, T5 |
| SCN-2 rollback | T2 |
| SCN-3 missed enqueue/restart | T3, T6 |
| SCN-4 Pane isolation | T2A, T4, T5, T7, T8 |
| SCN-5 strict scope order | T3, T4, T5, T5A |
| SCN-6 generation replacement | T1, T2, T2A, T5, T7, T8 |
| SCN-7 memory/overflow | T4, T6 |
| SCN-8 retry/checkpoint | T2, T3, T5, T6 |
| SCN-9 uncertain effect | T3, T5, T5A, T6 |
| SCN-10 live/history fairness | T4, T7, T8 |
| SCN-11 explicit prerequisite | T3, T5 |
| SCN-12 migration/rollback | T1, T2A, T3, T8, T9 |
| SCN-13 safe head advance | T5A, T6, T7, T8 |
| SCN-14 Pane lifecycle | T2A, T4, T5, T8 |
| INV-1 durable truth | T1, T2, T2A, T3-T5, T5A, T6-T9 |
| INV-2 commit before enqueue | T2, T4 |
| INV-3 frozen effect | T2, T5 |
| INV-4 scope order | T1, T2A, T3-T5, T5A, T7-T9 |
| INV-5 one effect per Ring | T4, T5, T5A, T6 |
| INV-6 generation fence | T1, T2, T2A, T5, T7, T8 |
| INV-7 explicit cross-Ring dependencies | T1, T3, T5 |
| INV-8 no Agent Input replay coupling | T2, T5-T9 |
| INV-9 checkpoint before advance | T2, T5, T5A, T6 |
| INV-10 bounded acceleration | T3-T9 |
| INV-11 durable terminal advance | T5A, T6-T8 |
| INV-12 Primary-Pane-only Ring identity | T2A, T3-T5, T8, T9 |

Every ticket traces to approved behavior. T3 and T4 are parallelizable only after T2A and edit separate primary modules; integration starts at T5. T9 is intentionally not implementation-ready until R1 passes. No other load-bearing design decision is unresolved.

## Final Delivery Checks

After all authorized tickets and R1 are complete:

- map each SCN/INV to committed tests and actual fresh output;
- review source dependency direction and all external target-validation entry paths separately from behavior tests;
- inspect the complete diff and every ticket commit for unrelated/user-owned changes;
- run affected suites, `npm run typecheck`, `npm run build`, `npm test`, and `npm run public:audit`;
- validate configuration and run non-mutating real-user smoke/status checks;
- update the plan checkbox only after each ticket's acceptance and verification pass;
- create one atomic Conventional Commit per ticket, stage only ticket-owned paths, do not add a `Trae CLI co-author attribution` trailer, and do not push without separate authorization.
