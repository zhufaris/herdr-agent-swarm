# Herdr Agent Swarm Architecture

## Who this is for

This document is for an engineer taking ownership of the bridge or diagnosing a
production session. After reading it, they should be able to identify the
authority for any observed state and follow a request from Lark through Herdr
and back to a durable Lark delivery.

## System purpose

Herdr Agent Swarm manages human-controlled Primary and Worker instances across
multiple projects on the Herdr headless runtime. It connects each managed Lark
topic to an agent process in a real Herdr pane, letting a person
start work, queue later requests, and see safe structured TraeX output in Lark while
preserving Herdr as the place for local observation and high-risk approval.

The bridge is a durable workflow coordinator, not a message relay. It does not
assume that a Lark API call, a Herdr snapshot, or a runtime event is a complete
transaction by itself.

### Lark authorization

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
| Herdr socket events | bounded wake-up hints | Events improve latency but do not create a second event log. |

When these sources disagree, do not repair SQLite from a Lark card or infer a
pane state from a card. Reconcile against Herdr, then let the normal projection
and durable Lark outbox converge the visible state.

An operator can explicitly recover a binding blocked by an exact-owned detached
prompt with `/swarm awake`. This path reopens the matching TraeX transcript
immediately after the detached turn's exact completion boundary, or at the next
distinct turn start when interruption left no completion record, adopts later
turns in chronological order into separate Answer Cards, and then wakes the
ordinary prompt FIFO. It never submits text to TraeX. Missing, incomplete, or
mismatched boundaries fail closed and leave the detached prompt unchanged.

## Architecture and dependency direction

The target architecture follows a ports-and-adapters structure. Dependencies
point inward: the domain defines the language and ports required by use cases;
application workflows depend on those ports; infrastructure implements them for
SQLite, Herdr, Lark, and the host runtime. A concrete adapter must not become
the source of workflow policy.

```text
┌──────────────────────────── External systems ────────────────────────────┐
│ Lark / CardKit                Herdr / TraeX                 user systemd │
└──────────────┬──────────────────────┬───────────────────────────┬────────┘
               │ SDK / HTTP           │ CLI / snapshot            │ lifecycle
               v                      v                           v
┌──────────────────────── Infrastructure and adapters ─────────────────────┐
│ Lark adapter · Herdr adapter · command runner · Socket RPC/event client   │
│ SQLite store · health server · lease runtime · shutdown                    │
└───────────────────────┬──────────────────────────────────────────────────┘
                        │ implements ports
                        v
┌────────────────────────── Application workflows ─────────────────────────┐
│ Inbound routing and prompt acceptance · prompt run · runtime reconciliation
│ binding provisioning · operations · conversation projection · outbox drain
│                                                                            │
│ Workflows coordinate use cases and request atomic port operations. They do │
│ not embed Lark SDK calls, Herdr CLI parsing, or SQLite-specific policy.    │
└───────────────────────┬──────────────────────────────────────────────────┘
                        │ depends on domain contracts
                        v
┌──────────────────────────────── Domain ──────────────────────────────────┐
│ Binding and Prompt entities; Turn and Steering execution concepts; state │
│ transitions; FIFO, uncertain-dispatch, and approval invariants;          │
│ lifecycle event types; capability-focused ports.                         │
└──────────────────────────────────────────────────────────────────────────┘
```

The composition root creates the concrete infrastructure adapters and injects
capability-focused ports into the application workflows. Runtime modules do not
read deployment paths or process-manager state directly.

### Current implementation map

The production implementation uses the following modules and seams.

