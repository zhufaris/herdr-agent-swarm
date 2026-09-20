# Native Steering Design

**Date:** 2026-09-03
**Status:** Approved design; implementation requires a Herdr protocol change first

## Summary

Herdr Agent Swarm currently exposes `/swarm steer`, steering domain events,
durable steering rows, run-card projections, and Worker steering controls, but
the execution path rejects every request. This is intentional fail-closed
behavior introduced when prompt submission moved to `herdr agent prompt`,
because Herdr 0.7.5 does not expose a native steer operation.

Native steering must be implemented as an idempotent control operation against
an exact active runtime turn. It must not be implemented by writing arbitrary
text into a terminal. The work is split into two ordered milestones:

1. Herdr adds a native, fenced, idempotent `agent steer` protocol.
2. Herdr Agent Swarm consumes that protocol through a unified durable turn-control module.

Until milestone 1 is available, `/swarm steer` remains rejected and no terminal
input fallback is permitted.

## Goals

- Steer the exact active TraeX turn without creating another ordinary turn.
- Preserve at-most-once external delivery across duplicate Lark events, timeouts,
  bridge restarts, and Herdr reconnects.
- Support steering when the bridge observer is detached, provided Herdr can
  still prove the runtime turn identity.
- Reject steering on an approval screen or after the target turn has changed.
- Use the same control semantics for Primary bindings and Worker instances.
- Give the user an explicit `delivered`, `rejected`, or `uncertain` result.

## Non-goals

- Treating ordinary messages such as `继续` or `可以` as automatic steering.
- Remotely approving or bypassing TraeX permission prompts.
- Replaying a steer whose delivery may already have reached TraeX.
- Implementing steering with `pane send-text`, bracketed paste, or raw key input.
- Falling back from a rejected steer to the ordinary FIFO without an explicit
  user action.

## Current State and Failure Mode

The public surface and the implementation disagree:

- `PaneControlWorkflow.steer()` always rejects.
- `TraexDriver` declares `steering: "unsupported"` and returns `unsupported`.
- `PromptRunWorkflow` retains a legacy steering worker that terminalizes old rows.
- Worker commands, cards, events, store rows, and driver interfaces still model steering.
- Herdr 0.7.5 offers `agent prompt`, `agent wait`, and `agent send-keys`, but no
  `agent steer` command or exact active-turn identifier.

The current `/swarm stop` incident also demonstrates why process-local state is
not a sufficient fence. SQLite may retain a `running/detached` prompt after the
process-local `TurnSupervisor` has detached. A control command must therefore
resolve its target from durable identity plus fresh Herdr evidence, not only
from `activeTurn()`.

## Alternatives Considered

### A. Restore terminal-input steering

Reintroduce the removed `steerPrompt` implementation, inspect terminal text for
approval prompts, and paste the steering text.

Rejected. It cannot prove which runtime turn received the text, cannot provide
an at-most-once receipt after a timeout, and can type into an approval or other
interactive UI after a race.

### B. Model steering as a high-priority ordinary prompt

Insert steering ahead of the FIFO and submit it with `herdr agent prompt`.

Rejected. This creates a new turn rather than modifying the active one and
breaks the user-visible and recovery semantics of steering.

### C. Native Herdr steering plus durable Swarm control

Add an explicit Herdr operation fenced by agent session and runtime turn, then
consume it through a durable Swarm control module.

Selected. It is the only approach that preserves exact targeting, fail-closed
approval behavior, idempotency, and no-replay recovery.

## Milestone 1: Herdr Native Steering Protocol

The installed Herdr binary is wrapped by this repository's managed TraeX shim.
TraeX 0.202.2 exposes a native `turn/steer` app-server request with required
`threadId` and `expectedTurnId` fields, and each local session-peer record
contains the owning Unix socket. Therefore the first implementation belongs in
`herdr-traex-shim`: it adds the Herdr-compatible command surface while calling
TraeX's structured app-server protocol. No fork of Herdr core is required for
the initial TraeX-only rollout. A future upstream Herdr implementation may
replace the shim without changing the Swarm contract.

### CLI and socket interface

Herdr adds a command equivalent to:

