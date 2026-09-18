# Worker Human-Review Feishu Notification Design

## Goal

Actively notify the Primary owner in Feishu when a Worker first enters a
human-actionable `blocked` episode. The canonical Worker Main Card remains the
authoritative, continuously updated status surface; the new card reply exists
only to create a timely unread notification and a durable route back to that
status.

This design extends the earlier Worker Main progress and review-notice design,
which intentionally limited the first slice to a canonical card update. It does
not change the local-only approval boundary.

## User-visible behavior

When the current Worker task transitions from any non-`blocked` state to
`blocked`, the service posts one orange reply card in the parent Primary
conversation. The card uses the Primary card hierarchy and contains:

- title `⚠️ Worker 需要处理 · <worker name>`;
- the Primary name, Worker pane, and current task title;
- the bounded and redacted blocked notice, or the existing local-action
  fallback when no notice is available;
- an explicit statement that approval or terminal input must happen in Herdr;
  and
- a link-style CardKit action that opens the canonical Worker Main Card when
  its delivered message identity is available.

The notification mentions the parent binding's persisted `creatorOpenId` in a
CardKit Markdown element. If that identity is absent or cannot be represented
safely, the same card is sent without a mention. Missing mention data never
blocks the Worker transition or the notification itself.

The card has no approve, deny, arbitrary-input, stop-process, or pane-control
action. Reply routing and high-risk approval remain unchanged.

## Blocked episode semantics

A blocked episode begins only when the durable Worker turn changes from a state
other than `blocked` to `blocked`. Re-observing the same blocked state, changing
the notice text, receiving tool activity, refreshing the Worker Main Card,
reconciling the Pane, or restarting the service does not begin a new episode.

If the same turn leaves `blocked` and later returns to `blocked`, that is a new
episode and produces one new notification. A later Worker turn has its own
episodes.

The `instance_events.id` of the newly inserted `turn.blocked` transition is the
episode identity. The outbound idempotency key is derived from stable identities:

```text
worker-review:<workerId>:<workerSessionGeneration>:<turnId>:<instanceEventId>
```

This avoids a mutable episode counter. The existing unique outbox idempotency
constraint makes repeated handling of the same committed transition a no-op.

## Durable transaction and delivery flow

The transition path is:

```text
authoritative Herdr observation
  -> verify Worker generation, Pane, Agent session, and exact turn fences
  -> BEGIN IMMEDIATE
     -> transition instance_turns to blocked when state actually changes
     -> reduce and persist the Worker Turn Card
     -> append turn.blocked instance event and obtain its row id
     -> invalidate the canonical Worker Main projection
     -> enqueue one immutable Human Review card_reply
  -> COMMIT
  -> publish best-effort outbound and projection wake-ups
  -> outbox dispatcher delivers to Feishu
```

The notification targets the active parent binding generation and its current
`rootMessageId`. It is an immutable `card_reply` with `bindingId` populated, so
it uses the existing reply lane, retry policy, delivery fencing, dead-letter
classification, and lease ownership. It is not a Worker Main update and cannot
coalesce away the canonical status card.

If the parent binding is missing, stale, no longer active/attached, has changed
generation, or has no root message, the Worker state transition and main-card
invalidation still commit, but no standalone notification is reserved. The
transition records a bounded diagnostic reason; it must not target a retired
conversation.

SQLite remains the only durable queue authority. The post-commit wake-up carries
no notification payload, ordering, acknowledgement, or retry state. A lost wake
only delays delivery until the periodic SQLite scan. No application-level
in-memory message queue is introduced.

## Components and boundaries

### Pure card renderer

Add a dedicated renderer for the immutable notification card. It accepts an
already bounded domain input and performs the same secret redaction and CardKit
payload budgeting used by current Worker cards. It has no store, Herdr, or Lark
dependency. Mention markup is generated only from a validated opaque Open ID;
all user/model-authored strings pass through the existing escaping and redaction
paths.

### Worker transition store

Extend the projected Worker transition operation rather than adding an event
subscriber. The store detects the actual entry into `blocked`, appends the
instance event, resolves the fenced parent binding and Worker Main identity, and
reserves the notification in the same transaction. Existing non-projected and
legacy transition paths remain unable to send a notification unless they can
prove the same identities and render the same durable intent.

The operation returns whether outbound work was newly reserved so the caller can
issue the existing best-effort wake after commit. Delivery remains outside the
transaction.

### Outbox and Gateway

No new transport, queue, dispatcher, or Feishu client method is added. The
notification is a normal versioned CardKit `card_reply` intent. Existing claim,
lease, retry, uncertain-effect quarantine, and dead-letter behavior apply.

## Failure handling

- A SQLite transaction failure persists neither the blocked transition nor its
  notification intent. Reconciliation retries from fresh Herdr state.
- A post-commit process crash cannot lose the notification; startup/outbox scans
  rediscover it.
- A duplicated wake or observation cannot duplicate a notification because no
  new blocked transition event is created.
- A Feishu timeout follows existing effect-certainty and quarantine rules; the
  service never creates a second logical notification to compensate blindly.
- A permanent CardKit rejection becomes a visible dead letter without changing
  Worker state or replaying Worker work.
- Missing or stale Primary routing suppresses only the standalone notification;
  the canonical Worker state remains durable and reconcilable.

## Observability

Emit structured Pino records without notice text or Open IDs:

- `worker-review-notification-reserved` with Worker, turn, episode, binding, and
  generation identifiers;
- `worker-review-notification-mention-omitted` with reason `missing_creator`;
- `worker-review-notification-skipped` with a bounded routing reason such as
  `stale_parent` or `missing_root`; and
- existing outbox delivery events correlated by reply, binding, Worker, and turn
  identifiers.

The `/status` endpoint needs no new counter for the first slice. Notification
rows are already represented by outbox work and dead-letter diagnostics.

## Verification

Focused tests must prove:

1. A real `running -> blocked` transition atomically persists the turn/card
   projection, event, Worker Main invalidation, and one notification reply.
2. The card mentions `binding.creatorOpenId` and contains Worker, task, Pane,
   bounded notice, local-only guidance, and a canonical-card action when known.
3. A missing creator degrades to an otherwise identical unmentioned card.
4. Repeated blocked observations, notice/progress updates, duplicate wakes, and
   restart recovery do not reserve another notification.
5. `blocked -> running -> blocked` creates a second episode with a distinct
   event-derived idempotency key.
6. A stale Worker generation, Worker session generation, parent binding
   generation, or root identity cannot publish into the wrong conversation.
7. Transaction fault injection leaves neither a partial transition nor a partial
   notification.
8. Delivery retry/dead-letter behavior does not repeat the Worker transition or
   TraeX prompt.
9. The notification exposes no remote approval or terminal-input action and
   redacts known secret shapes.

After focused tests, run `npm run typecheck`, `npm run architecture:check`,
`npm run docs:audit`, `npm run build`, and the full `npm test` suite. Installation
and restart are separate operational steps and require the existing safety gates.

## Non-goals

- Periodic reminders while a Worker remains blocked.
- Notification acknowledgement, snooze, escalation, or per-user preferences.
- Direct messages or cross-chat delivery.
- Inferring human review from free-form output when Herdr is not `blocked`.
- Replacing the canonical Worker Main Card with notification cards.
- Adding an application-level in-memory queue or a second Feishu delivery path.
- Approving high-risk TraeX actions from Feishu.