| Module | Responsibility | Seam |
| --- | --- | --- |
| `InboundRouter` | Normalized inbound routing and durable acceptance | Workflow ports only; concrete construction remains in `main.ts` |
| `SwarmCommandGateway` | The single context boundary for every `/swarm` query and mutation, including CardKit Worker creation | Exhaustive policy, immutable command context, and `CommandIntentStore` |
| `PromptRunWorkflow` | FIFO turn execution, legacy steering rejection, detached recovery | `PromptRunStore`, `HerdrPort`, and `PromptWorkScheduler` |
| `InstanceMessagingWorkflow` / `InstanceWorkScheduler` | Worker turn acceptance, exact steering, FIFO dispatch, and no-replay recovery | Generation-fenced `InstanceStore` transitions and Agent driver hooks |
| `WorkerTurnObserver` | Claims and follows the exact structured transcript owned by a Worker turn | Runtime turn ID, canonical start time, and instance generation must all match |
| Worker task-card projection | Per-turn lifecycle, result pages, recent-history summaries, and navigation | Pure reducers/renderers over durable Worker turn/card state |
| `HerdrRuntimeReconciler` | Authoritative pane/runtime convergence | Identity-fenced `RuntimeReconciliationStore` transitions |
| `ModelSelectionWorkflow` / `PaneControlWorkflow` | Session-scoped model catalog/preferences plus Primary command adaptation and legacy control-row recovery | Model protocol plus shared exact-turn `TurnControlWorkflow`; no raw terminal-input seam |
| `TurnControlWorkflow` | Durable Primary/Worker steer and stop against one exact active turn | Generation, pane, native-session, logical-turn, and runtime-turn fences before Herdr effects |
| `PaneClosureWorkflow` / `SessionAdministrationWorkflow` | Destructive pane closure and non-destructive session administration | Separate lifecycle capabilities |
| `OperationsQueryWorkflow` / `DeliveryRecoveryWorkflow` | Read-only operational cards and delivery recovery decisions | Query and recovery capabilities separated from control |
| `ConversationViewProjector` | Run-card and topic-view reduction plus outbound intent creation | `ProjectionStore` and `OutboundIntentPort` |
| `LarkOutboxDispatcher` | Durable Lark delivery, retries, dead letters, and Answer-card checkpoints | `OutboxStore`; no direct aggregate mutation |
| `SqliteBindingStore` | Atomic aggregate, projection, page, outbox, and lease persistence | Capability-focused ports over one transaction owner |

### Ubiquitous language and target module names

Use domain terms for business concepts and workflow terms for application use
cases. Do not name a module after its current technical mechanism when its
responsibility is a business or application concern.

| Current or broad term | Target term | Meaning |
| --- | --- | --- |
| `Binding` | `TopicPaneBinding` in explanatory and external-facing contexts | The controlled association between a Lark topic or root message and a Herdr pane. `Binding` remains an acceptable short internal domain term. |
| `SyncCoordinator` | `InboundRouter` | Routes normalized Lark input to capability-focused workflows; it does not own execution, reconciliation, or delivery. |
| prompt execution | `PromptRunWorkflow` | Owns FIFO turn draining, steering, detached observation, `TurnSupervisor`, and prompt-specific shutdown behavior. |
| `SessionReconciler` | `HerdrRuntimeReconciler` | Converges the authoritative Herdr pane and agent runtime into durable binding state. |
| workflow wake-up bus | `PromptWorkScheduler` | A coalescing, best-effort scheduler that asks the prompt-run workflow to reload and claim durable work. |
| `BridgeEventBus` | `LifecycleEventPublisher` | Distributes lifecycle outcomes to projections. Before this rename, its inbound-message channel must be split into a separate ingress contract. |
| `CardProjector` | `ConversationViewProjector` | Reduces lifecycle outcomes into topic and run-card read models, then records delivery intent. |
| `LarkChannelPublisher` | `LarkOutboxDispatcher` | Drains durable outbox work to Lark with ordering, retries, and dead-letter handling. |
| `BindingStorePort` | capability-focused stores | `PromptAcceptanceStore`, `PromptRunStore`, `ProjectionStore`, `OutboxStore`, `BindingProvisioningStore`, `RuntimeReconciliationStore`, `OperationsStore`, and `LeaseStore` expose consumer-specific capabilities implemented by one transactional SQLite store. |

`RunCardView`, `TopicViewState`, and Answer-page state are projections or read
models. They are not domain entities alongside `Binding` and `Prompt`, nor are
they execution concepts like `Turn` and `Steering`. Their renderers and reducers
belong to the presentation and projection side of the application, while
durable storage for them remains an infrastructure concern.

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

The design uses two different event *roles*. They may share small in-process
publish/subscribe mechanics, but must remain separate contracts and must not
be treated as two sources of persistent state.

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
                       FIFO turn / legacy steering rejection / observer
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

