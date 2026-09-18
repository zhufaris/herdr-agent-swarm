# Herdr Agent Swarm Architecture

## Who this is for

This document is for an engineer taking ownership of the bridge or diagnosing a
production session. After reading it, they should be able to identify the
authority for any observed state and follow a request from the configured
Conversation Gateway through Herdr and back to durable delivery. They should also be able to place a change
at the correct workflow, port, adapter, or composition seam without weakening
durability or recovery behavior.

## System purpose

Herdr Agent Swarm manages human-controlled Primary and Worker instances across
multiple projects on the Herdr headless runtime. It connects each managed Lark
topic to an agent process in a real Herdr pane, letting a person
start work, queue later requests, and see safe structured TraeX output in Lark while
preserving Herdr as the place for local observation and high-risk approval.

The bridge is a durable workflow coordinator, not a message relay. It does not
assume that a Lark API call, a Herdr snapshot, or a runtime event is a complete
transaction by itself.

## Architecture at a glance

The system is a ports-and-adapters application with one production composition
root. Application workflows depend on consumer-shaped domain ports. A statically
registered Conversation Gateway, Herdr, and SQLite adapters satisfy those ports
at the outside of the application. SQLite stores durable workflow facts; Herdr
remains authoritative for live runtime identity; the active Gateway displays
projections. Feishu is the only production Gateway in this milestone.

```text
┌──────────────────────────── External systems ────────────────────────────┐
│ Gateway / Feishu            Herdr / TraeX                  user systemd │
│ messages and views          panes, sessions, turns         process owner │
└──────────────┬──────────────────────┬───────────────────────────┬────────┘
               │ SDK / WebSocket      │ CLI / Socket / JSONL      │ lifecycle
               v                      v                           v
┌──────────────────────── Infrastructure adapters ────────────────────────┐
│ Gateway plugin · Herdr adapter · PaneHost · TranscriptReader · health  │
│ command runner · Agent drivers · worktree manager · SQLite bundle       │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │ concrete implementations
                              v
┌────────────────────────── Composition root ──────────────────────────────┐
│ Creates adapters, selects implementations, injects ports, and connects  │
│ lifecycle events, durable-work wake-ups, and runtime reconciliation.    │
└───────────────┬────────────────────┬───────────────────────┬─────────────┘
                │                    │                       │
                v                    v                       v
┌──────────────────────┐  ┌──────────────────────┐  ┌────────────────────┐
│ Ingress / Primary    │  │ Worker / Control     │  │ Projection / Outbox│
│ routing, acceptance  │  │ instance FIFO, exact│  │ card views, durable│
│ prompt FIFO, recovery│  │ turn observation     │  │ Gateway delivery   │
└──────────┬───────────┘  └──────────┬───────────┘  └─────────┬──────────┘
           └─────────────────────────┼────────────────────────┘
                                     │ consumer-shaped ports
                                     v
┌────────────────────────── Domain contracts ─────────────────────────────┐
│ Binding · Prompt · Instance · Turn · lifecycle transitions · reducers   │
│ FIFO · generation fences · exact-turn identity · no-replay invariants   │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │ implemented by
                              v
┌────────────────────── SQLite capability graph ──────────────────────────┐
│ One SqliteContext and one primary connection; named workflow, projection│
│ and delivery capabilities share transactions and a fenced writer lease. │
└──────────────────────────────────────────────────────────────────────────┘
```

The shortest useful request trace is:

```text
Gateway input
  -> plugin validation and provider-neutral normalization
  -> authorization
  -> durable inbound record
  -> routing and atomic prompt or command acceptance
  -> FIFO claim
  -> one fenced Herdr / TraeX effect
  -> exact transcript observation
  -> durable view reduction and outbox intent
  -> frozen Gateway plan and Gateway-scoped lane claim
  -> ordered Gateway delivery
```

Every arrow across an external-effect boundary has a durable fact on the SQLite
side. Process-local events and wake-ups reduce latency; durable scans and fresh
Herdr observations provide convergence when a hint is lost.

## Composition root

The composition root is the only production location that knows the complete
runtime topology. It creates concrete adapters, selects production
implementations for domain ports, constructs workflows, connects event and
wake-up handlers, and returns the runtime modules owned by process lifecycle.
It answers **who is connected to whom**; it does not decide **what business
transition should happen next**.

The top-level composition is divided into focused factories so the full graph
remains reviewable:

```text
createBridgeRuntime
│
├─ RuntimeEventIntegration
├─ createInfrastructureRuntime
│    └─ built-in Gateway registry/session, Herdr, PaneHost, transcripts, drivers, worktrees
├─ createOutboundRuntime
│    └─ projections, Answer/Main Card workflows, GatewayView, durable outbox drain
├─ createPrimaryRuntime
│    └─ prompt FIFO, exact turn supervision, external-turn observation
├─ createWorkerRuntime
│    └─ Worker acceptance, FIFO dispatch, observation, reconciliation
└─ createApplicationRuntime
     ├─ createBindingSessionRuntime
     ├─ createCommandControlRuntime
     └─ createIngressRecoveryRuntime
```

Each child factory receives only a typed selection of the capabilities it can
compose. Only the parent composition sees the complete SQLite bundle. This makes
an accidental cross-context dependency a compile-time error and keeps the
workflow interface visible at its construction site.

The composition root may:

- create adapters and workflows;
- inject consumer-shaped ports and validated configuration;
- connect lifecycle subscribers, durable-work wake-ups, and Herdr hint routes;
- select the production presentation and Agent drivers;
- return startable, stoppable, and observable runtime modules.

It must not:

- claim or reorder a Prompt or Worker-turn FIFO;
- decide whether an uncertain effect is safe to replay;
- perform Binding, Prompt, Instance, or outbox state transitions;
- parse terminal output or render cards;
- bypass a workflow by writing raw SQLite state or terminal input.

Three similarly shaped modules have deliberately different scopes:

| Module | Scope | Responsibility |
| --- | --- | --- |
| Application composition root | Whole running bridge | Connect external adapters, workflows, events, and lifecycle-owned modules |
| `SqliteCapabilityGraph` | SQLite adapter implementation | Create the single transactional context, run migrations, and expose named capabilities |
| `RuntimeEventIntegration` | Process-local runtime wiring | Connect four reliability-specific event and wake-up channels without creating another durable authority |

## Key design rules

The following rules define where new behavior belongs and which shortcuts are
unsafe. The detailed lifecycle, recovery, streaming, and delivery sections below
explain their implementation.

### Authority is split, not replicated

```text
Herdr  -> live pane, process, native session, and Agent-state authority
SQLite -> workflow intent, queues, fences, projections, outbox, audit, lease
Lark   -> visible messages and cards only
```

Never infer runtime truth from a card, and never repair SQLite from Lark output.
Reconcile live identity from Herdr, persist the resulting workflow transition,
then let projections and the outbox repair Lark.

### Consumer-shaped ports preserve deep modules

A workflow receives the smallest named interface that expresses its complete
responsibility. Startup view convergence explicitly receives startup recovery,
Answer-page, and Main-Card stores. Instance messaging, turn supervision, exact
observation, runtime reconciliation, and lifecycle control each use a named
consumer port. The concrete SQLite capability can satisfy several ports while
keeping SQL and transaction ownership internal. Narrowing an interface must not
split an atomic aggregate transition.

### One SQLite context owns atomic workflow transitions

Production constructs one `SqliteContext` and one primary `DatabaseSync`
connection. Prompt acceptance, Run Card projection, Worker-turn events, card
invalidation, and outbox intent can therefore participate in the same outer
transaction. The read-only integrity worker is the deliberate separate-connection
exception. New capability modules share the existing context; they do not create
their own connection or emulate a transaction across repositories.

### External effects are fenced and never guessed

Ordinary Prompt and Worker-turn queues are durable FIFO queues with one active
ordinary turn per owner. Before steering, stopping, observing, or settling a
turn, workflows fence the applicable binding or instance generation, pane,
native session, logical turn, runtime turn, and canonical runtime start time.
Work proven not to have started may return to dispatch. Work that may have
reached TraeX becomes detached or uncertain and is observed or explicitly
resolved; it is never automatically replayed.

### Delivery intent precedes delivery

User-visible workflow intent is committed before any Lark call. The durable
outbox provides idempotency, strict ordering within a lane, compare-and-swap
delivery checkpoints, bounded retry, dead-letter handling, and recovery. A Lark
retry can repeat only the delivery effect, never the corresponding TraeX prompt.
Frozen Answer pages are immutable; continuation proceeds on a new card.

### Events have four different reliability contracts

| Channel | Contract | Recovery authority |
| --- | --- | --- |
| Inbound notification | Durable SQLite record plus a wake-up hint | Inbox scan and interrupted-claim recovery |
| Lifecycle event | Committed canonical state plus typed process-local fan-out | Current SQLite projections |
| Work wake-up | Best-effort, coalescing, and owner-keyed | Durable queue scan |
| Herdr event | Bounded reconciliation hint | Fresh Herdr snapshot or targeted observation |

These channels share composition but not semantics. There is no generic durable
event log, no event sourcing, and no assumption that receiving an event proves a
state transition.

### Recovery converges from canonical state

Startup acquires the fenced SQLite lease, runs migrations and integrity checks,
recovers interrupted local claims, converges durable views, establishes runtime
baselines, and reconciles against fresh Herdr state. Lost events and process
restarts may delay convergence but must not change the final state. Recovery
never treats stale card text or a coarse idle observation as proof that an exact
turn completed.

## Lark authorization

The configured chat is necessary but not sufficient for access.
`LARK_ALLOWED_OPEN_IDS` is a mandatory prompt and card-action allowlist.
`LARK_ADMIN_OPEN_IDS` is a mandatory subset that gates Worker lifecycle and
session-topology changes. Unauthorized inbound messages are discarded before
durable ingress; unauthorized card callbacks return a generic denial. Per-thread
creator and generation checks remain additional fences for stateful operations.

## Ownership and authority

| Concern | Authority | Why |
| --- | --- | --- |
| Pane identity, terminal identity, native Agent session reference, agent state, foreground process | Herdr snapshot and targeted runtime observation | Herdr owns panes and the TraeX process. |
| Typed turn output, live status heading, structured plan, and token counters for an active turn | Exactly identified TraeX JSONL transcript | The transcript is parsed once into `TurnOutputObservation`; Answer Card and Main Card consume separate sub-projections without parsing each other's rendered text. |
| Binding lifecycle, prompt queue, delivery intent, retry state, audit, lease | SQLite | These facts must survive a bridge restart. |
| Visible cards and messages | Lark | Lark is the external delivery target, not the source of workflow truth. |
| Process lifecycle | user systemd service | The standalone `npm run swarm:*` commands control the service; the application does not manage PID files. |
| Runtime event integration | `RuntimeEventIntegration` with four explicit reliability classes | It composes lifecycle fan-out and wake-up channels without making them one delivery or replay contract. |
| Herdr socket events | bounded wake-up hints | Events improve latency but do not create a second event log. |

