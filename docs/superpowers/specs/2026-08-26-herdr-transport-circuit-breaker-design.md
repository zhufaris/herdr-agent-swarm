# Herdr Transport Circuit Breaker Design

## Goal

Bound repeated active Herdr calls during a transport outage without changing
Herdr authority, prompt dispatch semantics, or the independent event socket.

## Placement

Three seams were considered: embedding the breaker in `HerdrCliAdapter`, adding
it to `WorkspaceSnapshotCache`, or wrapping the complete `HerdrPort`. The port
decorator is selected because it covers reads and commands without coupling
policy to CLI/native fallback details. The breaker wraps the concrete adapter
and the snapshot cache wraps the breaker, so cache hits do not consume probes.

## State machine

- `closed`: calls pass through. Three consecutive transport failures open it.
- `open`: calls fail fast for 15 seconds. SQLite and Lark work remain available.
- `half_open`: after the cooldown, exactly one safe read may probe Herdr. A
  successful probe closes the circuit; failure reopens it with a fresh cooldown.
- Mutating operations never serve as half-open probes. In particular,
  `runPrompt` is never retried or replayed by the breaker. A failure after it may
  have reached TraeX retains the existing uncertain-dispatch behavior.

Only transport-shaped errors count toward opening. Domain and compatibility
errors pass through without poisoning the circuit. The native event subscriber
has its own reconnect/backoff and is deliberately outside this state machine.

## Operations

`/status` exposes bounded state, counters, cooldown time, and the last failure
message. Open or half-open status degrades the operational view. Readiness keeps
using a real workspace assertion, which becomes the safe recovery probe after
the cooldown. Threshold and cooldown are validated environment settings.