Acceptance persists the turn, its initial queued card projection, and delivery
intent before waking the scheduler. A Worker claims at most one ordinary turn at
a time. The Agent driver's dispatch receipt proves only that submission crossed
the boundary; it is never interpreted as the task result. `WorkerTurnObserver`
claims output ownership only when the instance generation, runtime turn ID, and
canonical turn start time all match. Restart recovery reopens that transcript
boundary for observation and never calls the submission boundary again.

Each task uses a separate `worker-turn:<turnId>` outbox lane. A permanent CardKit
failure quarantines only that lane, so another task card or unrelated reply can
still advance. Output pages are ordered within the task. Once a continuation page
is created, earlier pages are frozen and are not patched. SQLite retains the full
sanitized canonical result; recent Worker history and card previews are bounded
render-only summaries.

The other card contexts are explicit durable projection boundaries. Primary Main
contains only bounded summaries for Workers owned by its exact binding and pane.
Primary Answer contains only activity whose persisted `parentPromptId` names that
Primary turn, and freezes that summary when its Answer page becomes terminal.
Worker Main is keyed by `(workerId, workerSessionGeneration)`; runtime generation,
pane replacement, and native-session renewal update that card rather than creating
a new session card. Termination freezes it, while same-name recreation creates a
new Worker identity and card. Worker output remains exclusive to Worker Task cards.

Context invalidations are committed in the same SQLite transaction as the owning
Worker transition. Startup, notifier hints, and periodic scans rebuild unfinished
revisions, so a lost wake-up cannot lose a refresh. Replaceable snapshots use
`worker-main:<workerId>:<workerSessionGeneration>`,
`primary-main:<bindingId>:<bindingGeneration>`, and
`primary-answer:<promptId>:<bindingGeneration>` lanes. The persisted `lane_key` is
the delivery and quarantine authority; retrying a card can never repeat Agent work.

Direct replies use the normalized Lark `parent_id`, not the topic root or selected
Worker. A reply to the exact active card is generation-fenced steering. A reply
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
   prompts and creates no prompt job. Explicit `/swarm steer <text>` durably
   targets the exact active Primary turn, or persists a priority turn when the
   Primary is idle. Both modes fence binding generation, pane, and native Agent
   session. Blocked and unknown states reject; ordinary FIFO order is preserved,
   and an uncertain external result is never replayed.
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
   steering rows are marked rejected during recovery and are never replayed.
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
   Ordinary managed TraeX submission is a fenced composer operation shared by
   Primary and Worker dispatch. The installed shim opens the exact-session
   transcript cursor, requires an `idle` or `done` target, sends logical
   `ctrl+u`, rechecks the session, and submits the prompt once. If the native
   command stalls and the bounded transcript window proves that no turn began,
   it sends a second fenced `ctrl+u` and returns `agent_prompt_not_started`.
   That proven non-delivery fails the durable head and releases FIFO; changed or
   incomplete evidence remains uncertain and is never replayed.
6. Workflows commit user-visible lifecycle transitions to SQLite before publishing
   process-local lifecycle events. For structured tab/worktree changes, the
   sanitized desired TopicView and Main Card delivery intent are one transaction.
   For a confirmed missing pane, the binding, affected prompt
   jobs and run cards, desired TopicView, and applicable delivery intents are one
   transaction. Queued work is cancelled and running work is failed rather than
   replayed. `BridgeEventBus` and the post-commit outbox wake-up are best-effort
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
cannot consume later pane turns, and are never replayed. If completion cannot be
proven, the prompt remains explicitly uncertain. If its binding later becomes archived, closed,
failed, or orphaned, the durable work scan atomically fails both the detached
prompt and its Run Card with an explicit no-replay notice; this retains audit
history while preventing an unobservable turn from remaining operationally
running forever. Detached turns on active, attached bindings remain observable.
Jobs that never started remain queued.

Runtime Primary model selection is scoped to the exact binding generation and
shim-reported TraeX session. `model/list` supplies the canonical selectable
catalog; a selection remains pending until the next ordinary FIFO prompt claims
it atomically. The shim then prepares an owner-only operation record, SQLite
records that operation and the no-replay dispatch fence, and one `turn/start`
sends both prompt text and model. A failure before prepare returns the preference
to pending. After prepare, an explicit shim compare-and-swap abort can still prove
that commit never acquired the dispatch claim and safely roll back the SQLite
fence. Once commit owns that claim, restart or response loss detaches the prompt
and marks the preference uncertain unless exact turn acceptance is known. No
terminal `/model` interaction or prompt replay is used.

