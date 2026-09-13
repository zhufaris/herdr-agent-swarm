# `/swarm panes` Worker hierarchy and thread entry

## Goal

Make the `/swarm panes` directory readable as a Primary-to-Worker hierarchy
and give every Worker row one safe thread-entry action.

## Layout

Each active Primary is one visual group:

```text
🧭 <Primary title> · <state>
   <space> · <primary pane>                         [发送主卡]
   ├ 🤖 <worker> · <state> · <worker pane>          [打开 Thread]
   └ 🤖 <worker> · <state> · 未分配
```

- The Primary identity and its pane remain the group header.
- Workers are compact indented rows directly beneath their owning Primary.
- Worker rows retain a bounded list (eight visible rows plus an overflow
  notice) so a directory card stays usable.
- A missing runtime pane is shown as `未分配`; it is not hidden.

## Thread-entry behavior

Each Worker row carries the same binding and generation fence as its Primary.

1. If the Worker session already has an active Lark Worker Thread, its action
   opens that existing thread.
2. If no Worker Thread exists, the action goes through the existing
   `worker_thread_send` workflow. Its SQLite reservation and outbox create the
   independent thread idempotently; duplicate clicks report pending/existing
   rather than creating another thread.
3. If the Worker, its parent binding, generation, pane, or Main Card identity
   changed, the action is rejected as stale.

No direct Lark conversation creation or direct Herdr pane operation is added to
the directory renderer.

## Boundaries

- The operations-query workflow shapes the read-only Primary/Worker directory
  projection.
- The card renderer only presents that projection and emits fenced callbacks.
- WorkerSessionThreadWorkflow remains the only creation path for Worker
  Threads.
- Existing `card_target_open` validation remains the only path to render a
  canonical Worker Main Card.

## Validation

Focused tests cover compact rendering, existing-thread opening, missing-thread
reservation, binding/generation fences, worker overflow, and the operations
query projection. Run the focused Vitest files, TypeScript checking, and the
build before release.
