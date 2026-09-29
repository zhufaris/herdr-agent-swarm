# Command Control Execution Design

## Goal

Deepen command/control execution without changing authorization, confirmation,
idempotency, lane ordering, external effects, recovery, or user-visible replies.

## Current problem

`SwarmCommandGateway` is the correct common ingress seam, but it also owns the
durable lane worker and the complete mutation dispatch table. Admission from text,
CardKit, Primary tools, and natural-language confirmation is therefore coupled to
claim/recovery/shutdown and external-effect uncertainty handling.

Authorization itself is sound: every direct ingress resolves through
`SwarmCommandContextResolver`, and natural-language confirmation revalidates
actor, chat, policy, and current target before atomically accepting a command intent.

## Considered approaches

### A. Gateway facade plus durable intent dispatcher (chosen)

Keep resolution, query execution, mutation admission, Card/Primary result bridging,
and rejection presentation in `SwarmCommandGateway`. Extract
`CommandIntentDispatcher` for owner-lane serialization, recovery, claim loops,
frozen-context revalidation, mutation routing, terminal settlement, and conservative
uncertain outcomes. The dispatcher receives focused callbacks for replies and
awaited Worker results without owning ingress-specific construction.

### B. One handler module per command

This creates many shallow modules and spreads the shared stale-context, effect
certainty, settlement, and audit protocol across handlers.

### C. Leave the gateway intact and only narrow types

The 233-line module would still contain two state machines, so lifecycle and
authorization changes would remain coupled to mutation execution.

## Authority and invariants

- Policy plus the context resolver is the sole authorization/routing decision.
- Every mutation has a durable `CommandIntent` before an external effect.
- One lane executes serially; unrelated lanes may progress independently.
- Frozen Primary identity is revalidated immediately before effects. Active-turn
  commands also re-resolve the exact active Prompt.
- Interrupted `executing` work becomes `uncertain` and is never replayed. Only
  durable `accepted` intents resume.
- Natural-language confirmation remains actor/chat fenced and atomic with intent
  acceptance. High-risk local TraeX approval remains outside this remote surface.

## Modules

The gateway retains `handle`, `resolve`, Card/Primary Worker creation, query
routing, reply rendering, and result waiting. `CommandIntentDispatcher` exposes
`drain(intent)`, `recover()`, and `stop()`. It hides process-local lane
workers, durable claims, mutation routing, effect certainty, and settlement.

No schema, command policy, public port, card action, natural-language confirmation,
or workflow behavior changes.

## Verification

Add a dispatcher tracer for same-lane order, then retain command integration,
natural-language confirmation, Card action, Primary tool, recovery, and architecture
coverage. Run all standard repository gates and commit design, plan, and
implementation separately.
