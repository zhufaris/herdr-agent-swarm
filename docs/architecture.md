# Herdr Lark Bridge Architecture

## Who this is for

This document is for an engineer taking ownership of the bridge or diagnosing a
production session. After reading it, they should be able to identify the
authority for any observed state and follow a request from Lark through Herdr
and back to a durable Lark delivery.

## System purpose

Herdr Lark Bridge connects a Lark topic to one TraeX process in a real Herdr
pane. It lets a person start work, queue later requests, and see a safe terminal
stream in Lark while preserving Herdr as the place for local observation and
high-risk approval.

The bridge is a durable workflow coordinator, not a message relay. It does not
assume that a Lark API call, a terminal read, or a plugin event is a complete
transaction by itself.

## Ownership and authority

| Concern | Authority | Why |
| --- | --- | --- |
| Pane identity, terminal identity, native Agent session reference, agent state, foreground process | Herdr snapshot and targeted runtime observation | Herdr owns panes and the TraeX process. |
| Binding lifecycle, prompt queue, delivery intent, retry state, audit, lease | SQLite | These facts must survive a bridge restart. |
| Visible cards and messages | Lark | Lark is the external delivery target, not the source of workflow truth. |
| Process lifecycle | user systemd service | The plugin controls the service; the application does not manage PID files. |
| Plugin events | bounded wake-up hints | Events improve latency but do not create a second event log. |

When these sources disagree, do not repair SQLite from a Lark card or infer a
pane state from a card. Reconcile against Herdr, then let the normal projection
and durable Lark outbox converge the visible state.

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
│ UDP event inbox · SQLite store · health server · lease runtime            │
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
read plugin paths or process-manager state directly.

### Current implementation map

The production implementation uses the following modules and seams.

| Module | Responsibility | Seam |
| --- | --- | --- |
| `InboundRouter` | Normalized inbound routing and durable acceptance | Workflow ports only; concrete construction remains in `main.ts` |
| `PromptRunWorkflow` | FIFO turn execution, steering observation, detached recovery | `PromptRunStore`, `HerdrPort`, and `PromptWorkScheduler` |
| `HerdrRuntimeReconciler` | Authoritative pane/runtime convergence | Identity-fenced `RuntimeReconciliationStore` transitions |
| `ModelSelectionWorkflow` / `PaneControlWorkflow` | Model state machine and the single stop/steer/model control queue | One queue owner with a narrow model executor seam |
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

### Ports and persistence

Ports belong to the core-facing boundary and describe a consumer's capability,
not a database table or SDK. For example, prompt acceptance, prompt execution,
projection, outbound delivery, binding provisioning, operations, and lease
ownership should each depend only on the operations they use. SQLite can
implement several such ports through one concrete store and one transaction.

SQLite is infrastructure, but it is the durable authority for workflow facts:
bindings, inbound acceptance, FIFO queue order, dispatch checkpoints, detached
observation, card projections, outbox intent, audit data, and the fenced
instance lease. Atomic acceptance and claim transitions must remain atomic
when ports are narrowed; splitting a large store interface must not split a
workflow transaction.

Herdr and Lark are external systems behind ports. Herdr observations establish
the live pane and TraeX state; Lark receives visible messages and cards. Neither
adapter defines business-state transitions, and no workflow may infer durable
truth from a Lark card.

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
Lark message or card action            Herdr Socket / plugin event
             |                                |
             v                                v
   InboundRouter and durable acceptance   bounded wake-up hint
             |                                |
             +-------> application workflows <+
                              |             |
                              |             +--> HerdrRuntimeReconciler
                              |                    -> authoritative snapshot
                              v
                       PromptRunWorkflow
                       FIFO turn / steering / observer
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

## Request lifecycle

This section describes current externally observable behavior. Module names may
change during the target decomposition without changing these steps.

1. The Lark adapter normalizes an incoming message or card action.
2. The coordinator rejects messages outside the configured chat and bridge-owned
   messages, then durably records the rest before attempting business handling.
3. A command is handled as a binding or operational workflow. Ordinary text in
   an active bound topic always becomes a FIFO prompt job; it is never
   auto-promoted to steering. Exact, case-insensitive `/swarm stop` is a local Herdr
   `Esc` control while the bridge has a supervised active turn (`working` or
   `blocked`): it bypasses queued ordinary prompts and creates no prompt job.
   Explicit `/swarm steer <text>` is the separate priority steering command; it injects
   into the same supervised active turn, bypasses queued ordinary prompts, and
   never falls back to the ordinary FIFO.
