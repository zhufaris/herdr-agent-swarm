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
| 4 | Primary execution and observation | Prompt rows, binding generation, native session, and exact transcript identity | `PromptRunWorkflow` with dispatch, recovery, and session store interfaces | Needs deepening | Store ports are narrow, but the workflow remains a large orchestration module. Extract one execution lifecycle module only where it reduces caller knowledge without splitting atomic Prompt transitions. |
| 5 | Worker lifecycle, execution, and observation | Agent instance generation, Worker turn rows, and exact transcript identity | Instance control, turn supervisor, Worker observer, and instance scheduler interfaces | Needs audit | Consumer-shaped ports exist. Verify that card convergence, dispatch uncertainty, and instance lifecycle do not leak through shared implementation-shaped interfaces. |
| 6 | Card projection and convergence | Durable Run Card, Worker Turn Card, Main Card, page, and delivery-version state | Pure view reducers plus `AnswerPageWorkflow`, `MainCardWorkflow`, and `WorkerTurnCardWorkflow` | Complete | Primary and Worker continuation share one handoff policy; frozen-page offsets, checkpoint-gated Main Card retargeting, direct-Herdr pagination, duplicate convergence, stale targets, and startup recovery are covered through domain, workflow, SQLite, renderer, and context-rebuild tests. |
| 7 | Durable outbound delivery | SQLite outbox rows, lane heads, claims, and delivery checkpoints | `GatewayOutboxDispatcher` plus `OutboundDeliveryExecutor` and `GatewayDeliveryPort` | Needs audit | Retry/dead-letter/frozen intent behavior exists. Review the large dispatcher and recovery store for policy leakage and ensure the event wake-up migration removed all production-local scheduler ownership. |
| 8 | Herdr runtime reconciliation | Fresh Herdr snapshot plus generation/session-fenced SQLite transitions | `HerdrRuntimeReconciler` and owner-specific convergence modules | Needs deepening | Reconciliation is authoritative and tested, but the coordinator still combines scope planning, observation, binding convergence, and downstream wake decisions. |
| 9 | Command and control | Durable command intent or owning aggregate, with immutable resolved context | `SwarmCommandGateway` and focused command workflows | Needs audit | Natural-language proposal, typed command, card action, and direct command paths converge on existing workflows. Verify that authorization and confirmation cannot be bypassed across entry paths. |
| 10 | Runtime lifecycle, health, and operations | User systemd plus fenced SQLite lease; health is observation only | `ManagedBridgeRuntime`, health snapshot providers, and lifecycle ledger | Needs audit | Startup/shutdown ordering is explicit. Verify every writer is registered, diagnostic failure is content-safe, and readiness reflects all required dependencies without becoming workflow authority. |
| 11 | SQLite capability graph and migrations | One fenced `SqliteContext` and ordered schema migration | Consumer-shaped store ports backed by `SqliteCapabilityGraph` | Substantially complete | Production no longer uses the broad compatibility kernel and architecture checks enforce inward imports. Remaining work is driven by individual seam audits, not repository/table splitting. |

## Execution order

The next passes follow risk and dependency direction:

1. Deepen Primary execution/observation, then Worker execution/observation.
2. Audit durable delivery and Herdr reconciliation after their producers expose
   stable interfaces.
3. Finish with command/control and runtime lifecycle/health.

Each pass gets its own design record, implementation plan, focused verification,
and completion audit. A pass must not opportunistically refactor the next seam.

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
