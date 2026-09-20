# Lifecycle Degraded Startup Design

## Goal

Prevent `swarm:start` and `swarm:restart` from reporting a failed startup when
the expected managed process is ready but `/status` is degraded only because of
historical or operational warnings such as unresolved dead letters.

## Invariants

- The active process must expose the expected service and build identity.
- Startup recovery must be `completed`.
- The configured listener PID must belong to the canonical systemd `MainPID`.
- Commands that require readiness must still verify `/ready=ready`.
- A foreign listener, stale build, incomplete recovery, inactive unit, or failed
  readiness remains a startup failure.
- Operational degradation is reported by `/status`; it does not redefine whether
  the process completed startup.

## Selected design

The lifecycle startup probe accepts `/status.status` values `ok` and `degraded`
as evidence that the status endpoint is serving. It then applies the existing
identity, build, startup-recovery, and listener-ownership fences. After two
consecutive matching observations, it probes `/ready` independently and preserves
the existing `requireReady` behavior.

Unknown or absent status values remain rejected. The timeout error keeps the last
observed status alongside build, recovery, and ownership evidence so an operator
can distinguish a non-serving endpoint from an operationally degraded one.

## Alternatives rejected

- Use `/ready` alone: this loses build identity, recovery, and listener ownership
  validation.
- Require `/status=ok`: historical dead letters can keep a ready process degraded
  indefinitely and produce the observed false failure.
- Wait for all outbox and prompt work to drain: startup completion would depend on
  unrelated durable work and could time out indefinitely.

## Testing

- A managed expected build with completed recovery, matching listener ownership,
  `/status=degraded`, and `/ready=ready` succeeds.
- Unknown status values still time out.
- Existing stale-build, foreign-listener, inactive-unit, incomplete-recovery, and
  not-ready cases continue to fail.

## Scope

This change only corrects lifecycle success classification. It does not change
the health server, readiness model, restart safety gate, outbox behavior, or
historical dead-letter state.