4. A per-binding worker claims one dispatchable job. The user text is sent to
   Herdr unchanged through the native Agent prompt command when available; the
   bridge adds no hidden prompt suffix. If Herdr reports `agent_prompt_stalled`,
   dispatch is treated as uncertain and is never replayed automatically.
5. Herdr runs or observes TraeX. Structured state is preferred; terminal and
   process evidence provide bounded fallbacks where Herdr reports `unknown`.
6. The coordinator publishes process-local lifecycle events. Card projection
   materializes run-card and topic views, then records Lark work in the outbox.
   The outbox is durable; full lifecycle-event replay is not yet available.
7. The publisher delivers outbox work, retaining retries and dead letters. A
   delivery failure never repeats a submitted TraeX prompt.

Interrupted running prompts are detached instead of replayed. On restart the
bridge observes the surviving pane and resumes delivery or marks the situation
explicitly uncertain. Jobs that never started remain queued.

## Reconciliation and events

The process uses one Herdr Unix Socket client with a persistent event-stream
connection and one short-lived connection per RPC because Herdr 0.7.5 dedicates
an event connection after `events.subscribe` and closes an RPC connection after
one response. Read-only snapshot, Agent
read, process-info, and bounded output-wait operations prefer Socket RPC and
fall back to the CLI when the connection or method is unavailable. TraeX startup
continues to use the configured executable through `pane run`; the bridge never
substitutes the separate Codex executable. Prompt submission remains on the
existing CLI path so its uncertain-dispatch/no-replay boundary stays unchanged.

Herdr 0.7.5 requires `pane.agent_status_changed` subscriptions to name
each Pane, so the subscriber reconnects and refreshes that set after Pane create
or move events. It validates newline-delimited frames, reconnects with bounded
backoff, and requests convergence after reconnect. Socket health is not a
readiness gate.

Herdr 0.7.5 does not allow `pane.output_changed` in a Socket subscription. The
plugin hook continues to send that event as a small loopback UDP datagram. Both
inputs carry only bounded identity metadata and request the same reconciler;
neither mutates bindings from event payloads.

Native Pane events also wake active and detached turn observers. The wait is
bounded and always falls back to polling, so a missing event cannot stall a turn.
`state_change_seq` prevents an older native observation from regressing projected
Agent state for the same terminal identity. Output reads remain gated by the
snapshot revision and are retried when a read fails.

`HerdrRuntimeReconciler` is the sole convergence path for event-driven and periodic
recovery:

1. Read one current Herdr snapshot when available, with a compatibility fallback
   for older Herdr installations.
2. Restrict the result to configured workspaces.
3. Detect missing panes, terminal identity changes, optional native Agent session
   references, unknown agent states, and eligible unbound TraeX panes. A new
   terminal identity is accepted only when the persisted native session reference
   exactly matches; a conflicting persisted reference is never overwritten.
4. Use native Agent identity and structured state first. Read bounded terminal
   output for changed revisions, final answers, interactive TraeX selectors, or
   the `unknown` fallback.
5. Update binding state, publish lifecycle events, and wake eligible queues.

Event-driven reconciliation is scoped to affected workspaces. It emits targeted
`binding-runtime-changed` and `prompt-ready` hints only when observed state and
durable queue eligibility require work; periodic durable scans remain the safety
net for lost hints.

Periodic reconciliation remains required. A missed Socket event or UDP datagram
may delay an update, but must not change the final converged state.

## Answer streaming and pagination

Every new prompt, including steering prompts, owns an Answer CardKit entity and
run-card entry. Ordinary prompts and steering prompts differ in execution and
final-content semantics, not in whether delivery state exists. Its fixed
Markdown element is updated through CardKit streaming rather than by repeatedly
replacing the whole Lark message. The original Lark message remains the request
record.

Terminal observations are normalized before persistence or delivery. ANSI and
terminal chrome, prompt echo, reasoning blocks, internal protocol markup, and
secret values are removed or redacted. Overlapping terminal windows append only
new visible material. When a terminal redraw has no reliable overlap, the active
transient terminal view is replaced with the new safe screen (`replace-all`),
which prevents an entire redrawn terminal from being appended twice. Final
TraeX answers then converge the card to the completed result.

Each run-card stores the active Answer page: its Lark message ID, CardKit ID,
element ID, source start offset, page index, and sequence. When content reaches
the safe CardKit size, the bridge finishes the active page, creates a
continuation card with a stable page idempotency key, and makes that page active.
Frozen pages are never patched again. Markdown fences are closed and reopened
only in the render copy; the persisted Answer remains canonical source text.

