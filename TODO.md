# TODO

## Release version

- [x] Bump `herdr-agent-swarm` to `0.3.0` and synchronize package lock and generated build metadata.
- [x] Bump `herdr-agent-swarm` to `0.4.0` and synchronize package lock, MCP server metadata, release docs, and generated build metadata.
- [ ] Bump `herdr-agent-swarm` to `0.5.0` and synchronize package lock, MCP server metadata, release docs, and generated build metadata.

## Architecture

- [x] Build a unified event integration layer with explicit reliability classes:
  durable inbound records, transactional lifecycle/outbox intent, best-effort
  in-process wake-up hints, and bounded Herdr socket hints. Keep SQLite and fresh
  Herdr reconciliation authoritative; do not collapse these channels into one
  delivery or replay guarantee.

## Feishu pane entry threads

- [x] From `/swarm panes`, publish a selected active pane's Main Card entry
  snapshot to the group root instead of replying inside the invoking thread.
- [x] Persist a generation-fenced thread alias so replies in the new thread enter
  the selected Binding's existing Agent FIFO without creating another Binding.

## Card readability

- [x] Define one compact information hierarchy for Primary Main, Answer, Worker
  Main, and Worker Task cards.
- [x] Apply the approved hierarchy without changing callback identity, delivery,
  pagination, or recovery semantics.

## Herdr-originated messages

- [x] When a message or turn is initiated directly in Herdr rather than through
  Lark, observe its canonical transcript and converge both the owning Primary
  Main Card and the corresponding Answer Card. Preserve independent projection
  checkpoints, durable outbox ordering, exact turn ownership, and the no-replay
  guarantee; do not infer completion from rendered card state.

## Worker Session threads

- [x] Give each new Worker Session generation one independent group-root Thread
  whose root is its sole live Worker Main Card.
- [x] Route ordinary text, `/status`, `/steer <text>`, and `/stop` through an
  exact generation- and pane-fenced Worker Session identity.
- [x] Preserve existing Worker Main Card placement during upgrade and provide an
  idempotent, passive `/instances` entry card without creating a second live
  projection.