```text
herdr agent steer <target> <text> \
  --turn-id <runtime-turn-id> \
  --idempotency-key <key>
```

The socket request carries more identity than the CLI shorthand exposes:

```ts
interface AgentSteerRequest {
  target: string;
  text: string;
  expectedAgentSession: {
    source: string;
    agent: string;
    kind: "id" | "path";
    value: string;
  };
  expectedTurnId: string;
  idempotencyKey: string;
}

type AgentSteerResult =
  | { status: "delivered"; operationId: string; turnId: string }
  | { status: "not-active"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "unsupported"; reason: string }
  | { status: "delivery-uncertain"; operationId: string; reason: string };
```

### Herdr invariants

Before causing an external effect, Herdr atomically verifies that:

- the target pane still contains the expected agent session;
- the expected runtime turn is the current turn;
- the agent state is steerable;
- an approval or question UI is not active;
- the idempotency key has not already been consumed.

The Herdr TraeX shim persists an operation record before delivery. A repeated idempotency key
returns the stored result. If delivery may have occurred but confirmation is
lost, Herdr returns `delivery-uncertain` and never retries automatically.

### Runtime integration requirement

The TraeX integration must expose a structured active-turn identifier and a
structured method to submit additional user input to that turn. If TraeX does
not expose such a method, Herdr must report steering as unsupported. Terminal
input is not considered native steering.

### Capability discovery

Herdr snapshot and agent metadata expose:

```ts
{
  steering: "native" | "terminal-input" | "unsupported";
  activeTurnId: string | null;
}
```

Swarm enables remote steering only when the capability is `native`.

## Milestone 2: Swarm Integration

### Herdr seam

`HerdrPort` gains one structured operation:

```ts
steerAgent(input: {
  paneId: string;
  agentSession: AgentSessionIdentity;
  runtimeTurnId: string;
  text: string;
  idempotencyKey: string;
}): Promise<SteerReceipt>;
```

The adapter invokes Herdr, parses its JSON result, applies a bounded timeout,
and redacts steering text from command errors and logs. It does not expose raw
terminal writes to coordinators.

### Unified turn-control module

Primary `PaneControlWorkflow` steering and Worker
`InstanceMessagingWorkflow.steer()` move behind one module:

```ts
interface TurnControlWorkflow {
  steer(input: SteerCommand): Promise<SteerOutcome>;
  interrupt(input: InterruptCommand): Promise<InterruptOutcome>;
}
```

The module accepts a normalized target:

```ts
interface TurnTarget {
  projectId: string;
  paneId: string;
  generation: number;
  agentSession: AgentSessionIdentity;
  logicalTurnId: string;
  runtimeTurnId: string;
}
```

It owns authorization, target resolution, generation and session fencing,
durable operation transitions, driver invocation, audit records, and recovery.
Primary and Worker callers only resolve their domain identity into a
`TurnTarget`.

### Target resolution

The resolver combines three sources of evidence:

1. SQLite supplies the binding or instance generation, logical turn, runtime
   turn ID, and recorded agent session.
2. The process-local supervisor says whether this process currently owns an
   observer, but is not authoritative for runtime activity.
3. A fresh Herdr observation confirms the current agent session, active runtime
   turn, state, and steering capability.

A detached prompt remains steerable only when SQLite and Herdr identify the same
runtime turn. SQLite `running` without matching Herdr evidence is insufficient.

### Durable operation state

Steering uses the following lifecycle:

```text
accepted -> dispatching -> delivered
                        -> rejected
                        -> uncertain
```

Recovery rules are strict:

- `accepted` has not produced an external effect and may be claimed.
- `dispatching` may have produced an effect and becomes `uncertain` after restart.
- `delivered` and `rejected` are terminal and idempotently replay their result.
- `uncertain` is never automatically retried. It may be reconciled only from a
  durable Herdr operation result or exact turn evidence.

The control operation and its dedicated operation-result outbox card are created
in one SQLite transaction. The operation stores the binding or instance generation, pane ID,
agent session identity, logical parent turn, runtime turn ID, source message,
actor, and idempotency key.

### Inbound and execution flow

`/swarm steer <text>` performs only bounded acceptance work:

