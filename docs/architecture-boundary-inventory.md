# Architecture Boundary Inventory

## Purpose

This inventory turns the repository-wide Clean Architecture goal into bounded,
verifiable seams. A seam is complete only when it has a consumer-shaped
interface, one explicit authority, isolated external effects, explicit recovery
semantics, production composition in `src/composition/`, and tests that exercise
the interface rather than its internal wiring.

The inventory is intentionally organized by workflow responsibility rather than
directory or table. SQLite capabilities may participate in several seams while
sharing one `SqliteContext`; that does not make SQLite a business workflow.

## Completion criteria

Each seam must satisfy all of the following before it is marked complete:

1. The domain or application interface is smaller than its implementation and
   names the consumer capability rather than the concrete adapter.
2. SQLite, Herdr, and the Conversation Gateway retain their documented
   authority; process-local state is never promoted to durable authority.
3. Every external effect has a durable pre-effect fact, an idempotency or fence
   policy, and a conservative uncertain/recovery path.
4. Production construction occurs only in composition and shutdown ownership is
   explicit.
5. Focused tests cover success, duplicate delivery, stale identity, failure,
   recovery, and shutdown where those cases apply.
6. Architecture checks prevent the most likely dependency-direction regression.

## Major seams

| Order | Seam | Authority | Target deep module and interface | Current assessment | Concrete completion evidence / next gap |
| --- | --- | --- | --- | --- | --- |
| 1 | Runtime events and work scheduling | SQLite or fresh Herdr state; never the in-process bus | `RuntimeEventBus` behind lifecycle, inbound, work, and Herdr-specific interfaces | Complete | Closed typed channels, named subscribers, startup buffering, keyed coalescing, failure diagnostics, awaited shutdown, and architecture checks. `runtime-event-bus.test.ts` covers the engine. |
| 2 | Exact-turn control and steering | SQLite operation state plus fresh exact Herdr turn identity | `TurnControlWorkflow` for validation/acceptance; `TurnControlDispatcher` for owner-serialized effects | Complete | Active control returns after durable acceptance; dispatcher revalidates and claims before effect. Same-owner order, cross-owner independence, and accepted-versus-dispatching recovery are covered by `turn-control-dispatcher.test.ts`. |
| 3 | Inbound admission and routing | Durable inbound rows and frozen routing context | `DurableInboundPipeline`, `InboundMessageRoutingWorkflow`, and `PromptAdmissionWorkflow` | Complete | The pipeline owns authorization, compact durable admission, scope-FIFO claim/release, retry, recovery, shutdown settlement, and the sole completion log. Routing returns one structured disposition, while ordinary and initial Prompt acceptance share one atomic workflow. Runtime hints contain only `eventId` and are best-effort; SQLite scanning remains authoritative. |
| 4 | Primary execution and observation | Prompt rows, binding generation, native session, and exact transcript identity | `PromptRunWorkflow` lifecycle facade over `PrimaryPromptDispatcher`, `PromptTurnExecutor`, and `DetachedPromptObserver` | Complete | The facade owns scheduling, safety, process-local exclusion, recovery controls, and shutdown. `drain(bindingId)` hides durable FIFO claim, fresh-pane preflight, fenced release, execution, and archive policy; `observe(prompt)` hides exact-turn reopening, ownership, polling, settlement, and uncertain no-replay recovery. |
| 5 | Worker lifecycle, execution, and observation | Agent instance generation, Worker turn rows, and exact transcript identity | `WorkerTurnDispatcher`, `WorkerTurnObserver`, and `InstanceTurnSupervisor` behind dispatch and observation ports | Complete | Durable FIFO execution now lives in coordinator rather than events and consumes `WorkerTurnDispatchStore`. Exact live/restart observation stays behind `WorkerTurnObservationPort`; process-local single flight and watches remain non-durable hints while uncertain delivery never replays. |
| 6 | Card projection and convergence | Durable Run Card, Worker Turn Card, Main Card, page, and delivery-version state | Pure view reducers plus `AnswerPageWorkflow`, `MainCardWorkflow`, and `WorkerTurnCardWorkflow` | Complete | Primary and Worker continuation share one handoff policy; frozen-page offsets, checkpoint-gated Main Card retargeting, direct-Herdr pagination, duplicate convergence, stale targets, and startup recovery are covered through domain, workflow, SQLite, renderer, and context-rebuild tests. |
| 7 | Durable outbound delivery | SQLite outbox rows, lane heads, claims, and delivery checkpoints | `GatewayOutboxDispatcher` lifecycle facade over `OutboundLaneDrain`, `OutboundDeliveryExecutor`, and `GatewayDeliveryPort` | Complete | The facade owns notifier subscription, safety/retry timers, dead-letter recovery, diagnostics, and shutdown. The drain engine owns bounded 3:1 lane scheduling, per-scan exclusion, same-reply protection, and fatal checkpoint convergence through `OutboundScanStore`; the executor owns one frozen claim-to-checkpoint attempt through `OutboundDeliveryStore`. |
| 8 | Herdr runtime reconciliation | Fresh Herdr snapshot plus generation/session-fenced SQLite transitions | `HerdrRuntimeReconciler` lifecycle facade over `BindingReconciliationPass` and `BindingRuntimeConverger` | Complete | The facade owns cooldown, priority coalescing, periodic lifecycle, diagnostics, and shutdown. The pass owns targeted/full authoritative observation, classification, discovery, failure isolation, and pruning; the converger retains generation-fenced per-Binding transitions and downstream effects. |
| 9 | Command and control | Durable command intent and status view, with immutable resolved context | `SwarmCommandRuntime` over admission, durable observation, and `CommandIntentDispatcher` | Complete | Literal, CardKit, Primary Tool, and natural-language entry paths share typed admission. Mutation acceptance atomically persists intent/status/outbox and returns before the effect; intent-only hints plus SQLite scans drive execution. Worker results reconstruct from durable operation identity, and only destructive natural-language commands require confirmation. |
| 10 | Runtime lifecycle, health, and operations | User systemd plus fenced SQLite lease; health is observation only | `ManagedBridgeRuntime`, `RuntimeLifecycleLedger`, `BridgeRuntimeShutdown`, and `HealthSnapshotCollector` | Complete | Possibly started resources register cleanup before or with start; write-capable shutdown failures retain the fence, lease, and store. The collector owns coherent fail-closed readiness, isolated bounded diagnostics, degradation policy, and single-flight caches, while the HTTP adapter owns only transport. Lifecycle and health tests cover partial startup, ordering, lease loss, stuck writers, provider failure, redaction, and cache behavior. |
| 11 | SQLite capability graph and migrations | One fenced `SqliteContext` and ordered schema migration | Consumer-shaped store ports backed by `SqliteCapabilityGraph` | Complete | One graph owns context, migrations, concrete collaboration, and published capability aliases. Production consumers cannot import concrete SQLite modules; compatibility facades remain test-only. Construction links make cycles explicit and fail fast, while nested transactions and post-commit receipts preserve atomic workflow effects. |

