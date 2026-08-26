# Non-blocking Service Restart Design

## Goal

Make the Herdr plugin restart action tolerate the bridge's existing 50-second
graceful shutdown window without mistaking an in-progress systemd restart for a
failed deployment.

## Scope

- Keep the systemd unit's `TimeoutStopSec=50` unchanged.
- Change only the plugin lifecycle restart invocation and its readiness wait.
- Do not alter prompt detachment, outbox delivery, or the bridge shutdown
  protocol.

## Design

For `restart`, the plugin lifecycle invokes:

```text
systemctl --user restart --no-block herdr-lark-bridge.service
```

Systemd owns the stop/start transition asynchronously. The lifecycle command
then polls for at most 90 seconds. A restart succeeds only after two consecutive
observations that all satisfy the following conditions:

1. The systemd unit is active.
2. The bridge `/health` endpoint responds with `status: "ok"`.
3. `serviceId` is `herdr-lark-bridge`.
4. The reported build ID equals the build ID generated for this invocation.

The existing start behavior remains synchronous because it has no preceding
graceful stop to outlast the command-runner timeout.

## Failure reporting

If the 90-second deadline expires, the lifecycle command fails with the expected
build ID plus the final observed unit activity and bridge health/build identity.
This distinguishes a service still stopping, a unit that failed to start, a
health server that never bound, and an old process that still owns the port.

## Testing

Unit tests cover:

- restart delegates to systemd with `--no-block`;
- a matching healthy bridge succeeds only after two consecutive checks;
- a healthy old build does not satisfy the restart;
- timeout errors include the final unit and health observations.

## Non-goals

- Changing systemd timeouts or restart policy.
- Automatically repairing disconnected Lark or Herdr dependencies.
- Changing durable outbox retry behavior.