## Reconciliation and events

The process uses one Herdr Unix Socket client with a persistent event-stream
connection and one short-lived connection per RPC because Herdr 0.7.5 dedicates
an event connection after `events.subscribe` and closes an RPC connection after
one response. Read-only snapshots, structured Agent lookups, and process-info
prefer Socket RPC and fall back to the matching CLI operation when unavailable.
The bridge starts TraeX through the formal `agent start --kind traex` surface.
On Herdr 0.7.5, the reversible command shim implements that one start operation
with a fixed launcher plus opaque request ID; no prompt or TraeX argument appears
in the Pane command. The bridge never substitutes the separate Codex executable.
Ordinary prompt submission uses the Agent CLI surface exclusively so its
uncertain-dispatch/no-replay boundary is explicit.
Active Herdr calls pass through a global transport circuit breaker inside the
snapshot cache. Three consecutive transport failures open it for 15 seconds;
after the cooldown one read-only call is admitted as a half-open probe. Commands,
including prompt submission, never act as probes and the breaker never retries
them. Domain errors do not count as transport failures.

Herdr 0.7.5 requires `pane.agent_status_changed` subscriptions to name
each Pane, so the subscriber reconnects and refreshes that set after Pane create
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

## Answer streaming and pagination

Every new prompt, including steering prompts, owns an Answer CardKit entity and
run-card entry. Ordinary prompts and steering prompts differ in execution and
final-content semantics, not in whether delivery state exists. Its fixed
Markdown element is updated through CardKit streaming rather than by repeatedly
replacing the whole Lark message. The original Lark message remains the request
record.

For shim-started TraeX processes, the shim generates a correlation UUID before
launch and passes it to TraeX's legacy `--session-id` naming option. The
process-fenced reporter resolves the canonical thread ID from TraeX's bounded
`session-peers` registry using both that name and the exact PID, then passes the
canonical ID to Herdr's official
`pane report-agent-session --source herdr:codex --agent-session-id` surface.
State and display metadata remain owned by the separate `herdr-traex-shim`
source. A new managed session uses
`/swarm reset` rather than local `/clear`.

Managed TraeX startup uses the optional local `herdr` compatibility shim. The
bridge invokes the formal `agent start --kind traex` surface without hooks or
hook-trust overrides. The shim launches
the configured real TraeX executable through a private request file and fixed
opaque launcher, and owns a separate fenced reporter.
The reporter keeps Herdr's internal known-agent protocol as Codex, establishes
the initial process-fenced `idle` authority, and publishes
`display_agent=traex`. It does not attempt to override Herdr's detected
working/idle lifecycle; detached settlement comes from the canonical transcript.
The reporter releases only its own source and metadata when the exact TraeX
process exits.
The shim projects only those marked JSON entries to `agent=traex`; native Codex
entries and legacy Codex-observed panes remain unchanged.
The adapter normalizes the session agent to `traex` only for shim-marked records.
Normal Herdr reconciliation then persists `agent_session_source`,
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
`✓ Read · src/main.ts`. Generic completion words are omitted because `✓` already
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

For a bound pane, reconciliation also keeps an independent EOF cursor as an
event-woken observer with a lightweight two-second transcript poll between full
Herdr reconciliations. Background polling pauses while the binding worker owns
the turn boundary. Before that worker claims each queued Lark prompt, it performs
one serialized handoff scan so external transcript work is adopted before the
next bridge dispatch; external completion wakes the binding worker to resume its
FIFO. The scan reads only durable active bindings and their transcript files; it
does not perform a Herdr snapshot or treat socket payloads as authoritative state. A new
`task_started` plus its scoped `user_message` may adopt exactly one queued
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

Terminal content is not a control-plane source. Live pane/process/session
identity uses Herdr; detached completion uses the canonical typed transcript;
ordinary prompts use `agent prompt --wait`, and
interrupts use `agent send-keys`. Runtime steering is enabled only when Herdr
exposes an exact-turn structured operation; otherwise it fails fast as
unsupported. Terminal text
never becomes Answer content, either live or during detached restart recovery.
Because persisted RunCard text does not carry durable source provenance,
detached recovery replaces it with the bounded, redacted transcript completion
answer, or the fixed safe notice when that completion carries no answer.

