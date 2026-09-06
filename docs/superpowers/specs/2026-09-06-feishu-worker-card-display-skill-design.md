# Feishu Worker Card Display Skill Design

## Goal

Allow a user in a configured Feishu group thread to name one Worker and ask the
Primary to show that Worker's current cards. The request posts a fresh Worker
Main Card followed by a fresh snapshot of the Worker's latest Task Card. It is
a read-only display operation: it must not create a Worker turn, submit or replay
a prompt, steer a running turn, or mutate an existing card.

Example requests include `展示 reviewer 卡片`, `显示 test worker 最新状态`, and
`唤起 reviewer worker task card`.

## Scope and authority

The operation is available only through the Primary MCP tool surface while an
ordinary Primary turn is active. The gateway derives the project, binding
generation, current prompt, and Feishu topic root from the authenticated Primary
capability. Caller-supplied routing identifiers are not accepted.

The Worker is resolved by exact display-name match among instances owned by the
current Primary binding and project. Matching is case-sensitive after trimming
surrounding whitespace. No partial, fuzzy, cross-project, or cross-Primary match
is permitted. A missing Worker returns a structured not-found error and posts no
cards. Duplicate names are treated as ambiguous and also post no cards.

SQLite projections are the source of card contents and delivery intent. Herdr is
not queried to invent fresher status, and visible Feishu cards are never treated
as workflow authority.

## Public interface

The Primary MCP server exposes `show_worker_cards` with: `workerName`, a
non-empty exact Worker display name; and `idempotencyKey`, a stable non-empty key
chosen by the calling turn for this intended display request. The gateway maps it
to the broker's camel-case operation after validating the active Primary
capability and topic scope.

On acceptance, the tool returns a concise receipt containing the resolved Worker
identity and the number and kinds of card intents reserved. The receipt says the
cards were queued, not delivered, because the durable outbox performs delivery
asynchronously. Domain errors remain distinguishable: invalid request, Worker
not found, ambiguous Worker name, no displayable Worker state, or stale Primary
capability.

The `feishu-worker-cards` skill recognizes user requests that name a Worker and
ask to display its current card/status. It calls only `show_worker_cards`, reuses
one stable idempotency key for retries of the same user request, and reports the
tool receipt. It never calls Worker prompt, follow-up, steering, or interrupt
tools as part of display.

## Durable display workflow

One narrow `WorkerCardDisplayPort` owns resolution and reservation. Within one
SQLite transaction it:

1. Revalidates the current Primary binding generation and project scope.
2. Resolves exactly one Worker by display name under that Primary.
3. Loads the current Worker Main projection and the latest Worker Task projection.
4. Creates new, immutable snapshot card identities and their initial CardKit
   delivery intents, ordered Main first and Task second in the topic outbox lane.
5. Records the operation result under the caller's idempotency key.

The idempotency scope includes the current Primary binding generation and caller
key. Repeating the same accepted invocation returns the original receipt and
does not reserve additional cards. Reusing the key with a different Worker name
is rejected as an idempotency conflict. Failed validation or name resolution does
not leave a partial card or outbox intent.

Fresh display cards are snapshots, separate from the canonical live Worker Main
and Task cards. They are rendered from the same pure renderers and current
durable views at reservation time. Later Worker activity updates canonical cards
but does not patch these snapshots. Existing cards are never replaced or edited.

The Main snapshot is always present after successful Worker resolution. If the
Worker has a latest task, the Task snapshot follows it. If the Worker has never
had a task, the second card is still emitted as a compact `暂无 Task` snapshot so
the two-card interaction remains predictable. This placeholder has no controls,
task identifier, result pages, or implied turn.

## Delivery ordering and failure behavior

Both card intents use the server-owned current topic root. They are persisted
before any Feishu API call and share the existing outbox retry/dead-letter
machinery. The Task intent is dependent on the Main intent's successful delivery,
so retries cannot visibly reverse their order. A Main delivery failure prevents
the Task from being attempted until the Main succeeds; dead-letter diagnostics
remain in the existing operational surface.

The MCP call succeeds once the atomic reservation commits. It does not wait for
Feishu delivery. A database failure rolls back the entire reservation. A later
transport failure does not repeat the MCP operation or any agent work; the outbox
alone retries delivery.

## Security and privacy

The feature inherits the configured-chat and allowed-user checks that admitted
the Primary prompt. The Primary tool socket additionally verifies the active
prompt capability, binding generation, project, and root topic. The backend does
not accept a chat ID, root message ID, binding ID, project ID, instance ID, or
card JSON from the model. Persisted and rendered content continues through the
existing bounded/redacted Worker card projections.

This is a display query with durable delivery effects, not a lifecycle or agent
control action. It therefore needs no admin privilege beyond the already
authorized Primary turn, while remaining confined to that Primary's Workers.

## Components

- `primary-tools-mcp`: declares and validates `show_worker_cards`.
- `PrimaryToolGateway`: admits the method only for a current Primary capability
  and passes server-owned scope to the broker.
- `PrimaryToolBroker`: exposes the application-facing operation and formats the
  durable reservation receipt.
- `WorkerCardDisplayPort` and SQLite implementation: resolve, snapshot, reserve,
  order, and deduplicate the two cards atomically.
- Existing Worker Main and Worker Task renderers: provide presentation without
  duplicating card layout policy.
- Existing outbox dispatcher: delivers and retries the new snapshot intents.
- `feishu-worker-cards` skill: maps natural-language display requests to the new
  structured MCP tool.

## Verification

Focused tests must prove:

- the MCP server advertises the eighth tool and maps valid arguments;
- the gateway rejects stale, cross-scope, and malformed requests;
- exact-name resolution is confined to the current Primary and project;
- one invocation atomically reserves Main then Task snapshot intents;
- a no-task Worker receives Main plus a compact `暂无 Task` card;
- retries with the same key return the same receipt with no duplicate cards;
- key reuse for another Worker is rejected;
- failure before commit leaves no snapshot or outbox rows;
- the operation creates no Worker turn and invokes no Herdr/TraeX method;
- delivery retry preserves ordering and does not re-run the display workflow.

Run the affected Vitest files, then `npm run typecheck`, `npm run build`, and the
full `npm test` suite because this crosses MCP, persistence, and outbox boundaries.
Validate the skill with the skill-creator `quick_validate.py` helper.

## Non-goals

- Displaying all Workers when no name is supplied.
- Fuzzy name search or interactive disambiguation.
- Navigating to or patching existing Feishu cards.
- Waiting synchronously for Feishu delivery confirmation.
- Creating, prompting, steering, stopping, or otherwise controlling a Worker.
- Adding a general-purpose card-rendering API or accepting arbitrary CardKit JSON.
