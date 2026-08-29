# Immediate Project Selector Delivery

## Problem

`/swarm new` and `/swarm projects` persist a project selection and its CardKit reply
intent, then only wake the asynchronous outbound worker. The durable path is
correct, but the selector can appear noticeably after the command has already
been accepted. Users expect the project list card to be the immediate response
to these commands.

## Decision

Keep the durable outbox as the only Lark delivery path. After persisting the
project selection and selector-card intent, request an immediate bounded
outbound drain before command handling returns. Both `/swarm new` and
`/swarm projects` use this behavior because they share `selectProject`. The
standalone `/projects` command retains its separate instance-overview meaning.

The workflow must not call `LarkPort.replyCard` directly. Persistence remains
the source of idempotency, ordering, retry, and crash recovery. An immediate
delivery failure leaves the selection and outbox intent durable so the normal
background worker can retry it.

## Flow

```text
/swarm new or /swarm projects
  -> create durable project selection
  -> reserve selector-card outbox intent
  -> request immediate bounded outbox drain
  -> return after the immediate attempt finishes

delivery failure
  -> retain selection and outbox state
  -> background retry policy continues unchanged
```

## Boundaries

- Add an explicit immediate-drain capability to the provisioning workflow
  dependencies rather than coupling it to the concrete Lark adapter.
- Keep `OutboundWorkNotifier.wake()` for eventual progress and crash recovery.
- Reuse the existing publisher serialization so the immediate attempt cannot
  race a background scan into duplicate delivery.
- Do not change project selection authorization, expiry, project provisioning,
  topic creation, Pane creation, or initial-prompt behavior.
- Do not bypass the outbox or weaken idempotency keys.

## Error handling

The immediate drain is a latency optimization, not a new durability boundary.
If delivery cannot complete, command acceptance remains successful because the
durable intent already exists. The failure is logged and retried by the normal
outbox mechanism. A process crash between persistence and drain is handled by
startup/outbox recovery exactly as before.

## Testing

- Verify `/swarm new` attempts selector-card delivery before `handleMessage`
  resolves.
- Verify `/swarm projects` has the same behavior.
- Verify a failed immediate delivery leaves a durable selection and retryable
  outbox row.
- Verify clicking a delivered selector still provisions exactly one project.
- Run the focused project-selection and outbox tests, the full Vitest suite,
  `npm run typecheck`, and `npm run build`.

## Deployment

Refresh the generated build identity after committing, restart both configured
bridge instances through their supported lifecycle commands, and verify their
status endpoints report the new commit and `ready`.