## Execution order

All prioritized seams are complete. Future work should be driven by a concrete
behavioral requirement or observed operational failure rather than further
horizontal module splitting.

## EventBus completion evidence

The Runtime EventBus pass is complete because the production composition creates
one `RuntimeEventBus`, existing workflows still receive narrow interfaces, and
active turn control uses only an owner-keyed work hint. SQLite remains the source
of accepted operations and the dispatcher reloads it before every claim. The bus
contains no generic business publisher and no durable event log.

Verification on 2026-09-24:

- focused EventBus, turn-control, ingress, lifecycle, steering, and architecture
  tests: 8 files and 153 tests passed;
- full Vitest suite: 195 files and 2,630 tests passed;
- TypeScript typecheck, production build, architecture import check,
  documentation audit, and `git diff --check` passed.

## Card convergence completion evidence

The Card projection pass is complete because Primary Answer, Primary Main,
Worker Task, and Worker Main each converge from durable SQLite state through
consumer-shaped workflows. Continuation creation retains the previous valid
target until delivery checkpoints the new page; that checkpoint freezes earlier
pages without rewriting their canonical source offsets and invalidates the
owning Main Card contexts for deterministic rebuild. Startup recovery uses the
same `WorkerTurnCardWorkflow` interface as live changes.

Verification on 2026-09-24 covers shared continuation wording, frozen Primary
and Worker pages, latest-page navigation, missing-target suppression, duplicate
reservation, monotonic stream sequence, retry/dead-letter waits, direct-Herdr
long answers, and startup convergence.

