# Worker Creation Card Wake-Up Design

## Goal

Make a successful Worker creation from the `/instances` CardKit form promptly
produce the canonical Worker Main Card through the existing durable projection
pipeline.

## Production evidence

Recent `/instances` interactions successfully delivered the directory card and
opened `instance_create_form`. Those particular interactions did not reach an
`instance_create_submit` callback, so opening the form alone correctly created no
Worker. Historical successful submit callbacks returned `toast_and_card`, but
Worker creation itself did not directly wake card-context convergence.

`createWorkerAgentInstance()` already commits the Worker, workspace lease, and a
`worker.created` card-context invalidation atomically. The canonical Worker Main
thread is created later by `CardContextRebuilder` through
`reserveCanonicalMain()`. The CardKit submit path returns a callback response
without adding outbox work, so it currently supplies no immediate wake hint.

## Selected design

After `instance_create_submit` receives either a durable `created` or
`created-start-failed` result, `WorkerLifecycleActions` calls its existing
`wakeOutbound` callback once before returning the toast and detail card. The
shared notifier wakes `CardContextRebuilder`, which consumes the durable
invalidation and reserves the generation-scoped Worker Main `group_card_create`
intent. The outbox dispatcher then creates the group-root Worker thread and its
ACK activates `worker_session_threads`.

The wake is only a latency hint. SQLite invalidation remains the recovery source,
so a lost wake is repaired by periodic scanning. Duplicate form callbacks remain
deduplicated by the command intent and Worker-session publication key.

## Invariants

- Worker, workspace lease, and `worker.created` invalidation remain one SQLite
  transaction.
- Card action handling never directly calls the Gateway or creates a second
  Worker card protocol.
- `start=false`, successful start, and `created-start-failed` all request card
  convergence for the persisted Worker state.
- Invalid, unauthorized, or failed-before-creation submits do not wake projection.
- Duplicate submit callbacks cannot create duplicate Worker Main roots.
- Worker Main delivery ACK remains the only route that activates the thread.

## Testing

- An accepted create submit calls `wakeOutbound` exactly once.
- A `created-start-failed` result also calls it once.
- Unauthorized or invalid forms do not call it.
- An integration test connects the real SQLite invalidation, notifier, and
  `CardContextRebuilder` and observes exactly one `worker-main:create` intent.
- Repeat submit and repeat scans remain idempotent.

## Non-goals

- Opening the create form does not create a Worker.
- No direct synchronous Gateway send from the form callback.
- No change to explicit “发送到群” for pre-existing Worker cards.
- No production install or restart without separate authorization.
