# Bounded Prompt Shutdown Design

## Goal

Prevent a Bridge restart from waiting indefinitely for a TraeX prompt while
preserving the rule that uncertain work is never replayed automatically.

## Pane identity and disappearance

`herdr pane get <paneId>` is the authoritative Pane-liveness check. An
`agent_not_found` result from `herdr agent read` is not evidence that the Pane
is gone because a terminal Pane can still exist without an agent-registry
entry. During turn polling, an authoritative Pane-not-found result fails the
current prompt immediately. Transient inspection errors continue to use the
existing bounded turn timeout.

## Cancellation model

`HerdrPort.runPrompt` accepts an optional `AbortSignal`. The coordinator owns
one controller for each active turn. Normal shutdown first stops inbound work,
then waits up to 30 seconds for active turns to finish naturally. At the
deadline it aborts remaining waiters and waits for their promises to settle
before the publisher, lease, and SQLite store are closed.

Cancellation only stops Bridge-side polling. It does not send keys, interrupt
TraeX, or close a Pane. The claimed prompt is marked failed with an explicit
restart interruption message and is not replayed automatically. Queued prompts
remain durable for the next process.

## Observability

Normal completion remains silent. When the grace period expires, the
coordinator logs the number of aborted active turns. A disappeared Pane produces
the existing `turn-failed` event with a clear Pane-not-found error.

## Verification

Tests cover immediate failure after authoritative Pane disappearance, graceful
completion before the deadline, cancellation at the deadline, idempotent stop,
no work after the store closes, and unchanged normal prompt completion.