When these sources disagree, do not repair SQLite from a Lark card or infer a
pane state from a card. Reconcile against Herdr, then let the normal projection
and durable Lark outbox converge the visible state.

An operator can explicitly observe a binding blocked by an exact-owned detached
prompt with `/swarm awake`. This path reopens the matching TraeX transcript
immediately after the detached turn's exact completion boundary, or at the next
distinct turn start when interruption left no completion record, adopts later
turns in chronological order into separate Answer Cards, and then wakes the
ordinary prompt FIFO. It never submits text to TraeX. Missing, incomplete, or
mismatched boundaries fail closed and leave the detached prompt unchanged.

When observation cannot recover that blocker, the topic creator may use
`/swarm skip`. One durable command invocation atomically fails only the oldest
ordinary `running` / `detached` prompt for the frozen binding generation, updates
its Run Card and outbox intent, records an audit entry, and then wakes the FIFO.
The prior runtime outcome remains explicitly uncertain; skip never sends terminal
input, interrupts TraeX, or replays the prompt.

## Architecture and dependency direction

Dependencies point inward: domain contracts define the language and capabilities
required by workflows; workflows coordinate use cases; infrastructure adapters
implement ports for SQLite, Herdr, Lark, and the host runtime. A concrete adapter
must not become the source of workflow policy. Workflows do not embed Lark SDK
calls, Herdr CLI parsing, or SQLite-specific decisions.

The process entry point only loads configuration and build identity, registers
signal handlers, reports startup, and applies exit-code policy.
`createManagedBridgeRuntime()` constructs the store, lease, runtime graph, and
health server dependencies. `ManagedBridgeRuntime` is the lifecycle authority
for ordered startup, lease-loss handling, partial-start cleanup, and idempotent
shutdown. Runtime modules do not read deployment paths or process-manager state
directly.

### Current implementation map

The production implementation uses the following modules and seams.

| Module | Responsibility | Seam |
| --- | --- | --- |
| `ManagedBridgeRuntime` / `createManagedBridgeRuntime` | Runtime lifecycle policy and production resource composition | The process entry point sees only `start()` and `stop(reason)`; component order and partial-start state remain internal |
| `InboundRouter` | Normalized inbound routing and durable acceptance | Workflow ports only; concrete construction remains in the composition factories |
| `SwarmCommandGateway` | The single context boundary for every `/swarm` query and mutation, including CardKit Worker creation | Exhaustive policy, immutable command context, and `CommandIntentStore` |
| `PromptRunWorkflow` | FIFO turn execution and detached recovery | Separate `PromptDispatchStore`, `PromptRecoveryStore`, and `PromptSessionStore` capabilities plus `HerdrPort`, `TraexControlPort`, and `PromptWorkScheduler` |
| `ProjectCatalog` | Canonical project lookup, route disambiguation, and binding-to-visible-space resolution | Pure immutable catalog over validated project configuration; stale and ambiguous routes fail closed |
| `InstanceMessagingWorkflow` / `InstanceWorkScheduler` | Worker turn acceptance, exact steering, FIFO dispatch, task-card intent, and no-replay recovery | Generation-fenced instance lifecycle/turn capabilities and Agent driver hooks; Lark and Primary-tool submissions use server-owned topic roots |
| `WorkerTurnObserver` | Claims and follows the exact structured transcript owned by a Worker turn | Runtime turn ID, canonical start time, and instance generation must all match |
| Worker task-card projection | Per-turn lifecycle, result pages, recent-history summaries, and navigation | Pure reducers/renderers over durable Worker turn/card state |
| `HerdrRuntimeReconciler` | Authoritative pane/runtime convergence | Identity-fenced `RuntimeReconciliationStore` transitions |
| `ModelSelectionWorkflow` / `PaneControlWorkflow` | Session-scoped model catalog/preferences plus Primary command adaptation and legacy control-row recovery | `TraexControlPort` plus shared exact-turn `TurnControlWorkflow`; no raw terminal-input seam |
| `TurnControlWorkflow` | Durable Primary/Worker priority follow-up and exact-turn stop | Generation, pane, native-session, logical-turn, and runtime-turn fences before Herdr effects |
| `PaneClosureWorkflow` / `SessionAdministrationWorkflow` | Destructive pane closure and non-destructive session administration | Separate lifecycle capabilities |
| `OperationsQueryWorkflow` / `DeliveryRecoveryWorkflow` | Read-only operational cards and delivery recovery decisions | Query and recovery capabilities separated from control |
| `ConversationViewProjector` | Run-card and topic-view reduction plus outbound intent creation | `ProjectionStore` and `OutboundIntentPort` |
| `StartupViewConverger` | Rebuilds startup-visible Answer and Main Card state from durable canonical projections | Named `StartupViewProjectionStores`; startup recovery, Answer pages, and Main Cards are explicit stores with no type assertion |
| `GatewayOutboxDispatcher` | Durable Gateway delivery, retries, dead letters, and Answer-card checkpoints | `OutboxStore` plus one negotiated `GatewayDeliveryPort`; no direct aggregate mutation |
| `createSqliteStoreBundle` / `SqliteCapabilityGraph` | Constructs the SQLite implementation once and exposes consumer-specific port views | One shared `SqliteContext`; production code cannot import the broad compatibility facade |
| `SqliteStoreKernel` / `SqliteBindingStore` | Test and headless-smoke compatibility facades | Non-production adapters over the capability graph; they contain no schema ownership and cannot be imported by production source |
| `SqliteBindingLifecycleStore` / `SqliteBindingProjectionStore` | Binding lifecycle, reset, cleanup, runtime convergence, and binding-owned projections | Keep lifecycle and projection responsibilities separate while sharing one transaction context |
| `SqlitePromptAcceptanceStore` / `SqlitePromptDispatchStore` / `SqlitePromptRecoveryStore` / `SqliteExternalTurnAdoptionStore` | Primary Prompt admission, exact dispatch, no-replay recovery, and Herdr-originated ownership | Each deep module owns one protocol while sharing the same context for cross-table Prompt, projection, invalidation, and outbox transactions |
| `SqlitePromptStore` / `SqliteWorkerTurnStore` / `SqliteTurnControlStore` | Primary queue feedback and control helpers, Worker turns, and exact-turn control | Adjacent capabilities remain separate from the Prompt execution protocols while preserving atomic aggregate operations |
| `SqliteInstanceStore` / `SqliteInstanceOperationStore` | Agent instance, workspace lease, conversation target, and instance-operation persistence | Instance identity and generation fences remain inside capability operations |
| `SqliteProjectionStore` / `SqliteCardContextStore` / `SqliteOutboxStore` | Card projections/pages, invalidation state, and durable delivery lifecycle | Internal transaction-participating seams over the shared context |
| `SqliteInboundProjectStore` / `SqlitePaneOperationStore` | Durable inbound/project selection and pane operation capabilities | Workflow-specific atomic transitions, not table repositories |
| `SqliteLeaseStore` / `SqliteApprovalStore` / `SqliteCommandIntentStore` / `SqliteSessionOperationStore` / `SqliteOperationsStore` | Lease/fencing, approvals, commands, session operations, diagnostics, audit, and recovery | Low-coupling capabilities over the same context and write fence |
| `createLatestSchema` / `SqliteMigrations` | Latest-schema bootstrap and ordered compatibility migration | Separate modules run in order during capability-graph construction before capability use |

### Ubiquitous language and target module names

Use domain terms for business concepts and workflow terms for application use
cases. Do not name a module after its current technical mechanism when its
responsibility is a business or application concern.

| Current or broad term | Target term | Meaning |
| --- | --- | --- |
| `Binding` | `TopicPaneBinding` in explanatory and external-facing contexts | The controlled association between a Lark topic or root message and a Herdr pane. `Binding` remains an acceptable short internal domain term. |
| `SyncCoordinator` | `InboundRouter` | Routes normalized Lark input to capability-focused workflows; it does not own execution, reconciliation, or delivery. |
| prompt execution | `PromptRunWorkflow` | Owns FIFO turn draining, detached observation, `TurnSupervisor`, and prompt-specific shutdown behavior. |
| `SessionReconciler` | `HerdrRuntimeReconciler` | Converges the authoritative Herdr pane and agent runtime into durable binding state. |
| runtime event wiring | `RuntimeEventIntegration` | Composition owner for lifecycle fan-out, durable-work wake-ups, and the bounded Herdr hint connection; it exposes only reliability-specific interfaces. |
| workflow wake-up bus | `PromptWorkScheduler` | A coalescing, best-effort scheduler that asks the prompt-run workflow to reload and claim durable work. |
| `BridgeEventBus` | `LifecycleEventPublisher` | Distributes typed lifecycle outcomes to projections; durable inbound work uses a separate notifier and SQLite authority. |
| `CardProjector` | `ConversationViewProjector` | Reduces lifecycle outcomes into topic and run-card read models, then records delivery intent. |
| legacy channel publisher | `GatewayOutboxDispatcher` | Drains durable outbox work through the active Gateway with ordering, retries, and dead-letter handling. |
| `BindingStorePort` | capability-focused stores | Prompt acceptance, startup recovery/view convergence, prompt execution, projection, outbox, binding provisioning, runtime reconciliation, operations, and lease ports expose consumer-specific capabilities over one transactional SQLite context. |

`RunCardView`, `TopicViewState`, and Answer-page state are projections or read
models. They are not domain entities alongside `Binding` and `Prompt`, nor are
they execution concepts like `Turn` or exact-turn control. Their renderers and reducers
belong to the presentation and projection side of the application, while
durable storage for them remains an infrastructure concern.
Primary Main and Answer Worker summaries are dedicated set-based SQLite read
models. Main summary loading uses a constant number of queries and window-ranked
task state rather than repeatedly loading each full Worker Main projection;
Answer activity aggregates task count and latest-card identity in SQL, so old
task history is not materialized in JavaScript. Existing domain selectors remain
responsible for the visible eight-Worker limit and presentation ordering.

`MainCardWorkflow` is the single live, startup, and delivery-checkpoint
convergence path for the topic's Main Card. `TopicViewState.viewVersion` is the
durable desired presentation version and `deliveredVersion` is the highest
version confirmed visible by a successful Lark delivery. Only visible field
changes advance `viewVersion`; event IDs and duplicate observations do not.

### Ports and persistence