The `answer_pages` table records each page's message/CardKit/element identity,
source offset, sequence, and `creating`, `active`, `frozen`, or `finished` state.
Target validation uses the active page. The current-page fields remain mirrored
in `RunCardView` during the compatibility migration; they are a read-model cache,
not the only source of page identity.

## Lark delivery

All user-visible replies are first represented as SQLite outbox rows with stable
idempotency keys. The publisher delivers card replies, card updates, streaming
card creation, stream content, and stream finalization. It marks successful rows
delivered; transient failures are retried with backoff; repeated failures become
dead letters that an operator can retry or dismiss.

Order is important inside one CardKit element because sequences must increase.
The publisher assigns every outbox row a durable delivery order and drains only
the head of each target lane. Work is serial within a lane, including retries,
while up to four independent lanes may make progress concurrently. A failed or
future-due head blocks only its own lane. Lark requests use a dedicated bounded
timeout; HTTP 429 responses honor a bounded `Retry-After`, and other transient
failures use jittered exponential backoff.

## Process lifecycle and diagnostics

The supported production owner is a user systemd service installed and operated
through Herdr plugin actions. The application also holds a fenced SQLite lease,
which protects against accidental duplicate processes sharing one database.

Health endpoints have separate meanings:

- `/health` means the process can answer requests.
- `/ready` additionally requires the lease, configured project paths, Herdr,
  and Lark to be usable.
- `/status` returns a sanitized operational snapshot even when dependencies are
  degraded.

Shutdown stops ingress, waits for known work, and detaches observers if the
grace period expires. It does not replay work or delete user state. Logs and
status deliberately exclude prompt bodies, raw terminal output, card payloads,
and credentials.

## Safety rules

- Lark may not approve a high-risk TraeX action. Approval remains in Herdr.
- `/swarm stop` is a Herdr-local `Esc` control, not a remote process or pane kill.
  `/swarm steer <text>` is TraeX steering. Both work while the bridge has a supervised
  active turn (`working` or `blocked`); while `blocked`, `/swarm steer` sends text to
  TraeX steering, not to the approval interface. Neither command can approve,
  reject, or bypass a high-risk approval.
- A prompt is never automatically replayed after uncertain dispatch or restart.
- Pane attachment and replacement validate workspace, project directory, and
  terminal identity before changing a binding.
- Plugin events and Lark cards are not trusted business-state sources.
- Runtime SQLite files are service-owned data and are never version-controlled.

## Known implementation gaps

These are concrete correctness or robustness gaps in the current implementation,
distinct from the architectural evolution priorities above. They do not require a
boundary change to fix.

- **Terminal heuristics**: agent state detection relies on regex matching against
  terminal output patterns and poll-interval magic numbers. Reconciliation
  self-heals within one cycle, but TraeX UI changes can cause transient false
  idle/working detections. Prefer structured runtime evidence from Herdr where
  available.
- **Polling intervals and size limits**: several timeouts, poll intervals, and
  payload size limits (25 ms, 50 ms, 250 ms terminal polls, 2 s cache TTL, 750 ms
  card debounce, 100 ms UDP debounce, 12000/28000 character CardKit limits,
  60 s close-code TTL) are hardcoded in their respective modules. These should
  move to the validated configuration surface.
- **Shutdown deadline coordination**: grace periods are per-component rather than
  driven by a shared deadline from the composition root. A coordinated
  `AbortSignal` or deadline passed through shutdown would prevent premature
  timeout of in-flight work.
- **Herdr circuit protection**: repeated Herdr CLI failures during an outage are
  retried on every reconciliation and prompt attempt. A circuit breaker with
  half-open probe would reduce log noise and load during Herdr unavailability.

## Current evolution priorities

1. Add operational metrics (prompt latency, queue depth, dead-letter count,
   reconciliation duration, delivery latency) and lane-level backlog
   diagnostics; cross-lane concurrency with strict in-lane ordering is already
   implemented.
2. Move remaining polling intervals and size limits into validated configuration
   as operator tuning needs arise.
3. Coordinate shutdown through one shared deadline or `AbortSignal`.
4. Add circuit protection around repeated Herdr transport failures.

## Related documents

- [Feishu group usage](feishu-group-usage.md) explains user commands and safety
  behavior.
- Historical design and iteration records live in
  [archive/](archive/), including [archive/designs](archive/designs/) and
  [archive/superpowers](archive/superpowers/).
