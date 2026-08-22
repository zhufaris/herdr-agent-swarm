# Event-first Lark channel delivery

## Goal

Move inbound Lark handling from a coordinator-owned request flow to a durable
event flow. A received message is accepted and persisted before any TraeX work
or Lark reply occurs. Event consumers then accept prompts, execute TraeX work,
project the status card, and publish replies to the matching Lark thread.

## Scope

This change keeps the bridge as one Node process with SQLite. It does not add a
network message broker or change Lark event subscription configuration.

## Event model

`InboundMessageReceived` is emitted after chat filtering and durable ingress
deduplication. It contains the normalized `IncomingLarkMessage`; it does not
mean that a prompt was accepted.

The acceptance consumer parses commands and resolves the binding. For a regular
message it persists a prompt job, then emits `PromptQueued`. `PromptQueued` is
the acknowledgement boundary: it means the prompt can survive process restart
and has exactly one queue entry. Existing lifecycle events remain the source of
truth for binding, worker, and card state.

## Delivery model

A Lark channel publisher is the sole owner of user-visible replies. It maps:

- `PromptQueued` to one thread reply: `已接收，处理中。`;
- `TurnCompleted` to the extracted TraeX answer;
- `TurnFailed` to an actionable failure reply;
- non-worker command outcomes such as help to their existing response cards.

The publisher resolves the destination from the binding's `rootMessageId`. It
must not call TraeX or mutate prompt execution state. The worker must not call
the Lark SDK directly.

## Durable outbox

Every user-visible reply is first recorded as an outbox row before it is sent.
An outbox row has a stable idempotency key derived from the lifecycle event and
delivery purpose, a root message id, a payload kind (text or card), a payload,
and a delivery state. The outbox dispatcher marks a row delivered only after
the Lark API returns a message id, which is recorded as a bridge message.

On startup, unsent or retryable outbox rows are dispatched again. A duplicate
incoming Lark event is dropped before publishing; a replayed outbox row therefore
may retry the same API call after an uncertain network failure, but cannot create
a second logical bridge event. The initial implementation records delivery after
a successful Lark response and retries failed sends with bounded in-process
attempts plus restart recovery.

## Components

### Lark ingress

`SyncCoordinator.handleMessage` becomes small: validate target chat, ignore
bridge-originated messages, persist ingress deduplication, and publish
`InboundMessageReceived`. It no longer parses commands, queues prompts, runs
TraeX, or sends replies.

### Prompt acceptance consumer

Owns existing command parsing, binding creation and lookup, prompt queue writes,
and command lifecycle publication. It schedules the worker once a `PromptQueued`
event is accepted. Invalid requests produce a durable failure delivery without
claiming that the prompt was queued.

### TraeX worker

Claims durable prompt jobs and publishes `TurnStarted`, `AgentStateChanged`,
`TurnCompleted`, and `TurnFailed`. It never invokes `LarkPort`. Existing terminal
snapshot extraction remains unchanged.

### Lark channel publisher and outbox dispatcher

Subscribes to lifecycle events, creates idempotent outbox rows, and drains the
outbox. It is also used by standalone/help responses so all outbound Lark
messages follow one durable path.

### Card projector

Keeps subscribing only to binding and turn lifecycle events. Raw ingress does
not update the card.

## Ordering and failures

For one binding, queue order is preserved by SQLite claim order. `PromptQueued`
is published after the prompt row exists. The acknowledgement can be delayed by
an Lark outage but execution may continue; its outbox record prevents the
acknowledgement from being silently lost. A channel publishing failure is logged
and isolated from TraeX execution.

Restart recovery marks an in-flight TraeX job failed, as it does today, and then
drains pending outbound messages. It never reinjects an interrupted prompt into
the pane automatically.

## Verification

Unit and integration tests must demonstrate:

1. valid inbound text first publishes `InboundMessageReceived`;
2. a valid bound prompt produces one durable job and one acknowledgement outbox
   entry before TraeX starts;
3. worker completion produces an answer outbox entry, with no direct Lark call
   from the worker;
4. duplicate Lark delivery creates neither a second prompt nor a second
   acknowledgement;
5. a failed Lark send remains pending and is delivered by a later drain;
6. an existing card projection still receives lifecycle changes; and
7. the full TypeScript build, test suite, and deployed readiness probe pass.

## Non-goals

- Redis, NATS, or cross-process delivery guarantees.
- Automatically replaying an interrupted TraeX prompt.
- Recovering inbound Lark messages that Lark never delivered due to app scopes
  or event-subscription configuration.