Ports belong to the core-facing boundary and describe a consumer's capability,
not a database table or SDK. For example, prompt acceptance, prompt execution,
projection, outbound delivery, binding provisioning, operations, and lease
ownership should each depend only on the operations they use. SQLite can
implement several such ports through one concrete store and one transaction.

SQLite is infrastructure, but it is the durable authority for workflow facts:
bindings, inbound acceptance, FIFO queue order, command intents, dispatch
checkpoints, detached observation, card projections, outbox intent, audit data,
and the fenced instance lease. Atomic acceptance and claim transitions must remain atomic
when ports are narrowed; splitting a large store interface must not split a
workflow transaction.

The production composition root first opens one lease bootstrap over one
`SqliteContext` and `DatabaseSync` connection. That bootstrap creates only the
idempotent `instance_lease` table. After the process acquires the durable lease,
the bootstrap runs business-schema migrations and constructs one internal
`SqliteCapabilityGraph` over the same connection. A contender that cannot acquire
the lease closes its bootstrap without inspecting or mutating business schema.
All production bundle entries are named capabilities;
none route through `SqliteStoreKernel`. Cross-table operations remain in focused
prompt, binding-session, control, recovery, instance, and outbox aggregate modules
that share the same context and preserve their outer transaction. Each workflow receives only
the domain port it consumes, such as `PromptDispatchStore`, `PromptRecoveryStore`, `PromptSessionStore`, `InstanceLifecycleStore`, `InstanceTurnStore`,
`OutboxStore`, or `MainCardStore`; it does not receive raw SQLite or the broad
facade type. A test-only `SqliteBindingStore` compatibility helper remains for
migration-fixture inspection, but production code does not expose that name. New
workflow tests use `createTestStoreBundle()` with named capabilities.

The outbound, Primary, Worker, and application composition factories declare
consumer-specific `Pick<SqliteStoreBundle, ...>` inputs. Only the parent bridge
composition receives the full bundle. New cross-context capability access in a
child factory is therefore a TypeScript error.
Startup view composition passes `StartupViewStore`, `AnswerPageStore`, and
`MainCardStore` as one named consumer dependency. `StartupViewConverger` uses
the first for recovery and traversal and constructs its two projection
workflows from the latter stores; it never casts one store into another.

Instance orchestration follows the same consumer-first rule. Messaging, turn
supervision, exact transcript observation, runtime reconciliation, and lifecycle
control each depend on a named store interface containing exactly their durable
operations. The single SQLite instance capability structurally satisfies those
interfaces, so narrowing the workflow seams adds no forwarding adapter and does
not split generation-fenced transactions.
`npm run architecture:check` additionally parses static source imports and
enforces dependency direction in CI: only the SQLite bundle may import the
capability graph, no production source may import the compatibility kernel,
SQLite implementation modules cannot depend outward on workflow or delivery
layers, and non-composition modules cannot import composition code.

All extracted SQLite capability modules share that context. Their transactional
entry points use `SqliteContext.transaction()`, where only the outermost call
issues `BEGIN IMMEDIATE`, `COMMIT`, or `ROLLBACK`; nested Prompt, Worker-turn,
projection, and outbox calls participate in the existing transaction. Capability
modules never instantiate their own database connection. The compatibility
facade remains only for legacy test fixtures and the bounded headless smoke
script. Static import checks make it unreachable from production source. It
retains legacy convenience forwarding while fixtures migrate to named
capabilities; business SQL and transaction ownership live in the capability
modules. This
keeps prompt/card/outbox and Worker
turn/card/page/event changes atomic even though their implementations live in
separate files.

Durable inbox insertion, claim, acceptance, release, and interrupted-claim
recovery belong exclusively to `InboundMessageDispatchStore`. Message routing
retains only binding/project lookup and bridge-message classification; the
kernel does not mirror the dispatcher operations as forwarding methods.

Some atomic store operations still accept a renderer callback or an already
materialized card. These are bounded transition seams for prompt and Worker-turn
acceptance, detached-prompt skip, queued-prompt cancellation, Worker card
projection, card-context convergence, turn-control recovery, and startup renderer
convergence. In each case the
canonical state transition, projection version, and durable outbox row must be
computed and committed in the same outer SQLite transaction. Moving rendering
outside those calls would require rendering a speculative view or introduce a
delivery gap. New delivery rows are nevertheless persisted with schema-versioned
typed intent plus a pinned materialized payload, so retry does not rerender
against mutable state. New renderer-bearing store APIs require an explicit atomic
transition justification and an architecture-test allowlist update.

### Swarm command bounded context

Every parsed `/swarm` command enters `SwarmCommandGateway`; the inbound router no
longer owns per-command authorization or dispatch branches. The gateway resolves
one immutable context containing the chat/project scope and, for Primary-scoped
commands, the binding generation plus both runtime identity dimensions:

```text
Lark text ───────────────┐
                        ├─> SwarmCommandGateway
CardKit Worker create ──┘      |
                               +─ query -> handler + audit
                               |           (no CommandIntent)
                               +─ mutation -> accept -> lane claim -> revalidate
                                                        -> owning aggregate
```

Mutation lanes serialize commands for the same chat, project, or Primary while
allowing unrelated Primary sessions to proceed independently. `CommandIntent`
records orchestration and references only; Binding, Prompt, Worker, pane-control,
session-administration, provisioning, and delivery aggregates keep ownership of
their own state machines.

Startup marks any interrupted `executing` intent `uncertain` and drains only
intents that never started. A handler error after invocation is also conservative
`uncertain`, because an external Herdr effect may already have occurred. Neither
case is blindly replayed. Queries use the same parser, context, policy, and
authorization path but create no command intent.
Shutdown first stops new Lark, card, and inbound acceptance, then waits for all
claimed command lanes to settle before the remaining workflows and SQLite store
are stopped.

A read-only SQLite integrity auditor runs before startup completes and every 15
minutes afterward. It caches bounded results from `quick_check`,
`foreign_key_check`, bridge-owned reference checks, and outbox lane-index
consistency checks. Findings degrade `/status` without failing `/ready`; the
auditor never repairs rows or exposes prompt, payload, or terminal content.

Herdr and Lark are external systems behind ports. Herdr observations establish
the live pane and TraeX state; Lark receives visible messages and cards. Neither
adapter defines business-state transitions, and no workflow may infer durable
truth from a Lark card.

Project workspace configuration controls only new provisioning and discovery. A
full reconciliation also observes the persisted workspaces of active and
orphaned bindings, so changing a project's target Space does not abandon its
existing panes. An orphaned binding is recovered automatically only when the
authoritative pane still has the same workspace, pane, generation, terminal,
and (when persisted) native Agent session identity. Recovery does not recreate
or replay prompt work that orphaning already made terminal.

### Events and scheduling

`RuntimeEventIntegration` owns composition-time wiring for four reliability
classes: durable inbound records plus a hint, transactional lifecycle/outbox
state plus process-local fan-out, best-effort work wake-ups, and bounded Herdr
socket hints. It deliberately has no generic `publish(any)` interface. SQLite
and fresh Herdr observation remain authoritative. The two process-local roles
below remain separate contracts and are not sources of persistent state.

| Role | Meaning | Consumer behavior | Reliability boundary |
| --- | --- | --- | --- |
| Domain lifecycle event | A description of a business outcome, such as `PromptQueued`, `TurnStarted`, `TurnCompleted`, or a binding state change. | Project deterministic run-card and topic views, then record any outbound intent. | Process-local notification; durable terminal RunCard and TopicView state is rebuilt into missing delivery intent during startup convergence. |
| Workflow wake-up | A bounded hint that a scoped binding or detached prompt may now have executable work. | Reload SQLite facts and atomically claim eligible work. | Best effort only: duplicate, reordered, or lost hints are safe because startup and periodic reconciliation scan durable work. |

A wake-up is not a domain event and does not carry prompt text or authoritative
workflow state. It is an application scheduling mechanism, provided by
`PromptWorkScheduler`, and is conceptually closer to `wakeBinding(bindingId)`
than to a business event. A domain lifecycle event, published through
`LifecycleEventPublisher`, must not be used as a worker command merely because
it was observed by a projector.

Every workflow-wake-up producer follows the durable-before-wake rule:

1. Commit the SQLite state transition.
2. Publish the scoped wake-up.
3. Return without assuming delivery of that wake-up.

For Herdr pane hints, `HerdrRuntimeReconciler` owns binding convergence and the
corresponding external-turn observation as one ordered path. The event router
must not invoke `ExternalTurnObserver` in parallel with binding reconciliation:
that would duplicate transcript reads and race against binding lifecycle
changes. Instance-turn observation and retired-pane cleanup remain separate
consumers because they own different durable aggregates.

An in-process event dispatcher is infrastructure, not storage. The SQLite
outbox is the durable delivery mechanism for Lark work. If a future requirement
needs reliable cross-process event consumption, it requires a separately
designed durable dispatcher or transactional event outbox; an in-memory bus
cannot provide that guarantee.

Prompt terminal paths update Prompt, Binding, RunCard, and TopicView state in one
SQLite transaction. Startup convergence compares durable view and delivery
versions and recreates missing Answer stream content/finalization plus main-card
updates. Intermediate lifecycle notifications remain process-local, so
`lifecycle_events` is not a complete event-sourcing log.

The target contract is that every user-visible lifecycle transition is either
projected transactionally with its durable state change or reconstructible from
persisted aggregate state. This is separate from workflow wake-ups: wake-ups may
remain best effort because workers always reload durable state.

### Target runtime shape

```text
Lark message or card action                 Herdr Socket event
             |                                |
             v                                v
   SQLite inbound record -> quick ACK      bounded wake-up hint
             |                                |
             v                                |
   single-flight durable dispatcher           |
             +-------> application workflows <+
                              |             |
                              |             +--> HerdrRuntimeReconciler
                              |                    -> authoritative snapshot
                              v
                       PromptRunWorkflow
                       FIFO turn / detached observer
                              |
                              v
                     Herdr port -> TraeX
                              |
                     durable lifecycle result
                              |
                              v
                  lifecycle event -> projection
                              |
                              v
                    SQLite outbox -> Lark port
```

The Worker task path is a parallel durable flow with a task aggregate per turn
and a session aggregate per Worker session generation:

```text
Lark inbound -> atomic InstanceTurn + WorkerTurnCard projection + invalidations
             -> FIFO scheduler -> exact structured observation
             -> SQLite result/page projection + durable context invalidations
             -> CardContextRebuilder
                  +-> Worker Main snapshot
                  +-> exact Primary Main generation
                  `-> mutable originating Primary Answer
             -> independent SQLite outbox lanes -> Lark CardKit