1. Authenticate the actor and resolve the binding.
2. Resolve and fence the exact active target.
3. Transactionally create the accepted operation and its dedicated operation-result card.
4. Claim and dispatch the operation through the shared workflow.
5. Transactionally store the terminal result and replace or update the same
   operation-result card. If dispatch may have happened, publish `uncertain`
   without replaying.

The durable outbox, rather than a transient toast, is authoritative for visible
delivery feedback. A pending accepted card is coalesced to its terminal payload;
an already delivered accepted card receives one idempotent CardKit update.

## Product Semantics

| Runtime evidence | Result |
| --- | --- |
| Same session and same active turn, state `working` | Dispatch native steer |
| State `blocked` | Reject; approval remains local to Herdr |
| State `idle` or `done` | Reject; do not create an ordinary turn |
| Detached observer, same Herdr runtime turn | Dispatch native steer |
| Detached observer, turn identity cannot be confirmed | Reject or mark uncertain |
| Parent turn changed or completed | Reject; optionally offer explicit FIFO conversion |
| Duplicate Lark event or idempotency key | Return the original operation result |

Ordinary messages remain FIFO. Automatic continuation steering remains disabled
until explicit steering has passed production smoke tests.

## Failure Handling and Observability

Structured logs include `operationId`, `bindingId` or `instanceId`, generation,
logical turn ID, runtime turn ID, pane ID, and outcome. They never include the
steering text.

Health and status diagnostics report counts for accepted, dispatching, delivered,
rejected, and uncertain steering operations, plus the oldest nonterminal age.
An uncertain operation is visible to the user and operators; it is not silently
converted into a failure or an ordinary prompt.

## Security

- Existing chat allowlists and creator/operator authorization remain in force.
- Binding and instance generation fences prevent stale cards or commands from
  targeting replacements.
- Agent session and runtime turn fences prevent targeting a new pane occupant.
- `blocked` always rejects steering. No remote approval path is introduced.
- Logs and command errors redact steering text.
- There is no terminal-input fallback.

## Testing Strategy

### Herdr contract tests

- Successful steering of the exact working turn.
- Rejection after turn replacement or completion.
- Rejection on an approval or question UI.
- Rejection after agent session replacement.
- Same idempotency key produces one external effect.
- Delivery succeeds but response is lost, producing `delivery-uncertain`.
- Persisted operation result remains queryable after Herdr restart.

### Swarm integration tests

- `/swarm steer` binds to the exact Primary parent prompt and runtime turn.
- A detached observer can steer only with matching fresh Herdr evidence.
- Stale binding and instance generations are rejected.
- Steering does not consume or reorder ordinary FIFO work.
- Parent completion racing with steer produces one deterministic terminal result.
- Restart before dispatch safely resumes an accepted operation.
- Restart after dispatch begins produces uncertain and does not replay.
- `blocked` never calls Herdr steering.
- Answer cards show delivered, rejected, and uncertain outcomes.
- Primary and Worker entry points exercise the same turn-control interface.

### Real smoke test

1. Start a controlled long-running turn.
2. Send `/swarm steer 输出当前阶段后继续` from Lark.
3. Verify the same transcript turn incorporates the instruction.
4. Replay the same Lark event and verify one injection.
5. Repeat in blocked, detached, and just-completed race windows.
6. Restart the bridge in accepted and dispatching windows and verify recovery.

## Rollout

1. Ship Herdr protocol and capability discovery with steering disabled by default.
2. Validate Herdr idempotency and restart behavior in an isolated test session.
3. Add the Swarm adapter and unified turn-control module behind capability detection.
4. Enable explicit Worker steering in a test project.
5. Enable explicit Primary `/swarm steer` in a test project.
6. Run production smoke tests and monitor uncertain/rejected metrics.
7. Update help cards and user documentation only when native capability is live.
8. Consider automatic continuation steering in a separate design.

## Completion Criteria

- Herdr exposes native steering and exact runtime turn identity.
- Duplicate requests cannot inject text twice.
- Swarm never steers based solely on process-local observer state.
- Detached, blocked, stale-generation, and restart races have deterministic tests.
- Primary and Worker steering share one control module.
- Explicit steering is enabled only for runtimes that report native capability.
- No raw terminal steering path exists in production code.
