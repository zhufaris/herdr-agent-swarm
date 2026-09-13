# Worker Create Card Convergence Design

## Goal

Make a Worker created from the `/instances` CardKit form automatically receive
its canonical, continuously updated Worker Main Card thread. The creation result
must remain durable and idempotent, and a missing process-local notification
must be recoverable by the existing card-context scan.

## Production evidence

Recent `/instances` requests successfully delivered directory cards and opened
`instance_create_form`. Those specific recent interactions did not emit
`instance_create_submit`, so they did not create a Worker. Historical successful
submits returned `toast_and_card`, but current persisted Workers have no
`worker_session_threads` rows. The returned detail card is only a callback
replacement; it is not the canonical Worker Main thread.

The creation transaction already persists a `worker.created` card-context
invalidation. The missing link is the card-submit path: unlike the text command
path, it returns a callback response without waking the shared outbound work
notifier. The durable invalidation therefore waits for a later unrelated wake or
the periodic scan before `reserveCanonicalMain()` can create the Worker thread.

## Selected design

After `instance_create_submit` obtains a durable `created` or
`created-start-failed` result, `WorkerLifecycleActions` emits one best-effort
outbound-work wake before returning the callback detail card. The wake activates
the existing `CardContextRebuilder`, which consumes the durable
`worker.created`/provisioning invalidation, selects the latest Worker Main view,
and calls `reserveCanonicalMain()`. That store method atomically persists the
view, reserves one generation-scoped `group_card_create`, and later checkpoints
the returned message/card/thread identity.

The wake is not the authority. If it is lost, the periodic card-context scan sees
the same durable invalidation. Duplicate form callbacks are deduplicated by the
existing command-intent key and Worker-session publication key. Both `start=false`
and `created-start-failed` Workers receive a card representing their actual
persisted state.

## Alternatives

### Send a card directly from the form callback

This would make the response visible quickly but bypass the canonical Worker
Session thread aggregate and its durable create/ACK protocol. It could also
duplicate cards after callback redelivery.

### Create the card inside `InstanceControlWorkflow`

That couples host provisioning to Feishu presentation and transport intent. The
existing invalidation boundary already separates these concerns and preserves
recovery.

### Rely only on periodic scanning

This is durable but unnecessarily delays user-visible confirmation and appears
broken when the scan interval is long. The wake supplies latency; SQLite supplies
correctness.

## Invariants

- Worker creation and `worker.created` invalidation remain one SQLite transaction.
- No direct Gateway call occurs in instance control or card-action handling.
- Repeated submit callbacks do not create duplicate Workers or Worker Main roots.
- Startup/runtime-start failure still produces a Worker card with the persisted
  failure state.
- A lost wake delays but cannot lose card creation.
- Worker Main ACK remains the only path that activates its thread identity.

## Testing

- A successful form submit wakes the shared work notifier.
- With the real store and `CardContextRebuilder`, that wake reserves exactly one
  canonical Worker Main `group_card_create` intent.
- Repeated form submission does not create another Worker or canonical card.
- `created-start-failed` also wakes projection and renders the failed state.
- Run instance routing, command gateway, card-context, Worker thread/outbox tests,
  typecheck, build, architecture checks, and the full suite.

## Non-goals

- No direct synchronous Lark send from the creation handler.
- No change to the explicit “发送到群” action for an existing Worker.
- No automatic creation when the user only opens the form without submitting it.
- No production install or restart without separate authorization.