```

Acceptance persists the turn, its internal queued projection, and Worker-session
context invalidation before waking the scheduler. A Worker claims at most one ordinary turn at
a time. The Agent driver's dispatch receipt proves only that submission crossed
the boundary; it is never interpreted as the task result. `WorkerTurnObserver`
claims output ownership only when the instance generation, runtime turn ID, and
canonical turn start time all match. Restart recovery reopens that transcript
boundary for observation and never calls the submission boundary again.

One stable Worker Main Card is updated on the
`worker-main:<workerId>:<workerSessionGeneration>` lane. For new Worker Session
generations, its initial create is a durable group-root effect on
`worker-thread:<workerId>:<workerSessionGeneration>`; the returned root becomes
both the sole Main Card target and the fixed Worker interaction thread. It shows the current
request, lifecycle, bounded progress/output, queue state, and recent terminal
history. Completion remains visible until a newer task becomes current. SQLite
retains the full sanitized canonical result and internal turn projection; no new
per-turn card or continuation message is created. Previously delivered Task Cards
remain immutable historical artifacts, and startup dismisses only legacy create
intents that are proven never attempted.

The other card contexts are explicit durable projection boundaries. Primary Main
contains only bounded summaries for Workers owned by its exact binding and pane.
Primary Answer contains only activity whose persisted `parentPromptId` names that
Primary turn, and freezes that summary when its Answer page becomes terminal.
Worker Main is keyed by `(workerId, workerSessionGeneration)`; runtime generation,
pane replacement, and native-session renewal update that card rather than creating
a new session card. Termination freezes it, while same-name recreation creates a
new Worker identity and card. Worker output is shown only in the stable Worker
Main Card and remains bounded at render time.

`show_worker_cards` is an explicit read-only observation surface, not another
projection owner. It selects the current Worker Main state and emits one
consolidated immutable `card_reply` with a captured snapshot timestamp. The
snapshot has no Worker mutation controls and is never rebound to later context
invalidations. When the canonical Worker Main message identity is available, the
snapshot may link to that continuously updated card.

Context invalidations are committed in the same SQLite transaction as the owning
Worker transition. Startup, notifier hints, and periodic scans rebuild unfinished
revisions, so a lost wake-up cannot lose a refresh. Replaceable snapshots use
`worker-main:<workerId>:<workerSessionGeneration>`,
`primary-main:<bindingId>:<bindingGeneration>`, and
`primary-answer:<promptId>:<bindingGeneration>` lanes. The persisted `lane_key` is
the delivery and quarantine authority; retrying a card can never repeat Agent work.
The `/instances` create-form path emits the same best-effort notifier wake after
the durable Worker result is available. That wake promptly turns the committed
`worker.created` invalidation into the canonical Worker Main group-card intent;
the periodic scan remains the recovery path when the hint is lost. The callback
detail card is immediate feedback only and is not the Worker Main authority.

`worker_session_threads` is a separate routing aggregate from
`binding_thread_aliases`. It binds one Lark root to the exact Worker ID, Worker
Session generation, parent Binding generation, and parent pane. Ordinary text in
an active Worker thread creates a new turn in the existing per-Worker FIFO;
thread-local `/steer` and `/stop` reload and fence the exact active turn. The
route never depends on Worker name or `conversation_targets`. Existing Worker
Sessions are classified as `legacy-unpublished` during upgrade without any Lark
write. An explicit `/instances` action may turn that marker into one passive
entry root while leaving the already delivered canonical Main Card untouched.

The protocol is exposed through two deep modules.
`WorkerSessionThreadWorkflow` owns scope precedence, thread-local commands,
authorization, fixed-Worker submission, feedback cards, and legacy-entry callback
behavior behind `handleMessage` and `publishFromCard`.
`SqliteWorkerSessionThreadStore` owns tagged scope resolution, canonical/legacy
publication decisions, delivery settlement, Main Card placement, and retirement.
Ingress, instance interaction, card-context convergence, outbox delivery, and
instance lifecycle consume semantic outcomes and do not interpret thread table
states or repeat ownership SQL.

Direct replies use the normalized Lark `parent_id`, not the topic root or selected
Worker. A reply to the exact active card is rejected while runtime steering is
unsupported. A reply
to a settled card atomically creates a follow-up with the original turn as parent.
Queued and `dispatch-uncertain` cards reject contextual replies. Explicit `/to`
and `/steer` commands remain authoritative and do not inherit reply context.

## Request lifecycle

This section describes current externally observable behavior. Module names may
change during the target decomposition without changing these steps.

1. The Lark adapter normalizes an incoming message or card action. For messages,
   the WebSocket callback returns after the configured-chat and bridge-message
   checks plus a successful SQLite inbound insert; it does not wait for Herdr or
   command handling.
2. A coalescing single-flight dispatcher claims persisted messages in FIFO order,
   marks each accepted only after business handling completes, and releases a
   failed item back to `received`. Failures retry automatically with bounded
   exponential backoff, while a newly persisted message wakes the dispatcher
   immediately. Startup returns interrupted `processing` rows to `received`;
   shutdown cancels retry timers and waits only for the active drain, leaving any
   unclaimed rows durable for the next start.
   `/status` exposes aggregate-only inbound counts, retry backlog age, the most
   recent bounded failure, and dispatcher retry state. It never includes message
   text or the stored payload. A pending inbound head older than five minutes
   degrades operational status without changing readiness.
   Accepted inbound rows share the configured outbox retention window and are
   pruned in an independently bounded batch loop. Rows still in `received` or
   `processing` are never removed by retention.
3. A command is handled as a binding or operational workflow. Ordinary text in
   an active bound topic normally becomes a FIFO prompt job. A conservative
   classifier may route an eligible short continuation to the exact active turn;
   all other ordinary messages remain FIFO. One SQLite acceptance transaction
   rechecks the binding generation and queue limit.
   Exact, case-insensitive `/swarm stop` uses a freshly identity-checked,
   best-effort local interruption
   while the bridge has a supervised active turn; it bypasses queued ordinary
   prompts and creates no prompt job. Explicit `/swarm steer <text>` persists a
   priority turn when the Primary is idle. An active turn is rejected as
   unsupported without transport delivery or queue conversion. Both outcomes
   fence binding generation, pane, and native Agent session.
   `/swarm awake` observes detached transcript state without terminalizing an
   unrecoverable prompt. `/swarm skip` is the separate creator-authorized,
   generation-fenced action that atomically fails one oldest detached ordinary
   prompt and wakes the existing FIFO dispatcher.
   Mutating Session card actions use a separate durable handoff: the callback
   atomically consumes its scoped interaction and inserts one idempotent
   `session_operations` row, then returns an accepted Toast. A coalescing
   single-flight dispatcher validates the persisted binding generation and pane
   identity before handing work to the owning workflow. Stop/model, reset, and
   pane-close then retain their existing pane-control, provisioning-checkpoint,
   and close-confirmation authorities. Interrupted running Session operations
   become `uncertain` and are never blindly replayed.
   A natural-language root mention first persists a project selection and its
   original text. Only an explicit project callback provisions the binding; the
   original message ID is then reused as the prompt idempotency key, including
   startup recovery after selection completion.
   Main/Answer Card callbacks carry only binding and prompt identity. The focused
   card-interaction workflow reloads SQLite state, checks binding generation,
   creator or operator scope, expiry, and the captured parent turn before
   delegating to existing workflows. Current cards do not advertise supplement
   or queued-to-steering actions. Callbacks from older cards are rejected without
   terminal input, and queued prompts keep their FIFO position. Legacy durable
   prompt-steering rows are terminalized during migration and their retired schema is removed.
   Queued rows are rejected before delivery; running rows become uncertain and are never replayed.
4. A per-binding worker claims one dispatchable job. The user text is sent to
   Herdr unchanged through `herdr agent prompt`; the bridge adds no hidden prompt
   suffix and has no raw Pane-input fallback. Structured `agent_not_found`,
   `agent_not_ready`, and `agent_blocked` errors are confirmed non-delivery. A
   successful command, `agent_prompt_stalled`, or an unclassified failure after
   the command process starts is potentially delivered and is never replayed.
5. Herdr runs or observes TraeX. Structured Agent state is authoritative; process
   evidence can confirm that TraeX exists but cannot turn `unknown` into ready or done.
   During startup recovery, a `pane_created` checkpoint occupied by an older TraeX
   process without structured Agent readiness is not hot-adopted. The bridge retains
   that pane for operator inspection, creates a lifecycle-aware replacement, and
   atomically advances the binding generation only after it owns the replacement
   pane identity. No prompt is replayed as part of this replacement.
   Ordinary managed TraeX submission uses Herdr's native `agent prompt --wait`
   operation for both Primary and Worker dispatch. The bridge records dispatch
   as potentially delivered once the command starts unless Herdr returns a
   structured pre-dispatch rejection. Changed or incomplete evidence remains
   uncertain and is never replayed.
6. Workflows commit user-visible lifecycle transitions to SQLite before publishing
   process-local lifecycle events. For structured tab/worktree changes, the
   sanitized desired TopicView and Main Card delivery intent are one transaction.
   For a confirmed missing pane, the binding, affected prompt
   jobs and run cards, desired TopicView, and applicable delivery intents are one
   transaction. Queued work is cancelled and running work is failed rather than
   replayed. `RuntimeEventIntegration` composes `BridgeEventBus` and the
   post-commit outbox wake-up as distinct best-effort
   low-latency hints over durable SQLite state; the event bus is not a
   recovery record and full lifecycle-event replay is not required for these
   transitions.
7. The publisher delivers outbox work, retaining retries and dead letters. A
   delivery failure never repeats a submitted TraeX prompt.

### Turn output projection

`PromptRunWorkflow` and passive `HerdrRuntimeReconciler` observations normalize
their source into `TurnOutputObservation`. The validated active-turn JSONL path
is the only Answer source; when it is unavailable, the Answer uses a fixed safe
notice and never terminal text. One observation has
two explicit consumer payloads: `answer` supplies answer text and tool activity
to `RunCardView`, while `main` supplies the status heading, plan snapshot, model,
context, elapsed time, and reliable token usage to `TopicViewState`. The two
cards retain independent persistence, versioning, pagination, and delivery. No
renderer recovers one card's state by parsing the other card's text. Reasoning
events contribute only their bounded leading heading; reasoning prose is never
projected. A finished Answer page receives one final non-streaming green card
update and is not subsequently patched.

Interrupted running prompts are detached instead of replayed. On restart the
bridge observes the surviving pane and canonical transcript. Answer and Main Card
projection resumes only for observations whose turn ID matches the prompt's exact
persisted transcript identity. Completing the detached prompt and waking the next
FIFO item requires stronger evidence: the matching turn ID, the exact persisted
canonical start time, a canonical `task_complete`, and a surviving TraeX process.
Dispatch time admits only the first fresh `task_started` ownership claim. Herdr
`idle` or composer readiness alone cannot settle a detached turn.
Legacy detached prompts without an exact persisted turn identity remain uncertain,
are not scheduled for automatic transcript observation, cannot consume later pane
turns, and are never replayed. If completion cannot be proven, the prompt remains
explicitly uncertain. If its binding later becomes archived, closed,
failed, or orphaned, the durable work scan atomically fails both the detached
prompt and its Run Card with an explicit no-replay notice; this retains audit
history while preventing an unobservable turn from remaining operationally
running forever. Detached turns on active, attached bindings remain automatically
observable only when their exact transcript turn ID and canonical start time are
persisted.
Jobs that never started remain queued.

Runtime Primary model selection is scoped to the exact binding generation and
TraeX session. Model control uses a separate TraeX adapter rather than becoming
a fictional Herdr command.
`model/list` supplies the canonical selectable catalog; a selection remains
pending until the next ordinary FIFO prompt claims it atomically. The TraeX
adapter then prepares an owner-only operation record, SQLite
records that operation and the no-replay dispatch fence, and one `turn/start`
sends both prompt text and model. A failure before prepare returns the preference
to pending. After prepare, an explicit compare-and-swap abort can still prove
that commit never acquired the dispatch claim and safely roll back the SQLite
fence. Once commit owns that claim, restart or response loss detaches the prompt
and marks the preference uncertain unless exact turn acceptance is known. No
terminal `/model` interaction or prompt replay is used.

## Reconciliation and events

The process uses one Herdr Unix Socket client with a persistent event-stream
connection and one short-lived connection per RPC. The currently supported
Herdr 0.9 contract dedicates an event connection after `events.subscribe` and
closes an RPC connection after one response. Read-only snapshots, structured Agent lookups, and process-info
prefer Socket RPC and fall back to the matching CLI operation when unavailable.
The bridge starts TraeX through Herdr 0.9's native `agent start --kind traex`
surface and never substitutes the separate Codex executable. A live TraeX
session must have the exact tuple `herdr:traex` / `traex` / `id` / non-empty
thread ID. Legacy persisted `herdr:codex` and `herdr-traex-shim` tuples remain
unaltered audit history, but are never treated as aliases and cannot pass
reconciliation, recovery, transcript, model-control, or exact-turn fences.
Ordinary prompt submission uses the Agent CLI surface exclusively so its
uncertain-dispatch/no-replay boundary is explicit.
Active Herdr calls pass through a global transport circuit breaker inside the
snapshot cache. Three consecutive transport failures open it for 15 seconds;
after the cooldown one read-only call is admitted as a half-open probe. Commands,
including prompt submission, never act as probes and the breaker never retries
them. Domain errors do not count as transport failures.

The subscriber currently names each Pane for `pane.agent_status_changed`, so it
reconnects and refreshes that set after Pane create
or move events. It validates newline-delimited frames, reconnects with bounded
backoff, and reports the event stream connected only after Herdr acknowledges
the `events.subscribe` request. A rejected or timed-out subscription reconnects
without claiming event health. Successful subscription recovery requests full
convergence. Socket health is not a readiness gate.

Herdr Socket events carry only bounded identity metadata. The subscriber
normalizes dotted and underscore protocol spellings and assigns an explicit
Pane, workspace, or full scope. The event router uses that scope to request the
smallest applicable binding, instance, observable-turn, external-turn, and
retired-Pane reconciliation path; it never mutates SQLite from event payloads.
Each target performs a fresh authoritative read before applying existing
identity and generation fences. Periodic reconciliation remains the convergence
path when an event is unavailable.

Native Pane events also wake active and detached turn observers. The wait is
bounded and always falls back to polling, so a missing event cannot stall a turn.
`state_change_seq` prevents an older native observation from regressing projected
Agent state for the same terminal identity. Output reads remain gated by the
snapshot revision and are retried when a read fails.

`HerdrRuntimeReconciler` is the sole convergence path for event-driven and periodic
recovery:

Startup recovery is split into named stages. Local database recovery and
configured-workspace validation remain fail-fast gates. View repair, terminal
baselines, control recovery, retired-pane cleanup, runtime reconciliation, and
provisioning recovery are isolated stages whose failures are logged and exposed
through `/status`; durable work remains eligible for normal convergence. Within
view and runtime batches, one binding or pane failure does not stop later items.

1. Read one current Herdr snapshot when available, with a compatibility fallback
   for older Herdr installations.
2. Restrict the result to configured workspaces.
3. Detect missing panes, terminal identity changes, optional native Agent session
   references, unknown agent states, and eligible unbound TraeX panes. A new
   terminal identity is accepted only when the persisted native session reference
   exactly matches; a conflicting persisted reference is never overwritten.
4. Use native Agent identity and structured state exclusively for lifecycle
   convergence. An `unknown` state remains unknown; process identity cannot make
   it ready or complete.
5. Startup baselines record only structured Agent sequence, tab, and worktree
   metadata. Commit reconciler-owned visible transitions before publishing lifecycle events
   or waking eligible queues. A stale pane/generation or stale desired view
   rejects the observation without advancing its fingerprint or lifecycle state,
   so a later reconciliation can recompute from current SQLite state.

Agent-status events are scoped to affected Panes. Topology events are scoped to
affected workspaces and may additionally wake Pane-specific observers. Reconnect,
malformed, unknown, or identity-free events request full convergence. Binding
reconciliation emits `binding-runtime-changed` and `prompt-ready` hints only when
freshly observed state and durable queue eligibility require work; periodic
durable scans remain the safety net for lost hints.

Periodic reconciliation remains required. A missed native Socket event may
delay an update, but must not change the final converged state.

Workspace discovery is failure-isolated but not reported as success. A physical
Binding reconciliation pass continues converging every workspace whose snapshot
was obtained, applies the existing bounded degradation policy to unavailable
workspaces, and returns structured partial failures to its scheduler. Only
successful workspace IDs enter the event cooldown. Any failed workspace makes the
latest pass outcome failed and exposes a bounded `lastFailures` list in `/status`;
a later complete pass clears it. `/ready` continues to use its direct short-lived
workspace probes rather than stale reconciliation diagnostics.

## Answer streaming and pagination

Every new prompt owns an Answer CardKit entity and run-card entry. Explicit native
steering is a separate exact-turn control operation rather than a prompt job. Its fixed
Markdown element is updated through CardKit streaming rather than by repeatedly
replacing the whole Lark message. The original Lark message remains the request
record.

Managed TraeX startup uses Herdr 0.9's native `agent start --kind traex`
surface. Herdr publishes the canonical TraeX thread UUID through the
`herdr:traex` integration source and owns Agent lifecycle state. Normal Herdr
reconciliation persists `agent_session_source`,
`agent_session_agent`, `agent_session_kind`, and `agent_session_value` in SQLite.
This canonical Herdr tuple is the only transcript identity; the bridge has no
session-report socket or fallback identity.

`PromptRunWorkflow` opens the corresponding
transcript at EOF before dispatch, but only when exactly one filename matches
the UUID and its `session_meta` record carries the same ID. It reads complete
newline-terminated records from a byte cursor. While `agent prompt --wait` owns
submission and settlement, one attached
observer polls that cursor every 250 ms so exact-turn Answer deltas do not wait
for the Herdr command to return. A fresh `task_started` record first establishes
the durable dispatch and transcript-turn fence; inherited or unscoped output is
never published. Command settlement stops the observer before the bounded final
drain, and their shared observation signature suppresses duplicate publication.
If the Herdr waiter becomes uncertain after dispatch, the same binding worker
hands its live cursor and accumulated Answer state directly to detached
observation. This closes the EOF reopen gap without replaying the prompt. A
process restart still opens a new cursor and fences output with the durable turn
ID and start timestamp because cursor internals are deliberately process-local.
`history_mutation.payload.items`
in append mutations is the canonical typed Answer-content source. Assistant
`message` items contribute only their ordered `output_text` parts. A
`function_call` stores a compact descriptor but emits no Answer content. Its
exact paired `function_call_output` emits one consistently ordered row such as
<code>✓ Command · `npm test` · 70 files / 680 tests passed</code> or
`✓ Read · application entrypoint`. Generic completion words are omitted because `✓` already
expresses success. Successful tool stdout, file contents, serialized arguments,
patch bodies, and agent payloads never enter the Answer. Explicit failures
contribute `✗ <Type> · <Target> · <Summary>` plus only the last 20 non-empty,
redacted diagnostic lines, with the whole failure entry capped at 4,000
characters. Running asynchronous results use
`… <Type> · <Target> · 运行中`; a later terminal result may append its completion
row because Answer delivery is append-only. Calls are classified as Skill, Read, Search, Edit,
Command, Wait, Agent, or the generic Tool fallback from their declared name and
bounded structured fields; displayed targets are single-line, redacted, and at
most 160 characters. Command targets are rendered as Markdown inline code;
other activity targets remain plain text.

Absolute `SKILL.md` reads under configured TraeX or agent skill roots
are deferred until their exact result arrives. A successful load emits only
`✓ Skill · <name>` and discards the skill document output completely; a
failed load follows the same bounded diagnostic policy as other failures.
Ordinary file reads, relative or untrusted paths, and assistant prose that
mentions `SKILL.md` are not reclassified. Item IDs are deduplicated, and the
compact call descriptor is retained across reads so later results can pair by
exact `call_id`. Reasoning, developer, system, and user messages; unmatched or
malformed results; metadata; and unknown items are ignored. Top-level
`event_msg` records are not streamed Answer-content authority. The bounded
`task_started` / matching `task_complete` pair is lifecycle authority for
detached recovery; `last_agent_message` is redacted and bounded before it may
replace the recovered final Answer. A reopened cursor reconstructs only the
latest lifecycle pair from its bounded tail scan. Completion must also fall in
the detached prompt's Run Card start window, so an older completed turn cannot
advance the FIFO.
`TRAEX_SESSIONS_ROOT` selects the transcript root and defaults to
`~/.trae/cli/sessions`.

Each turn selects one Answer source mode before dispatch. An exact, validated
transcript selects typed mode; otherwise structured output is unavailable and the
turn logs one bounded reason: `missing_session_identity`,
`unsupported_session_identity`, `transcript_not_found`,
`ambiguous_transcript`, or `transcript_validation_failed`. These diagnostics do
not include prompt text, transcript content, paths, or secrets. If a transcript
read fails before any typed content is published, the turn changes to unavailable
with `transcript_read_failed`. After any typed content has been published, the
turn remains typed and finalizes from its accumulated typed chunks. When no typed
content exists, completion uses the fixed safe notice
`⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。`
A transcript failure does not fail or replay the prompt.

For a bound pane, reconciliation also keeps an independent external-turn cursor
with a lightweight two-second transcript poll between full Herdr reconciliations.
It boundedly replays only the latest active turn so a process restart or late
observer registration does not lose a direct Herdr request; completed history is
never imported. Background polling pauses while the binding worker owns the turn
boundary. Before that worker claims each queued Lark prompt, it performs one
serialized handoff scan so external transcript work is adopted before the next
bridge dispatch; external completion wakes the binding worker to resume its FIFO.

TraeX can return to `idle` without writing a matching `task_complete` or
`turn_aborted` record. That absence is not success evidence. For an exact external
turn that remains `running` and `attached`, the observer requires two distinct
durable Herdr observations later than the turn start, both `idle` or `done`, with
no intervening transcript observation. Any transcript activity or non-idle state
resets the confirmation. It then attempts one transactional fail-closed transition
fenced by Binding generation and attachment, Pane, Agent session, Prompt origin and
state, exact turn ID/start time, Run Card generation, and durable runtime state.
The Prompt and Run Card become failed with an explicitly unknown outcome, a
`TurnFailed` event updates durable projections, and the Prompt FIFO is woken. The
request is never replayed and the bridge never fabricates a successful answer.
The scan reads only durable active bindings and their transcript files; it does
not perform a Herdr snapshot or treat socket payloads as authoritative state. A
new `task_started` plus its scoped user message may adopt exactly one queued
ordinary prompt only when binding generation, pane, native session, request
body (apart from line-ending normalization), and creation time all match. An
ambiguous or absent match creates a separate durable prompt and Answer Card.
The atomic SQLite transition records `execution_origin = 'herdr'`, claims the
full transcript turn ID, and reserves any initial card delivery before events
enter the normal `BridgeEventBus` projection path; it never submits the request
to TraeX again. A newer external turn may terminalize an identity-less detached
prompt as uncertain. It may also supersede an exact-owned detached prompt, but
only when the same cursor observes a different `task_started` with a strictly
later start time and its scoped `user_message`. That handoff atomically fails
the old prompt without replay, creates a separate external prompt and Answer
Card, and retains the new exact turn fence. It never consumes a queued Lark
prompt even when the request text matches. `PromptRunWorkflow` keeps the live
cursor through this handoff so the start or request record cannot be lost
between observers. Other turn conflicts remain ignored. Periodic scans and
explicit handoffs are serialized per binding so two external cursor reads
cannot race.
The transcript projector accepts both the legacy `user_message` event and the
current `history_mutation` user message plus `item_completed/UserMessage` pair.
The current formats share a message ID and are deduplicated before adoption.
System/developer messages and user messages outside an active turn remain ignored.

Herdr pane hints explicitly observe Primary external turns after the affected
Binding reconciliation completes. Instance reconciliation, Worker turn
observation, and retired-pane cleanup remain independent consumers of the same
bounded hint. The Primary observer publishes the existing lifecycle events, so
`ConversationViewProjector` independently converges the corresponding Answer
Card and the owning Main Card through their durable outbox paths. Ordinary Bridge
dispatch still establishes an EOF baseline. An external observation may replay
only the latest active turn within its bounded scan window; it never imports
completed history. Lost or failed hints retain the periodic observer scan as the
convergence path.

After a service restart, a detached prompt that already owns an exact transcript
turn ID and start time reopens that turn instead of establishing a new EOF
baseline. Exact-turn lookup scans only the final 64 MiB of a larger transcript
and ignores the partial record at the beginning of that bounded window. The
replay keeps the durable RunCard answer as its baseline, appends transcript text
only when the replay proves a strict missing suffix, and independently publishes
the latest Main status snapshot. A Run Card ending at the legacy 64 KiB
truncation marker is the narrow exception: replay removes only that exact marker,
requires the exact owned transcript to match the remaining prefix, and then
publishes the longer bounded snapshot as one `replace-all` update. If the prefix
does not match, the old truncation fence remains intact. This restores plan steps
and phase text written before the restart without duplicating Answer content or
replaying a prompt. If the exact boundary is unavailable, observation falls back
to the live EOF tail.

Terminal content is not a control-plane source. Live pane/process/session
identity uses Herdr; detached completion uses the canonical typed transcript;
ordinary prompts use `agent prompt --wait`, and
interrupts use `agent send-keys`. Runtime text steering is unsupported and fails
fast without invoking a transport or converting active work into another prompt. Terminal text
never becomes Answer content, either live or during detached restart recovery.
Typed detached recovery retains the persisted RunCard answer and may append only
a bounded, redacted suffix whose replayed canonical text begins with that exact
answer. Unprovable historical transcript text is ignored; a later canonical
completion still supplies the final answer or the fixed safe notice when no
typed answer exists.

Typed output uses one shared 512 KiB per-turn aggregate bound in the transcript
reader and observer accumulator. Crossing that hard limit records a stable
truncation marker and suppresses later prose while lifecycle and progress
observation continue. The larger aggregate feeds the existing 9,000-character
Answer pagination protocol; it does not increase any single CardKit page. Worker
output retains its separate per-fragment sanitization before entering the shared
bounded accumulator.

Rollout does not infer or migrate session identity. Existing panes without a
native TraeX session identity complete with the fixed safe notice. A
fresh bridge-created pane, or a pane explicitly reset through the bridge,
becomes eligible for typed mode only after Herdr has published the native TraeX
UUID and reconciliation has persisted it in SQLite. The bridge never matches a transcript
from cwd, timestamps, titles, or newest-file order, and it does not automatically
restart or replace existing panes to enable typed output.

`AnswerPageWorkflow` is the single live and startup convergence path for Answer
delivery. It uses a deterministic planner to compare the canonical RunCard answer
with the authoritative active page, then asks SQLite to reserve the next content,
finish, or continuation transition. Page sequence advancement, the compatibility
RunCard mirror, and the corresponding outbox intent are committed atomically.

Each page stores its Lark message ID, CardKit ID, element ID, source start offset,
page index, and reserved sequence high-water mark. When content reaches the safe
CardKit size, the workflow finishes the active page, creates a continuation card
with a stable page idempotency key, and makes that page active after Lark identity
checkpointing. Frozen pages are never patched again. Markdown fences are closed
and reopened only in the render copy; the persisted Answer remains canonical
source text.

Every initial page and cumulative stream update passes through the same pure,
source-aware Markdown renderer. It preserves supported Markdown and language-tagged
code fences, renders consecutive TraeX numbered diff rows in a `diff` fence,
converts tables to fenced `text` blocks, removes HTML, and limits clickable links
to HTTP or HTTPS. These transformations do not change the canonical Answer or its
source offsets. Synthetic table, diff, and continuation fences count
toward the 9,000-character rendered limit, while `source_start` always remains an
offset into the unmodified canonical Answer. This keeps live delivery and restart
recovery deterministic even when normalization changes the displayed length.
When a live page has canonical continuation content, its render copy reserves
space for a short next-card notice. The notice is not persisted as answer text,
and continuation advances from the source offset returned by the same bounded
Markdown renderer.

After `stream_finish`, the existing final `card_update` may replace a finished
Answer page with a structured snapshot. Complete fenced blocks over 80 lines or
6,000 code characters become independent collapsed panels with semantic labels
for commands, execution output, diffs, configuration, or known code languages.
Short and malformed fences remain Markdown; active, frozen, and failed pages are
not upgraded through this completed-page path.

Compact Main Card and initial Answer Card previews may instead retain the start
and end of oversized content around a deterministic omission marker. This is a
render-only copy: canonical `RunCardView.answer`, SQLite state, fingerprints, and
`answer_pages.source_start` remain unchanged. It is not Answer pagination and
does not alter frozen pages, continuation creation, or CardKit stream sequences.

The `answer_pages` table records each page's message/CardKit/element identity,
source offset, sequence, and `creating`, `active`, `frozen`, or `finished` state.
It is the lifecycle authority and target validation uses its active page. The
current-page fields remain mirrored in `RunCardView` during the compatibility
migration; they are a read-model cache, not a second transition authority.

## Main Card convergence

The Main Card is independent from Answer pagination. Its latest desired content
and delivery checkpoint live in `TopicViewState`; no in-memory counter is a
delivery authority. Live lifecycle projection and startup repair both call
`MainCardWorkflow`, which serializes convergence per binding.

SQLite saves the desired TopicView and reserves its `session_status` outbox row
in one transaction. Initial creation uses `status-card:<bindingId>`; subsequent
updates use `main-card:update:<bindingId>:<viewVersion>`. A pending or
dead-lettered row for the current version is not recreated. After successful
creation or update, the same transaction marks the outbox row delivered, records
the created `statusMessageId` when applicable, and advances `deliveredVersion`
monotonically. The resulting checkpoint hint immediately asks the workflow to
check whether a newer persisted version arrived while the prior card was in
flight.

Startup compares `viewVersion` with `deliveredVersion` and recreates only missing
intent. It does not re-read terminal scrollback or replay a TraeX prompt to
reconstruct a reconciler projection, and it does not emit timestamp-keyed
unconditional updates. A lost in-process wake-up may delay delivery, but cannot
lose the desired Main Card state or cause the corresponding TraeX work to run
again.

## Conversation Gateway delivery

Production selects one built-in Gateway from a compile-time registry. The
registry does not scan directories, dynamically import packages, or execute a
module path from configuration. Startup creates one negotiated session with
separate ingress and delivery ports; its capability profile remains frozen for
the process lifetime. Existing `LARK_*` configuration continues to configure
the built-in Feishu plugin.

Core workflows render a bounded `GatewayView` document: heading, Markdown,
dividers, columns, panels, buttons, forms, inputs, and static selects. Every
document includes required fallback text. The Feishu plugin owns conversion
between this document and CardKit. A Gateway without rich views can consume the
same fallback text without importing or interpreting CardKit. Historical
provider-materialized payloads remain readable through an explicit legacy
envelope; new providers must reject that compatibility format.

Before the first claim, the dispatcher asks the active plugin to prepare a
deterministic delivery plan. SQLite stores the Gateway ID, negotiated profile,
serialized plan, and SHA-256 plan hash. Identity, plan, and hash become
immutable once claimed; retries execute the same frozen plan and never render
again. A released pending row created before this migration may receive exactly
one plan while both plan fields are null.

All user-visible replies are first represented as SQLite outbox rows with stable
idempotency keys. The dispatcher executes provider-neutral create, reply,
replace, stream, finish, and share plans. It marks successful rows
delivered; transient failures are retried with backoff; repeated failures become
dead letters that an operator can retry or dismiss.

`/swarm panes` may reserve a `group_card_create` intent for a selected active
pane. Unlike a reply intent, it carries a validated chat target and durable
thread-alias identity while leaving `root_message_id` null. Its accepted ACK
atomically records the returned group root/thread IDs and activates the alias.
The published card remains a passive interaction surface, but it mirrors each
new durable TopicView alongside the Binding's canonical Main Card. Each active
alias uses an isolated `pane-entry:<aliasId>` lane and a versioned idempotency
key, so one failed alias cannot block the canonical Main Card or another alias.
The TopicView plus canonical and alias delivery intents are reserved in one
SQLite transaction; startup can repair a missing alias version even when the
canonical target already delivered it.

An active alias resolves to its exact Binding generation and pane. Ordinary
replies use the alias root for their Answer Card while sharing the Binding's
existing Prompt FIFO and Agent session. Alias lookup fails closed after a
generation, pane, lifecycle, or attachment change. Topology-changing commands
are rejected from alias threads and must be run from the canonical topic. The
alias table and group-create intent are lease-fenced; no route exists only in
memory.

Worker Session roots use the same `group_card_create` transport with a mutually
exclusive `worker_thread_id` target. The delivery ACK transaction activates the
route and, for `canonical-main` mode only, checkpoints the sole Worker Main
message identity. A `legacy-entry` ACK activates only the route. Claimed target
identity is immutable; an uncertain external create is not issued again.

Lane keys are prefixed with the Gateway ID before entering SQLite, so equal
provider-local targets cannot collide. Before external delivery, the executor transactionally claims a fresh, due lane
head. The returned frozen receipt carries the row, snapshot revision, SHA-256
payload hash, lease fencing token, and a unique attempt ID. Delivery ACK, card
creation checkpoint, and failure settlement must match that claim. Each retry
gets a new attempt ID; late receipts cannot settle a later attempt or advance its
projection. Successful checkpoint hints are emitted only after SQLite accepts
the ACK. Retired in-flight rows retain their claim until settlement, and their
late ACK can release the claim but cannot advance the retired projection.

After the first claim, SQLite guards the payload, target identity, intent,
sequence, revision, and first-claim timestamp against mutation. An active claim
also prevents row deletion and further dispatch in its lane. Coalescing only
removes eligible successors that were never claimed, attempted, or card-ID
checkpointed; numbered Answer projection revisions are retained separately.
Changed input under an already attempted pending idempotency key is rejected as
`outbound_idempotency_conflict` rather than replacing the in-flight payload.

Static, closed, and final Answer snapshots compare serialized visible payloads.
Unchanged content does not reopen delivered, dismissed, or rejected rows, even
when the view version increases. Changed content appends a numbered successor;
A-to-B-to-A creates three revisions. Failed static replacement creates are not
automatically reopened by convergence. Frozen pages do not reserve new final
updates. Retention preserves the latest numbered projection revision as the
current deduplication checkpoint; an independent projection checkpoint table and
incremental startup candidate scan are not yet implemented.

If an external request succeeds but its local ACK or card-ID checkpoint fails,
the executor reports `outbound_checkpoint_uncertain` and does not turn that
uncertainty into an ordinary retry. An unsettled claim keeps its lane blocked.
Transport failures also carry a durable effect-certainty classification. DNS,
connection refusal, and explicit connect timeout prove the request did not start
and remain eligible for ordinary retry. HTTP/Lark responses are definite
rejections and retain their existing semantic handling. Request or headers
timeouts, connection resets, and transport failures without pre-send proof are
stored as `uncertain` unknown dead letters with a blocked quarantine; they are
never automatically reopened, though an authorized operator may explicitly
retry or dismiss them.
When a new lease owner activates its write fence, persisted claims belonging to
a different owner or fence become unknown dead letters with active, blocked
quarantines. Their payloads and existing card-ID checkpoints remain intact for
inspection and authorized recovery. Because the claim alone does not prove
whether HTTP began, even a crash immediately after claim is treated
conservatively. This is not an exactly-once guarantee: endpoint-specific
endpoint-specific reconciliation and idempotency policies remain follow-up work.
None of these recovery paths replays a TraeX prompt.

Order is important inside one CardKit element because sequences must increase.
The publisher assigns every outbox row a durable delivery order and drains only
the head of each target lane. Updates to one card and operations in one Answer
stream are serial within their target lane, including retries. Independent
`card_reply` and `text` rows each use their own durable reply lane because they
create separate Lark messages and have no cross-reply completion-order
dependency. Up to four independent lanes may make progress concurrently, so a
blocked first reply does not prevent a later independent reply from completing.
A failed or future-due head blocks only its own lane.

SQLite remains the queue authority. Every row persists its `live` or `history`
work class; normal user-visible projection work is live, while explicit Main or
Answer recovery rebuilds are history. Startup view convergence also marks every
newly reserved Main or Answer repair as history, so a restart cannot place a
large recovery batch ahead of current interactive cards. An intent already
persisted before restart keeps its original class because work class is part of
the immutable claimed revision. The dispatcher keeps only ephemeral
active-lane, wake-up, and concurrency-slot state. Its work-conserving pump fills
a slot as soon as one delivery settles or a wake-up announces new durable work;
it does not wait for a fixed batch to finish. When both classes are due, dispatch
selection follows a fixed three-live-to-one-history cycle. If one class is empty,
the other borrows every available slot. This bounds history starvation without
cancelling work already in flight. The class is part of a claimed revision's
immutable identity and is reconstructed from SQLite after restart.

The pump stops claiming new rows during shutdown and waits for already started
effects. If one external effect succeeds but its local checkpoint becomes
uncertain, the scan likewise stops claiming, waits for sibling effects to
settle, and then reports the error. This preserves the global concurrency bound
across the next scan. Every 100 claims the dispatcher yields and schedules
another scan. Lark requests use a dedicated bounded timeout; HTTP 429 responses
honor a bounded `Retry-After`, and other transient failures use jittered
exponential backoff. Existing shared reply lanes are migrated transactionally;
dead-letter audit and quarantine state remain attached to the failed reply, and
the migration never replays TraeX or Worker work.

Because every delivery uses one configured Lark application identity and current
429 responses do not expose a trustworthy narrower quota scope, a definite 429
also extends one durable app-wide cooldown. The failed reply retry deadline and
the cooldown are committed under the same claim fence. Lane selection and direct
claim both reject new work until the deadline, so force scans and restarts cannot
bypass the gate; already in-flight requests are allowed to settle. Multiple 429s
can extend but never shorten the deadline. The next-wake query combines the
earliest lane deadline with the active cooldown, and the dispatcher adds at most
250 ms of local post-boundary jitter before normal work-conserving delivery
resumes. The cooldown blocks only Lark delivery, remains visible in `/status`,
and does not change readiness or Prompt/Worker scheduling.

Permanent failures and transient failures that exhaust their single cooled
recovery round are handled by a durable lane quarantine. Answer stream failures
never allow a later content sequence or finish operation to skip the failed
head: unsafe successors are dismissed and `AnswerPageWorkflow` reconstructs
delivery from the canonical RunCard state. Main Card and other replaceable card
lanes may advance only to a newer durable snapshot. Immutable card creation,
text, and unknown work normally remain blocked until an operator retries or
dismisses the failed head. Startup may automatically dismiss an immutable
`card_reply` only when the Gateway durably rejected it and its isolated lane has
no pending work. The dead letter, recovery ledger, quarantine decision,
successor changes, and lane-head update are committed in one SQLite transaction.

### Recovery evidence versus lane release

`delivery_recoveries` keeps one durable obligation per failed outbox revision,
independent of the replaceable lane-quarantine pointer. Entering dead-letter
state records the initial failure in the same SQLite transaction. Releasing a
lane, reserving a rebuild, or retrying a failed row does not mean delivery
recovered. `unresolvedDeadLetters` excludes only obligations with recorded
recovery or dismissal, not rows whose lane was merely released. The separate
`deliveryRecoveries` counters retain unresolved/replacement-pending work even
while a manual retry is pending; these counters do not yet change readiness.

Semantic provider recovery is authorized at the exact external-call boundary.
The Feishu plugin combines its bounded operation and view purpose with the
normalized business code, then returns provider-neutral failure certainty and
recovery kind. Core delivery code does not interpret Feishu codes. Only a
Primary Main Card `updateCard`/`updateCardKit` rejection with
`230099`, a Primary Main Card `updateCardKit` rejection with `300317`, or a
Primary Answer `streamCardContent` rejection with `300309` can produce a semantic
recovery kind. SQLite consumes that explicit kind and never infers recovery from
the raw code. `230028` is a permanent content rejection of the current revision
and is not automatically retried or rewritten. Nonmatching endpoints remain
dead-lettered without rebuilding an unrelated card or Answer stream. Timeout and
reset uncertainty takes precedence and remains blocked for operator inspection.

Physical SQLite names such as `lark_error_code` and
`lark_delivery_cooldowns` are retained for additive migration and rollback
compatibility. They are storage details, not current application contracts. New
core code uses Gateway identity, provider codes, and provider-neutral failure
semantics.

An accepted delivery ACK also commits matching recovery evidence: the same
failed row after retry, an explicitly linked Main Card rebuild in its original
binding generation, or a later card update with matching target, lane, owning
identities, roles, and a newer view/revision. Versionless legacy updates use
strict delivery order within the same identity and target. The record retains
the successful reply ID, message ID, and confirmation time after outbox history
is pruned. Failed rebuilds create their own obligation without resolving the
original. Authorized dismissal is recorded separately from recovery; retries
preserve the original failure evidence.

Migration 31 backfills legacy dead letters conservatively. A released-snapshot
quarantine plus a matching delivered successor can prove recovery; missing or
ambiguous evidence remains unresolved. Unknown effects and cross-Answer-page
rebuilds are not inferred from lane release or card creation. The ledger is not
a per-attempt event log.

Startup can close one narrower class of uncertain old Answer updates when a
replacement target is already authoritative end to end. The failed update must
target an older message; the current Run Card and active static Answer page must
agree on a different message, card, and page; and a later delivered
`stream_card_create` on the same Gateway must carry matching message and card
checkpoints. Every pending row behind the quarantine must be an unclaimed
revision of the same current static-Answer projection. Recovery then records the
replacement create as proof, releases the quarantine, dismisses all but the
newest pending revision, and refreshes the lane head atomically. The uncertain
failed update remains a dead letter and is never retried. Missing identity, an
unrelated pending row, or any prior claim keeps the whole candidate blocked.

For a closed Primary Answer stream replaced by one static page, migration 32
adds explicit content-coverage evidence. Before claiming a stream update or a
new static snapshot, the reservation transaction records its canonical source
range and SHA-256 hash. Ranges use the source-aware renderer's actual page
boundary, not rendered Markdown length. Coverage cannot be updated or attached
after a claim. Reserving the replacement page also links the failed revision to
that page and its create intent in the same transaction.

A replacement create ACK alone leaves the obligation `replacement_pending`.
Only an accepted static `card_update` ACK can resolve it: the recorded candidate
must begin at the same source offset, cover the entire failed range, and match
its canonical prefix hash. The delivered update and replacement create must
identify the same page message, Prompt, and current binding generation. Appended
content is allowed; shortened or rewritten failed content is not proof. These
facts are committed with delivery settlement, so stale attempt receipts cannot
resolve recovery. This records accepted delivery, not a read receipt from a
human or a separate inspection of Lark's visible card.

Unresolved obligations retain their failed outbox rows and replacement creates
through history pruning. After resolution, normal pruning may remove those
rows; the ledger retains the successful reply/message/time and the recovery
link retains the failed source range/hash. Restart does not guess coverage for
legacy rows that lack it. This bounded path does not implement multi-page
coverage unions, multi-hop replacement chains, changed-source reconciliation,
or Worker Answer coverage. Those cases, recovery-ledger retention, candidate
rescans, and current-versus-historical health classification remain follow-up
work; missing proof stays unresolved.

## Process lifecycle and diagnostics

The supported production owner is `herdr-agent-swarm.service`, installed and
operated through `./install.sh` and `npm run swarm:*`. Herdr remains the
mandatory headless pane/process authority through its CLI and socket API; its
TUI is not a runtime dependency. The application also holds a fenced SQLite lease,
which protects against accidental duplicate processes sharing one database.
First-run setup requires a build followed by `npm run swarm:setup`. Once private
configuration is valid, `./install.sh` builds and stages the immutable release
and enables the unit without starting it; `npm run swarm:start` performs the
explicit start. Operators use `npm run swarm:status`, `npm run swarm:restart`,
`npm run swarm:stop`, and `npm run swarm:logs` for normal lifecycle work.
Pino remains the application-side structured JSON logger and writes only to
stdout/stderr. The unit appends both streams to the private local service log,
so systemd and the lifecycle CLI—not an application transport or in-memory
queue—own file durability, permissions, and rotation. Rotation occurs only
after confirmed inactivity, at 16 MiB, retaining three generations.
`swarm:logs` retains its bounded default and can include rotated generations or
filter JSON records by level, time, component, and correlation identifiers.
Staging creates an inactive candidate and does not change `current`. The install
lifecycle validates that candidate, snapshots the prior unit and enabled state,
reloads and enables the candidate-pinned unit, and atomically switches `current`
only as the final activation commit. A caught pre-commit failure restores the old
unit and enabled state. An interrupted activation or failed compensation leaves a
private `.release-activation.json` marker; later install, start, and restart
commands fail closed until the operator reconciles that evidence. Release pruning
runs only after activation and retains the current release, the previous `current`
target, and any valid release directory referenced by the previously installed
unit's `WorkingDirectory`. This protects a still-running old process when multiple
candidates are installed before the normal safety-gated restart.

Inside the process, `ManagedBridgeRuntime` starts components in explicit phases:
ownership and fencing; recovery preparation and integrity checks; the health
surface; durable delivery and projection; ingress and startup convergence; then
periodic and external observation. The lease heartbeat begins before the long
integrity audit and initial reconciliations. Each possibly started component is
recorded before an asynchronous start that may partially succeed, so a startup
failure reuses the same shutdown policy instead of a separate cleanup path.

SIGINT, SIGTERM, lease loss, and startup failure converge on one cached stop
promise. Shutdown stops new prompt/tool and socket ingress first, then periodic
and external observers, instance work, integrity and coordination, projection
and delivery, and finally the health server. Only after every tracked
write-capable component settles does it deactivate the write fence, release the
lease, and close SQLite. If a writer remains unsettled after the shared deadline
and final settlement allowance, the result is `ownership_retained`: the fence,
lease, and store deliberately remain held and the process receives a non-zero
exit code. This conservative outcome prevents a replacement process from writing
while an old task may still hold SQLite access.

### First-run setup boundary

The standalone `swarm:setup` command uses one deterministic workflow. That
workflow depends on explicit ports for terminal
prompts, configuration persistence, local/Herdr/Lark probes, and service
lifecycle operations. Terminal handling, atomic private-file replacement,
external commands, bounded HTTP calls, and systemd remain behind their adapters;
the workflow itself decides only collection, check policy, review, save, and the
separately confirmed lifecycle steps. `swarm:doctor` reuses the validation and
probe ports without prompts or mutations.

Setup validation is observational. The Herdr adapter may list and inspect
workspaces and agent capabilities, but it may not create panes or start agents.
The Lark adapter may authenticate and read the configured chat and bot identity,
but it has no message-send or tenant-management operation. Therefore successful
probes do not claim that event subscriptions, permissions, application
publication, or group membership were configured; those remain operator checks.
Failures block persistence and lifecycle changes, warnings require explicit
acceptance, and explicitly skipped network checks permit save but prohibit the
one-flow install/start path.

Configuration is committed as one logical `.env`/`projects.json` pair. The
configuration directory is private, drafts and final files are mode `0600`, and
a valid replaced pair is copied to a timestamped private backup first. A caught
partial replacement restores both old files. An ambiguous pair or transaction
marker blocks overwrite and requires operator recovery. The standalone installer
performs a narrower non-interactive guard after staging: missing configuration
or an exact shipped placeholder stops before lifecycle installation and points
the operator to `swarm:setup`; it never launches the wizard implicitly.

Health endpoints have separate meanings:

- `/health` means the process can answer requests.
- `/ready` additionally requires the lease, configured project paths, Herdr,
  Lark, and completion of the first multi-agent runtime reconciliation.
- `/status` returns a sanitized operational snapshot even when dependencies are
  degraded.

Diagnostics are observational and must not become a new availability hazard.
Each provider is collected independently; a synchronous provider failure becomes
a bounded error object, leaves sibling diagnostics visible, and degrades the
aggregate status instead of aborting the HTTP request. Readiness dependencies
fail closed: if lease, Lark, or initial instance-runtime state cannot be read,
`/ready` returns not ready. One request reads each volatile readiness provider at
most once and reuses that observation in `/status`, so a response cannot combine
contradictory lease or reconciliation snapshots.

`/status` reports active and released outbox quarantines by lane and failure
class, plus due lane heads that have made no progress for five minutes. An
active quarantine or stalled head degrades status without changing readiness,
so one broken Lark target remains visible without stopping unrelated work.
Pending Lark work is also reported as an exhaustive durable partition:
`ready`, `inFlight`, `retryWait`, `cooldownWait`, and `waitingBehindLane`. Their
sum equals `pendingOutbox`. The durable `inFlight` count comes from SQLite claim
identity and may legitimately differ momentarily from the dispatcher's
process-local `activeDeliveries`; diagnostics expose the difference but never use
one to repair the other. Normal in-flight or waiting work does not itself degrade
status. The oldest claim timestamp and age are informational and do not create a
new timeout policy.
The same endpoint reports the Herdr circuit state, bounded last failure, recovery
time, and rejection/failure counters. Open and half-open states degrade status.
It also reports each startup recovery stage with its bounded duration and error;
an isolated failed stage degrades status without making the process unavailable.
The operational summary includes queued-card counts with or without wait
estimates. It does not expose prompt
text or actor identity.

Queued ordinary turns carry durable presentation feedback. The exact queue
position counts only earlier waiting FIFO turns; the active turn is not counted
as a queued item. After at least three eligible completed ordinary turns, the
bridge estimates a coarse range from the median of the most recent ten durations,
subtracts elapsed time from the active turn, and rounds the range outward to
30-second boundaries. A separate stoppable projector refreshes changed buckets
on lifecycle events and while queued work exists. Each Run Card update and its
replaceable outbox intent are committed atomically, so restart convergence cannot
persist a newer view without retaining its delivery intent.

Shutdown uses one shared deadline and never starts a second cleanup path. It does
not replay work or delete user state. Logs and status deliberately exclude
prompt bodies, raw terminal output, card payloads, and credentials.

## Safety rules

- Lark may not approve a high-risk TraeX action. Approval remains in Herdr.
- `/swarm stop` is a freshly identity-checked, best-effort Herdr-local `Ctrl+C`
  control, not an atomic exact-turn CAS or a remote process or pane kill.
  `/swarm steer <text>` and Worker `/steer <name> <text>` create a durable
  priority turn only when the target is idle. Active-turn steering is rejected
  as unsupported. They reject blocked approval or question states and cannot approve,
  reject, or bypass a high-risk operation.
- A prompt is never automatically replayed after uncertain dispatch or restart.
- Pane attachment and replacement validate workspace, project directory, and
  terminal identity before changing a binding.
- Herdr event hints and Lark cards are not trusted business-state sources.
- Runtime SQLite files are service-owned data and are never version-controlled.

## Multi-agent ownership and recovery

SQLite owns project selection, Primary/Worker roles, immutable Worker parent
identity, desired state, instance generation, queues, approval identity, and
workspace leases. A Worker is a derived session of one exact Primary binding and
pane; its worktree may outlive the session but cannot rehydrate it. Herdr owns
whether the recorded pane and expected agent process actually exist. Git
inspection owns dirty, conflict, branch-head, and worktree removal facts. Feishu
cards are only controls and projections.

`InstanceRuntimeReconciler` is the single startup, periodic, and event-woken
convergence path. It updates only recorded instance/pane identities and never
adopts an unrecorded pane. A missing or mismatched Worker pane terminalizes that
Worker behind a generation fence: queued work is cancelled, work that may have
been dispatched remains uncertain, and the Worker cannot be restarted in a
replacement pane.

Confirming a Primary-pane close creates durable child close steps for Workers
whose immutable parent binding/pane identity exactly matches the captured parent.
The service terminalizes those child sessions before external effects, closes each
recorded child pane before the parent pane, and preserves child worktrees. A
restart probes unresolved child close steps and records success or uncertainty;
it never replays `closePane` or a Worker turn.

Approval policy has fixed `routine`, `remote-confirmation`, and `local-only`
tiers. Remote grants are persisted and bind the actor, project, instance
generation, canonical action fingerprint, resource scope, policy version,
expiry, and single-use state. Any mismatch fails closed.

## Related documents

- [Feishu group usage](feishu-group-usage.md) explains user commands and safety
  behavior.
- Historical design and iteration records live in
  [archive/](archive/), including [archive/designs](archive/designs/) and
  [archive/superpowers](archive/superpowers/).
- The [archive manifest](superpowers/archive-manifest.json) declares the
  archive policy. Run `npm run docs:audit` after a reviewed Git move to verify
  that the historical archive exists and that active material does not present
  it as current work.
