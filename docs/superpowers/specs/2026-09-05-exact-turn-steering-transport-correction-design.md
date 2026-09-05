# Exact-Turn Steering Transport Correction

## Status and purpose

This design corrects the transport assumption in
`2026-09-05-native-turn-stop-and-steer-design.md`. The existing TraeX
session-peer socket is not an app-server endpoint: it accepts peer `ping` and
thread-level `deliver` messages, not JSON-RPC `initialize` or `turn/steer`.
Consequently, the current active-turn steering implementation cannot deliver a
steer to a real TraeX 0.202.3 session.

The correction preserves the original product semantics:

- active steering must target one exact runtime turn;
- idle steering remains a durable priority turn;
- an effect that may have been sent is never automatically replayed;
- local approvals and questions remain local to Herdr.

## Selected approach

Exact-turn steering is a Herdr runtime capability, not a session-peer feature.
Herdr must expose one structured `agent steer` operation that accepts the pane,
native session identity, expected runtime turn ID, steering text, and an
idempotency key. Herdr owns the final atomic comparison between the expected
turn and the live active turn before it invokes TraeX's app-server
`turn/steer` method.

The standalone swarm service continues to call only the Herdr CLI boundary. It
must not connect directly to TraeX session-peer sockets or depend on private
TraeX app-server socket discovery.

Until the installed Herdr provides this capability, the shim returns a
structured `unsupported` result immediately. It does not send any bytes to the
session-peer socket, wait for a timeout, or persist an `uncertain` result for a
request that was never attempted.

## Rejected alternatives

### Session-peer `deliver`

`deliver` routes a message to a thread, but carries no expected active-turn
identity. A turn may finish between observation and delivery, allowing the
instruction to enter a successor turn. Preflight observation cannot close this
time-of-check/time-of-use window, so this transport does not satisfy the exact
turn contract.

### A swarm-owned app-server daemon

Starting or attaching every interactive pane through a shared app-server could
expose `turn/steer`, but it changes session ownership, startup, recovery, and
deployment. It also makes the swarm service responsible for a private TraeX
transport lifecycle. That migration is outside this correction.

## Herdr capability contract

The required Herdr command is logically:

```text
herdr agent steer <pane> <text>
  --agent-session <identity>
  --turn-id <expected-runtime-turn-id>
  --idempotency-key <key>
  --timeout <milliseconds>
```

The operation must:

1. resolve the exact pane and native session;
2. reject blocked approval or question states without delivering input;
3. atomically compare `expected-runtime-turn-id` with the active TraeX turn at
   the same boundary that performs `turn/steer`;
4. deduplicate the external effect by idempotency key;
5. return a structured receipt whose status is one of `delivered`,
   `not-active`, `blocked`, `unsupported`, or `delivery-uncertain`;
6. never include steering text in command errors, logs, or receipts.

`not-active`, `blocked`, and `unsupported` prove that no steering effect was
sent. A timeout, connection loss, malformed response after dispatch, or lost
receipt is `delivery-uncertain` and must not be retried automatically.

The Herdr implementation may use TraeX app-server internally. That internal
transport must follow the generated schema for the installed TraeX version and
must not reinterpret the session-peer protocol as JSON-RPC.

## Swarm and shim behavior

`HerdrCliAdapter.steerAgent` retains its current structured command contract.
The compatibility shim may forward `agent steer` only when the configured real
Herdr reports support for the command. Otherwise it returns `unsupported`
before creating a native steering operation record.

Operation records remain an additional crash fence, not a substitute for
Herdr-side idempotency. A duplicate key with the same fingerprint returns the
stored result; reuse with different session, turn, or text is rejected. A
record that reached dispatch without a terminal receipt remains uncertain and
is never replayed.

Protocol-level error frames must be parsed explicitly. Unsupported transport,
method-not-found, blocked, and exact-turn mismatch responses must not be allowed
to degrade into generic timeout errors.

## Working-to-idle race

When native steering returns `not-active`, and only when that receipt proves no
effect was sent, `TurnControlWorkflow` performs at most one fresh owner
resolution:

- if the exact same owner generation, pane, and native session are now safely
  idle, it atomically converts the durable intent into one priority turn;
- if another exact turn is active, the owner changed, the runtime is blocked or
  unknown, or identity cannot be proven, it rejects without another effect;
- `delivery-uncertain` is terminal and is never converted into priority work.

The conversion must not create both a terminal native-control result and a
priority turn. SQLite records one durable outcome for the idempotency key.

## Priority-turn admission

Priority steer acceptance must be one SQLite transaction per owner generation.
It checks all of the following before insertion:

- no priority turn for that owner is already queued, claimed, dispatching,
  running, blocked, or dispatch-uncertain;
- no ordinary or priority runtime turn is active;
- the owner generation still matches;
- the configured queue-depth limit has not been reached;
- an existing idempotency key has the same owner and payload.

A second priority request for the same owner is rejected while the first may
still run; it is not silently appended as another priority item. Ordinary FIFO
acceptance and ordering remain unchanged.

## Stop boundary

The current `getPane` followed by `send-keys ctrl+c` implementation is not an
atomic exact-turn interrupt. Until Herdr exposes an exact-turn interrupt
operation, documentation and receipts must describe it as a best-effort local
interrupt guarded by a fresh observation, not as native exact-turn CAS.

This correction does not replace `ctrl+c` with `Esc`. User-facing documentation
must consistently describe the actual key. A future Herdr atomic interrupt can
replace this transport without changing `TurnControlWorkflow`.

## Testing

The correction requires tests at the real boundaries:

1. A session-peer contract test sends a representative unsupported JSON-RPC
   request and verifies immediate protocol rejection; no fake peer may claim
   that `turn/steer` is supported.
2. Shim tests prove unsupported steering is fail-fast and creates no uncertain
   dispatch record or terminal input.
3. Herdr adapter tests validate every structured receipt and preserve payload
   redaction.
4. Workflow tests cover the one-shot `not-active` re-resolution, including
   successful idle conversion and every fail-closed branch.
5. Store tests prove one live priority turn per owner generation, queue-depth
   enforcement, duplicate idempotency, and single-active exclusion.
6. Stop tests retain the pre-send identity checks and documentation tests use
   `ctrl+c` consistently without claiming atomic termination.

Live verification of delivered active steering is mandatory before enabling
the capability in production. It must demonstrate that the instruction appears
inside the expected transcript turn and never in a successor turn.

## Rollout

The safe rollout order is:

1. ship the swarm fail-fast correction and priority admission fixes;
2. add and release Herdr's structured exact-turn steer capability;
3. update the shim's minimum supported Herdr version and enable forwarding;
4. run a live exact-turn success, stale-turn rejection, blocked-state rejection,
   and duplicate-idempotency probe;
5. install the immutable swarm release and restart only after those gates pass.

No session is restarted merely to discover capability, and no existing
uncertain operation is replayed after upgrade.
