# Architecture Stability Review Fixes

## Scope

This change closes three independently observed stability gaps without changing
the user-facing workflow: Gateway outbox preparation certainty, cancellation of
live Herdr commands during shutdown, and typed terminal rejection of unavailable
Worker targets. It also restores regression coverage for the current Worker card
title and the legacy inbound-message migration.

## Gateway plan preparation

An outbound row must not be claimed until the active Gateway has produced a
deterministic plan and SQLite has persisted that plan. A preparation failure is
therefore a known pre-effect failure: no provider request has occurred.

The executor will stop before `claimOutboundReply` when preparing or persisting
the plan throws. The row remains pending and unclaimed, the scan fails, and the
dispatcher's bounded scan backoff retries it. This preserves the existing row,
lane ordering, and attempt budget without recording an uncertain external effect
or quarantining the lane. A successful later scan freezes the plan before the
first claim as required by the architecture contract.

## Abort-aware command execution

`CommandRunner.run` gains an optional `AbortSignal`. The signal is passed through
the TraeX driver and Herdr adapter to prompt and agent-wait commands. The concrete
runner observes an already-aborted signal and a later abort, terminates only the
spawned child for that invocation, and waits for its close result. Timeout and
abort listeners are always removed during settlement.

Shutdown continues to mark an unresolved turn dispatch-uncertain and never
replays it. Cancellation only bounds the local observer/command lifetime; it does
not claim that TraeX did not receive the prompt.

## Typed unavailable-instance rejection

The instance messaging/control boundary will throw a domain error carrying a
stable reason code for unavailable, missing, or project-mismatched targets.
Inbound routing will classify that type (and the existing capacity error) as a
terminal inbound rejection. Error text remains presentation data and may change
without changing retry semantics. Unknown exceptions remain retryable.

## Tests and compatibility

- Gateway tests prove preparation failure never claims or quarantines a row and
  that a later scan can prepare and deliver it.
- Command-runner and Herdr-adapter tests prove abort propagation and exact child
  termination.
- Routing tests prove typed unavailable-target errors terminalize while arbitrary
  same-text errors do not gain special treatment.
- Existing Worker title assertions are aligned with the shipped renderer.
- SQLite tests retain a migration fixture proving `scope_key` backfill and the
  pending index upgrade.

No schema, Gateway plugin contract, Lark payload, or operator recovery command is
added. Existing quarantines are not modified automatically.
