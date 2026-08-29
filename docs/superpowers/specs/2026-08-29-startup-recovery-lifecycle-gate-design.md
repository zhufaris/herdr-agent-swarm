# Startup Recovery Lifecycle Gate Design

## Problem

The plugin lifecycle currently declares `start` or `restart` successful after
two consecutive observations of an active systemd unit and a matching `/health`
build identity. The health server becomes available before startup recovery and
workspace validation finish. A process can therefore satisfy both probes, fail
later in startup, and enter systemd's restart loop after the lifecycle command
has already returned success.

This occurred during deployment when `/health` briefly reported the new build
before startup rejected a stale project Space name. The lifecycle action printed
success, then the unit exited.

## Decision

`waitForHealth()` will use `/status`, not `/health`, as its successful-start
authority. One successful observation requires all of these facts from the same
response while the unit is active:

1. top-level `status` is `ok`;
2. `identity.serviceId` is `herdr-lark-bridge`;
3. `identity.buildId` equals the build being started; and
4. `startupRecovery.state` is `completed`.

The lifecycle action returns success only after two consecutive successful
observations. Any inactive-unit sample, unreachable/malformed status response,
identity mismatch, or incomplete/failed startup recovery resets the consecutive
count. The final `/ready` request remains informational: external dependency
degradation is printed but does not turn a successfully initialized process into
a failed lifecycle operation.

The function and operator message will be renamed around startup completion
rather than generic health, while `/health` remains available for liveness
probes elsewhere.

## Failure Evidence

On timeout, the error must retain the expected build ID and final unit state,
and add bounded final observations for:

- observed build ID, or `unavailable`; and
- startup recovery state, or `unavailable`.

No raw status payload, configuration value, project path, or startup error is
included in this lifecycle error. Operators can use the existing status/log
actions for details.

## Compatibility and Boundaries

- No endpoint schema changes are required.
- Build identity remains mandatory and cannot be bypassed by `--force`.
- `--force` continues to bypass only the pre-restart active-work guard.
- Restart remains non-blocking at the systemd call boundary and retains its
  90-second convergence deadline.
- Start retains its 15-second default deadline.
- Readiness does not become the startup gate because transient Lark or Herdr
  dependency degradation is distinct from application initialization.
- The systemd unit and restart policy remain unchanged.

## Tests

Lifecycle tests will model `/status` and `/ready` independently and prove:

- matching `/health` alone can no longer produce success;
- `startupRecovery` values `idle`, `running`, and `failed` do not satisfy the
  gate;
- a matching completed status must be observed twice consecutively;
- a non-matching observation resets the consecutive counter;
- a matching completed status can succeed even when `/ready` reports
  `not_ready`;
- stale build and inactive-unit failures remain rejected; and
- timeout diagnostics report bounded final build and startup state.

Before deployment, run the focused lifecycle tests, TypeScript typecheck, full
Vitest suite, production build, and `git diff --check`. A live normal restart is
then used to verify the strengthened gate against the deployed service.
