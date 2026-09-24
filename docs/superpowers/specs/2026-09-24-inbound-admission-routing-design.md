# Inbound Admission and Routing Design

## Goal

Deepen the message-ingress seam without changing externally observable routing,
authorization, queue ordering, or recovery behavior. The Gateway should submit
one normalized message to a durable pipeline; callers should not need to know
how inbox claims, scope isolation, retries, routing, or Prompt acceptance work.

This pass covers normalized Gateway messages only. Card actions retain their
separate durable dispatcher and authorization path. It does not change command
syntax, natural-language interpretation, project selection, or user-facing
feedback.

## Authority and invariants

- The normalized Gateway event is untrusted input until admission validates the
  configured chat, actor allowlist, bridge-message exclusion, and input bounds.
- SQLite is the authority for admitted inbound work, deduplication, FIFO scope,
  claim state, retry state, and restart recovery.
- Inbound work is FIFO within `inboundMessageScopeKey(message)`. A retryable
  failure blocks only that scope during the current drain pass.
- A message becomes accepted only after its route has completed or after a
  durable user-visible permanent rejection has been reserved.
- Any route that can be retried after an uncertain process exit must preserve
  its existing durable idempotency key. No retry may duplicate a TraeX Prompt,
  Worker turn, command operation, project selection, or feedback card.
- Process-local events are wake-up hints. They never carry message text or act
  as durable message authority.

## Chosen modules and interfaces

### `DurableInboundPipeline`

This is the single message-ingress module exposed to Gateway and lifecycle
composition. Its interface is intentionally small:

```ts
interface DurableInboundPipelinePort {
  start(): void;
  receive(message: IncomingLarkMessage): Promise<void>;
  recover(): number;
  stop(): Promise<void>;
  snapshot(): InboundDispatcherDiagnostics;
}
```

The implementation owns admission checks, prompt-input compaction, durable
deduplication, coalesced draining, scope-aware claim/release, retry backoff,
permanent rejection acknowledgement, shutdown settlement, and diagnostics. It
depends on a consumer-shaped inbox store and one `InboundMessageRouter`
interface. Explicit synchronous drain methods are implementation/test details,
not production interface. Startup calls `recover()` before `start()`; `start()`
drains existing durable work after the route dependencies are ready.

### `InboundMessageRouter`

The router exposes one operation:

```ts
interface InboundMessageRouterPort {
  route(message: IncomingLarkMessage): Promise<InboundRoutingResult>;
}

interface InboundRoutingResult {
  decision: string;
  disposition: "prompt_queued" | "command_completed" | "user_feedback" | "rejected";
  bindingId?: string;
  workspaceId?: string;
  paneId?: string | null;
  promptId?: string;
}
```

The router owns precedence and route execution, then returns the structured
completion fact used for one content-safe log. Expected unavailable-target and
capacity outcomes become `rejected` results only after their durable rejection
card has been reserved. Infrastructure, transaction, or reservation failures
still throw and remain retryable.

The production precedence remains byte-for-byte behavior compatible:

1. oversized-input rejection;
2. fixed Worker Session Thread route;
3. explicit instance command, including alias restrictions;
4. explicit Swarm command, including alias restrictions;
5. bot-mentioned natural-language control or task classification;
6. active Primary Prompt;
7. ordinary Worker-targeted message;
8. bot-mentioned admin root auto-provisioning;
9. unauthorized-root or archived/unbound feedback.

Route classification may use private policy functions or a discriminated union,
but the implementation must not introduce a public chain-of-handlers framework.
There is one production routing order, so separate public handler ports would be
hypothetical seams.

### `PromptAdmissionWorkflow`

Prompt acceptance moves behind one module used by ordinary Primary routing and
project-selection recovery:

```ts
interface PromptAdmissionWorkflowPort {
  accept(binding: Binding, request: PromptAdmissionRequest): Promise<{ promptId: string } | null>;
  acceptInitial(binding: Binding, selection: ProjectSelection): Promise<{ promptId: string } | null>;
}
```