## Inbound admission and routing completion evidence

The inbound pass is complete because `DurableInboundPipeline` exposes only
`start`, `stop`, `recover`, `receive`, and `snapshot`, while hiding authorization,
bounded persistence, scope-local FIFO draining, retry timers, and interrupted-claim
recovery. `receive` returns after durable admission and never waits for routing or
a process-local subscriber. A failed or lost content-free hint is diagnostic only;
the pipeline directly requests a SQLite-backed drain and retries route failures.

`InboundMessageRoutingWorkflow.route` owns route precedence and returns one
structured decision/disposition. It does not own inbox lifecycle or Prompt
transactions. `PromptAdmissionWorkflow` is the single interface for ordinary and
initial-project Prompt acceptance, including Answer root selection, queue position,
atomic Run Card/outbox intent, post-commit effects, and queue-full feedback.

Verification on 2026-09-24: focused Inbound/EventBus/composition/architecture
tests passed (9 files, 156 tests); the full suite passed (196 files, 2,635
tests); TypeScript typecheck, production build, architecture import check,
documentation audit, and `git diff --check` also passed.

## Primary execution and observation completion evidence

The Primary pass is complete because `PromptRunWorkflow` is now a lifecycle
facade rather than the implementation owner for dispatch and detached polling.
It retains scheduler subscription, safety scans, process-local worker exclusion,
manual awake/skip controls, diagnostics, and shutdown. `PrimaryPromptDispatcher`
owns the per-Binding durable FIFO loop and permits claim release only before
dispatch evidence. `DetachedPromptObserver` reloads durable identity and settles
only the exact persisted transcript turn; uncertain observation remains detached
and never submits the Prompt again. `PromptTurnExecutor` remains the single live
attempt module and hands its process-local cursor directly to the detached
observer when an attached wait becomes uncertain.

Verification on 2026-09-24 covers fresh busy-pane release, exact detached-turn
settlement, attached-to-detached cursor continuity, startup recovery, safety
scanning, FIFO concurrency, architecture dependency direction, and the full
repository suite.

## Worker execution and observation completion evidence

The Worker pass is complete because durable FIFO execution now belongs to
`WorkerTurnDispatcher` in the coordinator layer, behind a lifecycle interface
and the consumer-shaped `WorkerTurnDispatchStore`. The dispatcher retains
per-instance single flight, Agent receipt classification, exact watch handoff,
uncertain no-replay behavior, and shutdown fencing as one deep module.
`WorkerTurnObserver` remains the sole exact transcript owner for both live watch
and restart recovery, while `InstanceTurnSupervisor` owns durable recovery scans
and fresh Herdr Pane validation.

Verification on 2026-09-24 covers exact-turn detachment after submission failure,
FIFO dispatch, structured and unstructured Agents, observer ownership, recovery
supervision, shutdown, composition, architecture dependency direction, and the
full repository suite.

## Durable outbound delivery completion evidence

