# Swarm Panes Canonical Thread Forward Design

## Goal

`/swarm panes` remains a compact directory of active Primary panes and their
formal Workers. Clicking a row must place a native entry for that pane's
canonical Feishu Thread at the bottom of the group message stream. It must not
create a `HERDR PANE ENTRY`, return a snapshot card, or create another routing
scope.

Feishu does not provide a verified cross-client URL that can be derived from an
Open API message ID, and existing messages cannot be moved. Native conversation
forwarding is therefore the supported navigation mechanism: the original
Thread stays authoritative, while the newly forwarded entry appears at the
bottom of the group and opens that original Thread.

## Interaction

- `打开 Primary` forwards the binding's canonical conversation, using its
  persisted `topicId` when available and otherwise its canonical root message.
- `打开 Worker` forwards the active canonical Worker Session Thread identified
  by `(workerId, workerSessionGeneration)`.
- One click forwards only the selected Thread. `/swarm panes` never bulk-forwards
  every listed pane.
- A successful or already accepted action returns a concise success toast. A
  stale identity returns a warning and performs no external effect.

## Architecture and data flow

The directory card continues to contain generation-fenced callback values. The
Primary action is renamed from the alias-oriented `pane_card_send` behavior to a
canonical-thread forward action. The Worker action retains Worker ID, runtime
generation, Worker session generation, parent binding generation, and parent
pane identity, but routes to a dedicated read-only forward workflow instead of
`WorkerSessionThreadWorkflow.publishFromCard`.

Both paths validate current SQLite ownership before calling the Gateway effect:

1. Primary validation requires the current active, attached binding generation,
   pane ID, and canonical Main message identity to match the directory snapshot.
2. Worker validation additionally requires the current Worker runtime
   generation, Worker session generation, parent binding/pane fence, and an
   active canonical `worker_session_threads` row.
3. The workflow calls `GatewayEffectPort.shareConversation` with the canonical
   topic/root as the source and the configured group chat as the destination.
4. The action is audited. No binding, Worker Session Thread, card projection, or
   prompt state is mutated.

The existing durable Worker-thread creation path remains available to other
surfaces that intentionally create a canonical or legacy thread. `/swarm panes`
does not invoke it.

## Failure and idempotency behavior

The callback is fenced before the external call. Missing or stale canonical
identity fails closed. Gateway errors are logged and surfaced through the
existing action error path. Repeated user clicks may intentionally create a new
native forwarded entry because each click is an explicit navigation request;
they never create a new canonical Thread or routing alias.

## Tests

- The directory renders canonical forward actions for Primary and Worker rows
  and no longer renders `pane_card_send` or `worker_thread_send`.
- Primary forwarding uses the persisted canonical topic/root and targets the
  group chat after all generation and pane fences pass.
- Worker forwarding uses only the active canonical Worker Thread and rejects
  missing, legacy, stale-generation, cross-Primary, or cross-chat targets.
- Neither directory action reserves a pane alias, Worker thread publication,
  card reply, or other outbox projection.
- Focused tests, typecheck, build, and the full Vitest suite pass before
  installation and force restart.

## Non-goals

- No synthetic Feishu URL or unverified AppLink.
- No attempt to reorder or move historical messages.
- No automatic bulk forwarding when `/swarm panes` is rendered.
- No changes to normal Worker creation, Worker Main Card ownership, or message
  routing inside canonical Threads.