It owns Answer root selection, parent-turn capture, queue position, Run Card
creation, the atomic `acceptPromptWithEffects` transition, post-commit lifecycle
effects, scheduler wake-up, outbound wake-up, and audit. The implementation
retains the message ID based idempotency already enforced by SQLite. The router
no longer exposes `enqueueInitialProjectPrompt`; startup recovery and card-action
project selection use `PromptAdmissionWorkflowPort` directly.

## EventBus contract

The inbound RuntimeEventBus channel becomes a wake-up channel carrying only a
durable identifier:

```ts
interface InboundWorkHint { eventId: string }
```

The durable pipeline persists the complete bounded message before publishing
the hint. A subscriber reacts by requesting a drain; it does not route the
event payload. A lost or coalesced hint is safe because startup scan, immediate
post-admission drain, and retry timers reload work from SQLite. Runtime event
envelopes contain no message, Prompt, terminal, steering, or answer text.

The existing `InboundWorkNotifier` compatibility implementation is removed from
production composition once all callers use the narrow hint interface. No new
database table or durable event log is introduced.

## Data flow

```text
Gateway adapter
  -> normalize IncomingLarkMessage
  -> DurableInboundPipeline.receive
  -> validate and compact
  -> SQLite recordInboundMessage (dedupe by event/message identity)
  -> publish content-free inbound-ready hint
  -> coalesced durable drain
  -> SQLite claim oldest eligible scope head
  -> InboundMessageRouter.route
  -> route-specific durable transition/outbox intent
  -> SQLite mark accepted
```

On retryable failure the pipeline releases the row to `received`, records a
bounded safe error, excludes that scope for the remainder of the pass, and
schedules bounded exponential retry. On restart, `processing` rows return to
`received`; downstream idempotency determines whether a repeated route resumes
or observes its prior durable result.

## Composition and lifecycle

`createIngressRecoveryRuntime` constructs Prompt admission, the router, and the
pipeline. Gateway ingress receives only the pipeline's `receive` capability.
Startup recovery receives the pipeline lifecycle interface and Prompt admission
for initial project prompts. `InboundRouter` coordinates top-level startup and
shutdown but cannot claim or release inbox rows.

Shutdown stops new Gateway ingress, prevents new pipeline drains, and awaits the
currently executing route before returning. Unfinished claimed rows remain
recoverable through the existing `processing -> received` startup transition.

## Observability and security

- Exactly one completion record is emitted per successful route attempt with
  `eventId`, `messageId`, decision, disposition, and available durable IDs.
- Logs never include message text, Prompt body, terminal output, or card body.
- Retry diagnostics retain bounded, redacted errors and the existing dispatcher
  snapshot fields.
- Unauthorized, foreign-chat, and bridge-originated messages never enter the
  durable inbox.
- Oversized content is replaced by the existing compact marker before storage.

## Verification

Tests at the three public interfaces must prove:

1. admission authorization, foreign-chat rejection, bridge-message exclusion,
   oversized compaction, and event/message deduplication;
2. same-scope FIFO, cross-scope failure isolation, automatic retry, permanent
   rejection acknowledgement, recovery, and shutdown settlement;
3. the complete routing precedence table, alias restrictions, natural-language
   behavior, Worker target failures, and archived/unbound feedback;
4. ordinary and initial-project Prompt admission idempotency, queue capacity,
   exact durable Prompt identity, and post-commit effects;
5. RuntimeEventBus inbound envelopes contain only durable identifiers and a lost
   hint converges through SQLite scanning;
6. architecture checks prevent Gateway, composition, router, and startup code
   from directly owning inbox claim/release mechanics or message-body events.

Run focused inbound, routing, SQLite, startup, runtime-event, and architecture
tests, followed by typecheck, build, architecture and documentation audits,
`git diff --check`, and the full Vitest suite.

## Explicit non-goals

- No SQLite schema change or new in-memory queue authority.
- No command syntax, route precedence, authorization, feedback text, or
  natural-language behavior change.
- No Card Action Router refactor.
- No generic middleware or public route-handler registry.
- No change to high-risk approval policy or Herdr local-control boundaries.