The outbound pass is complete because `GatewayOutboxDispatcher` is now a
lifecycle facade rather than the owner of lane scheduling and single-reply
delivery. `OutboundLaneDrain` hides the four-slot work-conserving scan, live to
history 3:1 selection, lane exclusion, same-reply suppression, wake revision,
batch bound, and fatal checkpoint settlement behind `notifyRequest()` and
`drain(...)`. `OutboundDeliveryExecutor` remains the sole owner of frozen plan
preparation, exact claim, external execution, checkpoint, failure classification,
and durable settlement.

SQLite remains the delivery authority through separate `OutboundScanStore` and
`OutboundDeliveryStore` capabilities. Process-local sets, counters, timers, and
wake revisions affect only when eligible durable work is inspected. A failed
lane is blocked only for the current scan, a checkpoint failure stops new claims
while already active deliveries settle, and restart recovery continues from
durable rows without repeating the corresponding Agent turn.

Verification on 2026-09-24 covers independent-lane concurrency, current-scan
failure isolation, 3:1 work-class fairness, claim and checkpoint fencing, retry
and dead-letter behavior, shutdown settlement, composition, and architecture
dependency direction.

## Herdr runtime reconciliation completion evidence

The reconciliation pass is complete because `HerdrRuntimeReconciler` is now a
lifecycle facade rather than the owner of authoritative Pane classification and
Binding traversal. It retains request cooldown, priority scope coalescing,
periodic execution, last-reconciled timestamps, diagnostic snapshots, and
shutdown. `BindingReconciliationPass` owns baseline capture, targeted and
workspace/full observations, missing-Pane handling, bounded existing-Binding
convergence, safe discovery, pass-local ownership, warning deduplication, and
full-pass cache pruning behind `captureBaselines()` and `execute(scope)`.

`BindingRuntimeConverger` remains the sole owner of generation/session-fenced
per-Binding transitions, projection/event ordering, exact external-turn
observation, and scheduler wake decisions. No durable fact moved into the facade,
pass-local maps, warning signatures, or snapshot cache, and no reconciliation
path can submit or replay an Agent prompt.

Verification on 2026-09-24 covers combined existing/discovery classification,
targeted observation batching, scope priority and cooldown, unavailable and
mismatched workspaces, discovery ambiguity, interrupted provisioning, bounded
concurrency, recovery, exact external-turn observation, cache pruning, shutdown,
and architecture dependency direction.

## SQLite capability graph completion evidence

The SQLite boundary is complete because `SqliteCapabilityGraph` creates or
adopts one `SqliteContext`, runs the ordered migration runner before publishing
stores, and exposes only consumer-shaped capabilities through
`SqliteStoreBundle`. Concrete stores collaborate inside the adapter so
multi-table transitions keep one transaction and write fence. Construction-only
links represent the few dependency cycles without a partial aggregate or service
locator and fail on early or duplicate resolution.

Production source outside the store layer cannot import any concrete
`store/sqlite` module. The broad compatibility kernel exists only under test
helpers. Architecture checks also preserve inward dependency direction, central
migration ordering, guarded foreign-key rebuilds, intentional capability aliases,
and the absence of asserted or partial graph construction.

Verification on 2026-09-24: focused capability graph, context, StoreLink,
migration/store, and architecture tests passed (5 files, 385 tests). The final
repository gate is recorded in the completion audit below.

## Goal completion audit

The user goal is complete when the principal workflow and infrastructure seams
are identified, EventBus is completed first, every listed seam has a Clean
Architecture implementation with explicit authority and recovery behavior, and
the repository gates cover those claims. The following checklist maps each
requirement to current artifacts and executable evidence.

