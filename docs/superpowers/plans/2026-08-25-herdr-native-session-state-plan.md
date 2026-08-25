# Herdr Native Session State Implementation Plan

1. Extend `HerdrPane` and adapter schemas with an optional native Agent session
   reference; add snapshot parsing tests.
2. Add a bounded, reconnecting Unix-socket event subscriber with focused protocol
   and lifecycle tests.
3. Compose the subscriber in `main`, route its events through the existing
   reconciliation entry point, and keep plugin UDP hints as compatibility input.
4. Propagate the invocation-time Herdr socket path into the managed systemd unit
   and test unit rendering without hardcoding a session path.
5. Make structured Agent identity primary, limit process inspection to unknown
   detection, and gate turn-output reads on native revision changes.
6. Add integration coverage for duplicate event wake-ups and verify no changes to
   no-replay, FIFO, steering, model/mode, and outbox behavior.
7. Update architecture and operator documentation with the final boundary and
   diagnostics.
8. Run focused tests, full Vitest, typecheck, build, and `git diff --check`; restart
   the linked plugin and verify readiness/status/logs plus a real native event
   connection.
9. Perform a prompt-to-artifact completion audit against every ticket acceptance
   criterion before declaring completion.
