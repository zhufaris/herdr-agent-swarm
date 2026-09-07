# TODO

## Release version

- [x] Bump `herdr-agent-swarm` to `0.3.0` and synchronize package lock and generated build metadata.

## Architecture

- [ ] Build a unified event integration layer with explicit reliability classes:
  durable inbound records, transactional lifecycle/outbox intent, best-effort
  in-process wake-up hints, and bounded Herdr socket hints. Keep SQLite and fresh
  Herdr reconciliation authoritative; do not collapse these channels into one
  delivery or replay guarantee.
