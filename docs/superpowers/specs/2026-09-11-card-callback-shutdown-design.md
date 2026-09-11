# Card Callback Shutdown Design

## Goal

Prevent an accepted Lark CardKit callback from mutating SQLite after inbound
shutdown reports completion. Every callback admitted before shutdown must settle;
every callback arriving after the admission fence must be rejected without
workflow effects.

## Decision

`CardActionRouter` owns a stopping gate and an `ActiveWorkTracker`. Its public
`handle()` checks the gate, then synchronously registers the complete internal
routing Promise. Every action kind is covered: instance, session, model, pane,
delivery recovery, project selection, and retired/unknown responses. Background
project selection remains part of the same tracked operation.

`stop()` closes admission synchronously and awaits the stable active set. It is
idempotent. A post-gate callback receives the generic stale response and performs
no external or durable work.

`InboundRouter.stop()` starts the CardActionRouter stop first so its admission
gate is closed before awaiting Lark transport shutdown. It then waits for Lark to
stop delivering callbacks, stops the durable message dispatcher, and awaits the
card-action drain before proceeding to downstream workers and projections.

## Verification

Tests block ordinary instance and session callbacks, start shutdown, and assert
that stop stays pending until each callback settles. A callback raced after the
gate must return stale guidance without invoking a workflow. An InboundRouter test
asserts card admission closes before the asynchronous Lark stop resolves and that
later cleanup does not begin until admitted callbacks finish.

The final gate is focused card-router and shutdown suites, typecheck, build,
architecture checks, the complete Vitest suite, and `git diff --check`.

## Non-goals

- Cancelling a callback after a durable transition may have started.
- Changing CardKit authorization or callback schemas.
- Changing durable inbound-message FIFO handling.
- Installing or restarting the service.
