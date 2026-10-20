# Herdr Agent Swarm Architecture Reference

This is the maintainer map for the current Agent Input/Core JSONL design. Read [Architecture](architecture.md) for behavioral invariants and [Feishu group usage](feishu-group-usage.md) for the public command surface.

## End-to-end map

```text
Lark ingress
  -> DurableInboundPipeline
  -> InboundMessageRoutingWorkflow
       -> SwarmCommandGateway (documented controls)
       -> AgentInputWorkflow (all other eligible text)
  -> HerdrAgentInputAdapter / Core receipt
  -> ExternalTurnObserver / Core lane reader
  -> Conversation Projection
  -> OutboundIntentWriter
  -> RingDeliveryEngine (parent Primary Pane Ring or Global Ring)
  -> CardKit
```

The pipeline has no production Prompt executor or queue-feedback step. Core JSONL order is copied, not reconstructed.

## Composition

| Module | Responsibility |
| --- | --- |
| `src/main.ts` | Load config, acquire lease, compose adapters/stores/runtimes, own shutdown. |
| `src/composition/create-primary-runtime.ts` | Agent Input capability, drainer, external Core observation, Primary runtime state. It must not construct `PromptRunWorkflow`. |
| `src/composition/create-bridge-runtime.ts` | Join Primary, Worker, Binding, command, recovery, and delivery runtimes. |
| `src/composition/create-outbound-runtime.ts` | Prepared-delivery reservation, Ring Delivery Engine, checkpoint fanout, and answer-page projection. It must not construct a legacy lane dispatcher or `QueueFeedbackProjector`. |
| `src/composition/create-ingress-recovery-runtime.ts` | Durable inbound, startup recovery, command ingress, and Core projection recovery. |
| `src/composition/managed-bridge-runtime.ts` | Start/stop ordering around ingress, recovery, reconciliation, and delivery. |

Architecture-boundary tests enforce the production exclusions. Legacy workflow classes can remain loadable for evidence/migration tests without being composed.

## Inbound and routing

`DurableInboundPipeline` persists normalized ingress before business acceptance. It enforces configured chat, actor, size, duplicate, and retry boundaries.

`InboundMessageRoutingWorkflow` applies this routing order:

1. reject invalid or unauthorized ingress;
2. handle unbound/root provisioning;
3. route documented literal `/swarm ...` controls;
4. route reserved Worker-thread controls;
5. submit every remaining eligible bound-thread text unchanged as Agent Input.

Natural-language command interpretation is never applied to an ordinary bot mention in a bound Agent thread. Unknown and Agent-native slash text is Agent Input.

## Agent Input modules

| Module | Owns |
| --- | --- |
| `src/domain/submission-intent.ts` | Immutable aggregate fields and legal receipt-state transitions. |
| `src/domain/ports/agent-input.ts` | Consumer-owned Core and store contracts. |
| `src/coordinator/agent-input-workflow.ts` | Admission, duplicate convergence, capability gating. |
| `src/coordinator/agent-input-drainer.ts` | Independent per-intent CAS, Core submission, receipt queries, uncertainty policy. |
| `src/coordinator/initial-agent-input-workflow.ts` | First-session bootstrap using the same deep module. |
| `src/adapters/herdr-agent-input-adapter.ts` | Versioned Core command schema, structured responses, capability detection, safe errors. |
| SQLite agent-input store | Unique source admission, frozen route persistence, transitions, reopening. |

No module in this path may query a predecessor Prompt, claim a Binding execution slot, assign a queue position, call sessionless `runPrompt`, or reserve a visible card. Normal `AgentInputStore.admit` persists only the Submission Intent. The concrete `admitLegacyPendingCard` writer exists solely for historical compatibility and is excluded from live composition.

## Core observation and projection

`ExternalTurnObserver` opens an exact session stream and forwards canonical observations. Core lane components persist stable event identities and checkpoints while preserving received array order.

Conversation reducers own canonical Human boundaries, Conversation Segments,
Turn Cards, tool, plan, goal, and timeline read models. The exact canonical
Human event creates the first `working` Turn Card; reducers do not own input
submission or execution order. Historical Pending-first rows may be read
through explicitly legacy-named compatibility methods but no live path writes
them.

Exact-recovery modules stage paginated Core snapshots. Only a complete, compatible snapshot may atomically replace formal projection and reserve repair delivery. Incomplete, not-found, indexing, and ambiguous states remain explicitly visible as staging or projection-gap state.

## Commands and controls

`SwarmCommandGateway` owns typed query/admission responses. `CommandIntentDispatcher` owns durable mutation-lane claims, frozen Binding fences, effect uncertainty, and terminal result projection.

`TurnControlWorkflow` asks Herdr for current runtime identity. Exact active steering/stopping uses that identity. Non-active Primary steering creates independent Agent Input with source `swarm-control`; it never becomes a priority Prompt.

`SwarmCommandContextResolver` freezes Binding/session identity but not legacy `activePromptId`. The dispatcher and control workflow revalidate the actual Herdr turn at effect time.