Rollout does not infer or migrate session identity. Existing panes without a
native TraeX session identity complete with the fixed safe notice. A
fresh bridge-created pane, or a pane explicitly reset through the bridge,
becomes eligible for typed mode only after its process-fenced shim reporter has
registered the assigned TraeX UUID in Herdr and reconciliation has persisted it in
SQLite. The bridge never matches a transcript
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

## Lark delivery

All user-visible replies are first represented as SQLite outbox rows with stable
idempotency keys. The publisher delivers card replies, card updates, streaming
card creation, stream content, and stream finalization. It marks successful rows
delivered; transient failures are retried with backoff; repeated failures become
dead letters that an operator can retry or dismiss.

Order is important inside one CardKit element because sequences must increase.
The publisher assigns every outbox row a durable delivery order and drains only
the head of each target lane. Updates to one card and operations in one Answer
stream are serial within their target lane, including retries. Independent
`card_reply` and `text` rows each use their own durable reply lane because they
create separate Lark messages and have no cross-reply ordering dependency. Up to
four independent lanes may make progress concurrently, so a failed reply cannot
block later replies to the same topic. A failed or future-due head blocks only
its own lane. Lark requests use a dedicated bounded timeout; HTTP 429 responses
honor a bounded `Retry-After`, and other transient failures use jittered
exponential backoff. Existing shared reply lanes are migrated transactionally;
dead-letter audit and quarantine state remain attached to the failed reply, and
the migration never replays TraeX or Worker work.

Permanent failures and transient failures that exhaust their single cooled
recovery round are handled by a durable lane quarantine. Answer stream failures
never allow a later content sequence or finish operation to skip the failed
head: unsafe successors are dismissed and `AnswerPageWorkflow` reconstructs
delivery from the canonical RunCard state. Main Card and other replaceable card
lanes may advance only to a newer durable snapshot. Immutable card creation,
text, and unknown work remain blocked until an operator retries or dismisses the
failed head. The dead letter, quarantine decision, successor changes, and lane
head update are committed in one SQLite transaction.

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

`/status` reports active and released outbox quarantines by lane and failure
class, plus due lane heads that have made no progress for five minutes. An
active quarantine or stalled head degrades status without changing readiness,
so one broken Lark target remains visible without stopping unrelated work.
The same endpoint reports the Herdr circuit state, bounded last failure, recovery
time, and rejection/failure counters. Open and half-open states degrade status.
It also reports each startup recovery stage with its bounded duration and error;
an isolated failed stage degrades status without making the process unavailable.
The operational summary includes aggregate automatic-steering outcomes and
queued-card counts with or without wait estimates. It does not expose prompt
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

Shutdown uses one shared deadline, stops ingress and both runtime reconcilers,
waits for known write-capable work, and detaches observers if the
grace period expires. It does not replay work or delete user state. Logs and
status deliberately exclude prompt bodies, raw terminal output, card payloads,
and credentials.

## Safety rules

- Lark may not approve a high-risk TraeX action. Approval remains in Herdr.
- `/swarm stop` is a freshly identity-checked, best-effort Herdr-local `Ctrl+C`
  control, not an atomic exact-turn CAS or a remote process or pane kill.
  `/swarm steer <text>` and Worker `/steer <name> <text>` use identity-fenced
  native steering against an exact active turn, or a durable priority turn when
  idle. They reject blocked approval or question states and cannot approve,
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

## Known implementation gaps

These are concrete correctness or robustness gaps in the current implementation,
distinct from the architectural evolution priorities above. They do not require a
boundary change to fix.

- **Polling intervals and size limits**: several timeouts, poll intervals, and
  payload size limits (25 ms, 50 ms, 250 ms runtime polls, 2 s cache TTL, 500 ms
  card debounce, 12000/28000 character CardKit limits,
  60 s close-code TTL) are hardcoded in their respective modules. These should
  move to the validated configuration surface.

## Current evolution priorities

1. Add operational metrics (prompt latency, queue depth, dead-letter count,
   reconciliation duration, delivery latency) and lane-level backlog
   diagnostics; cross-lane concurrency with strict in-lane ordering is already
   implemented.
2. Move remaining polling intervals and size limits into validated configuration
   as operator tuning needs arise.

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