| Requirement | Artifact evidence | Verification evidence |
| --- | --- | --- |
| Identify the principal module boundaries | The Major seams table defines eleven ordered workflow and infrastructure seams, their authorities, target deep modules, and completion criteria. | Documentation audit validates the maintained architecture entry points. |
| Complete EventBus first | `RuntimeEventBus` plus `RuntimeEventIntegration` provide one typed engine behind lifecycle, inbound, outbound, Prompt, instance, turn-control, and Herdr hint interfaces. SQLite or fresh Herdr state remains authoritative. | Runtime EventBus and integration tests cover closed channels, startup buffering, coalescing, subscriber isolation, diagnostics, and awaited shutdown; commit history places the unified EventBus work before later seam passes. |
| Exact-turn control and steering | `TurnControlWorkflow` durably accepts and fences work; `TurnControlDispatcher` serializes effects by owner and revalidates exact runtime identity. | Turn-control workflow/dispatcher and steering integration tests cover ordering, stale identity, recovery, failure, and shutdown. |
| Inbound admission and routing | `DurableInboundPipeline`, `InboundMessageRoutingWorkflow`, and `PromptAdmissionWorkflow` separate durable FIFO admission, routing, and atomic Prompt acceptance. | Inbound dispatcher/routing/admission and concurrency tests cover duplicate admission, retry, queue limits, recovery, and shutdown. |
| Primary execution and observation | `PromptRunWorkflow` is a lifecycle facade over `PrimaryPromptDispatcher`, `PromptTurnExecutor`, and `DetachedPromptObserver`. | Primary dispatcher, observer, safety-scan, turn-supervisor, and concurrency suites verify FIFO, exact observation, detachment, recovery, and no replay. |
| Worker execution and observation | `WorkerTurnDispatcher`, `WorkerTurnObserver`, and `InstanceTurnSupervisor` expose consumer-shaped dispatch and observation seams. | Worker dispatcher/observer/supervisor and instance integration suites verify FIFO, identity fencing, uncertain delivery, recovery, and shutdown. |
| Card projection and convergence | Pure reducers plus `AnswerPageWorkflow`, `MainCardWorkflow`, and `WorkerTurnCardWorkflow` converge durable card state. | Card, page, context-rebuild, startup-view, and event integration tests cover continuation, frozen pages, checkpoints, duplication, and recovery. |
| Durable outbound delivery | `GatewayOutboxDispatcher` delegates scan scheduling to `OutboundLaneDrain` and one attempt to `OutboundDeliveryExecutor`. | Outbound drain/dispatcher/store tests cover lane ordering, bounded concurrency, retries, dead letters, checkpoints, failure isolation, and shutdown. |
| Herdr runtime reconciliation | `HerdrRuntimeReconciler` delegates authoritative passes to `BindingReconciliationPass` and fenced transitions to `BindingRuntimeConverger`. | Reconciliation pass, reconciler, snapshot, discovery, and event tests cover targeted/full convergence, ambiguity, failures, pruning, and shutdown. |
| Command and control | `SwarmCommandRuntime` owns typed context/query/admission/observation; `CommandIntentDispatcher` owns durable lane execution, revalidation, recovery, and settlement. | Runtime, dispatcher, observer, natural-language, Card action, and Primary Tool tests cover source equivalence, risk admission, FIFO, idempotency, restart-safe results, stale context, uncertain no-replay recovery, and shutdown. |
| Runtime lifecycle, health, and operations | `ManagedBridgeRuntime`, `RuntimeLifecycleLedger`, and `BridgeRuntimeShutdown` own fenced lifecycle; `HealthSnapshotCollector` owns readiness/status policy behind a transport-only server. | Lifecycle, shutdown, health collector/server, service lifecycle, and architecture tests cover partial startup, writer settlement, lease loss, redaction, fail-closed readiness, caching, and diagnostics. |
| SQLite capability graph and migrations | `SqliteCapabilityGraph` and `SqliteStoreBundle` publish consumer ports over one context; migration modules execute through one ordered runner. | Capability graph, context, StoreLink, SQLite store/migration, and architecture tests cover aliases, fencing, atomic nesting, receipts, historical upgrades, and concrete-import prohibition. |
| Repository-wide quality gates | Architecture records describe current implementations and the import checker enforces dependency direction. | `npm run typecheck`, `npm run build`, `npm run architecture:check`, `npm run docs:audit`, `npm test`, and `git diff --check` are the final required gates. |