## Binding and Pane lifecycle

`BindingProvisioningWorkflow` owns creation/discovery checkpoints and first-session Agent Input. `SessionAdministrationWorkflow` owns rename, archive, status refresh, and archived-Binding resume. Resume only activates the Binding; it does not wake Prompt work.

`SessionReconciler` is the common convergence path for socket hints and periodic scans. `PaneClosureWorkflow` and `PaneRetentionWorkflow` use fresh runtime evidence and identity fences before destructive effects.

## Worker runtime

Worker topology and ownership remain in the instance/Worker modules. Worker Session ordinary text goes through Agent Input under exact Worker, Worker-session, parent Binding, and Pane fences. Worker exact steering/stop remains a separate control path.

Worker task ordering visible in Core comes from that Worker's canonical session stream. Local task IDs and Feishu events are not a global conversation clock.

## Delivery

`OutboundIntentWriter` reserves delivery work through the common prepared-delivery
seam. The durable transition stores the complete frozen Gateway plan and returns
the immutable `PreparedDelivery` as a post-commit effect. `RingDeliveryEngine`
caches that value directly, performs an atomic fenced claim before the external
call, and persists checkpoints, acknowledgement, retry, or dead-letter state.

Delivery scope, not a fine-grained delivery lane, is the scheduling boundary:

- one Ring per Primary Pane, keyed by workspace and Pane ID;
- Worker effects use their parent Primary Pane Ring and keep Worker plus parent
  generation fences on the item;
- one Global Ring exists only for effects with no Pane owner;
- absent or stale Pane ownership never falls back to Global;
- one effect runs per Ring, while different Rings can run concurrently.

Commit notifications wake the hot path. The same engine performs scope-indexed
cold discovery on startup, retry, overflow repair, and safety scans. SQLite
remains authoritative across restart; the full-data process-local Rings avoid a
second payload read on the ordinary path but are not a second outbox.

`DeliveryCheckpointBus` isolates post-acknowledgement projection convergence.
CardKit renderers under `src/cards/` remain pure. Schema v109 removes the legacy
lane-head table, scheduler-control row, and scheduler-owner column after proving
that no pending legacy or unscoped work remains. There is no supported
delivery-ring rollback command after this contraction.

Delivery state is downstream only. A retry cannot create Agent Input or change Core projection order.

## Operations and health

`SqliteOperationsStore.getOperationalSummary()` reports Submission Intent states,
Core projection lag, projection gaps, recovery work, Delivery Ring scope state,
ingress, Bindings, Workers, lease-adjacent state, and integrity evidence.

`HealthSnapshotCollector` degrades on current capability/dependency and Core projection conditions, not on retired Prompt recovery age. `restart-safety-evaluator.ts` gates non-recoverable process-local or delivery activity; it does not use ordinary Prompt queue counters.

## Legacy evidence boundary

The following remain legacy-only and must not be introduced into new input composition:

- `PromptRunWorkflow` and its dispatch/recovery collaborators;
- Prompt Input and Native Input Batch stores;
- `claimNextDispatchablePrompt` and Binding ordinary execution slots;
- detached Prompt skip/auto-skip mechanisms;
- queue-position and wait-estimate projectors.
- `input_card_views`, `admitLegacyPendingCard`, and `admitLegacyPending` Pending-first writers.

They may be read by migration/evidence tests or retained in schema while possible-effect rows exist. Do not delete unresolved evidence and do not make it replayable.

## Where to add behavior

| Change | Owner |
| --- | --- |
| New ordinary human input rule | Agent Input workflow/domain port |
| New explicit `/swarm` command | command grammar, policy catalog, gateway/dispatcher |
| Core CLI/API schema | Herdr adapter |
| Core event interpretation | Core reader/adapter |
| Turn/card read-model change | Conversation Projection and pure renderer |
| Feishu retry/ordering | Ring Delivery Engine and prepared-delivery store |
| Pane/runtime discovery | Herdr adapter and `SessionReconciler` |
| Worker ownership/lifecycle | Worker Runtime context |
| Status/readiness/restart rule | Operations store, health collector, lifecycle evaluator |

## Verification map

- Agent Input state and migration: `tests/agent-input-*.test.ts`, `tests/legacy-agent-input-migration.test.ts`.
- Bound input routing: inbound routing/dispatcher, concurrency, steering, and Herdr discovery integration tests.
- Core order and exact recovery: lane projector and exact-recovery integration tests.
- Control fencing: turn-control, command gateway/dispatcher, and Pane control tests.
- Delivery: Ring hot-path, prepared-delivery store, CardKit stream, answer-page,
  contraction-migration, and recovery tests.
- Production exclusions: `tests/architecture-boundaries.test.ts`.
- Operations: operations integration, restart-safety, service lifecycle, health tests.

Before handoff run affected tests, `npm run typecheck`, `npm run build`, full `npm test`, configuration validation, and non-mutating candidate status/smoke checks required by the active specification.
