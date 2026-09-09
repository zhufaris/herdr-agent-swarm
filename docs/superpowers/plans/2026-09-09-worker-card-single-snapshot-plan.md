# Worker Card Single-Snapshot Implementation Plan

**Goal:** Make `show_worker_cards` return one clearly labeled, read-only Worker status snapshot without changing the canonical Worker Main projection.

**Architecture:** Keep authorization, idempotency, and durable outbox reservation in `SqliteWorkerCardDisplayStore`. Move snapshot composition into a dedicated presentation function over `WorkerMainView`, and reserve one immutable `card_reply` per display request.

## Task 1: Lock the public behavior with tests

- Change display-store tests to require one `worker-snapshot` receipt and one outbox row.
- Assert duplicate requests do not enqueue another reply.
- Add rendering coverage for the snapshot banner, stable generated timestamp, current/latest task details, no-task state, absence of mutation actions, and optional canonical Worker Main target.
- Preserve rollback coverage when rendering fails.

## Task 2: Add the consolidated snapshot presentation

- Add a snapshot-specific renderer beside `renderWorkerMainCard`.
- Reuse bounded Worker Main sections while changing the title/subtitle and adding an explicit non-updating banner and generated timestamp.
- Suppress task, steer, interrupt, and new-task actions.
- Emit only an identity-fenced canonical Worker Main link when its message ID exists.

## Task 3: Contract and store contraction

- Change `WorkerCardDisplayReceipt.cards` to `['worker-snapshot']`.
- Replace the two-renderer store input with one snapshot renderer that receives the selected `WorkerMainView` and captured timestamp.
- Remove the separate latest-Task query and reserve one `card_reply` in the display lane.
- Keep historical receipt JSON and legacy Task Card storage untouched.

## Task 4: Documentation alignment

- Update the MCP tool description to call the result a one-time snapshot.
- Update `docs/feishu-group-usage.md` and architecture documentation wherever they imply that `show_worker_cards` emits live cards.

## Task 5: Verification and handoff

- Run focused Worker display, Worker Main rendering, instance messaging, and architecture-boundary tests.
- Run `npm run typecheck`, `npm run build`, and `npm test`.
- Review the diff for stale two-card terminology and accidental changes to canonical projection/outbox behavior.
- Commit the implementation as one independently verifiable change; do not install, restart, or push without an explicit request.
