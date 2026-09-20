# Worker Thread Entry After Creation Design

## Goal

When a Worker is created from a Primary Thread—by `/swarm worker create`, a
future Primary Agent tool, or the existing `/instances` form—the Worker must
continue to receive its canonical Main Card as a new group-level Worker Thread.
After that group-card delivery is acknowledged, the originating Primary Thread
must receive one compact, immutable entry card that lets an operator open the
canonical Worker Main Card. The Primary entry must not mirror live Worker state.

## User experience

```text
Primary Thread
  -> create Worker request
  -> Worker creation result
  -> canonical Worker Main Card is delivered to the group
  -> one `Worker 已就绪` entry card appears in the Primary Thread
       -> `打开 Worker Thread`
            -> validated canonical Worker Main Card

Group
  -> canonical Worker Main Card (Worker Thread root)
       -> all live Worker status, tasks, and Worker-thread interactions
```

The entry card is deliberately not a direct Feishu AppLink. The supported
delivery protocol has a reliable server-side CardKit callback, but no verified
cross-client deep link that can open an exact Thread root by `message_id`. The
button therefore uses the already established `card_target_open` capability:
the bridge validates that the Worker session, source Main Card message, parent
Primary binding, and group chat still agree, then returns the canonical Worker
Main Card. A stale target renders a warning and never routes a message.

## Existing boundaries reused

- `SwarmCommandGateway` remains the sole mutation owner for `/swarm worker
  create`; a later Primary tool must call the same durable `worker_create`
  command path rather than constructing an Agent instance itself.
- `InstanceControlWorkflow.createWorker` continues to atomically persist the
  Worker, workspace lease, and `worker.created` card-context invalidation.
- `CardContextRebuilder` and `SqliteWorkerSessionThreadStore.reserveCanonicalMain`
  continue to reserve the canonical group-card creation.
- The group-card delivery ACK in `SqliteOutboxDeliveryStore` and
  `SqliteWorkerSessionThreadStore.settlePublication` remains the only authority
  that records the Worker Thread root message and activates its routing scope.
- `WorkerLifecycleActions.openCardTarget` remains the only server-side handler
  that validates and materializes a canonical Worker Main target.

## Selected design

### 1. Persist an entry-delivery request with the creation intent

Successful Worker creation records the Primary reply target from the frozen
command context (`rootMessageId`, binding, actor) as a durable, generation-fenced
request for a Worker-thread entry. It is keyed by Worker ID plus Worker session
generation plus originating command intent, so duplicate Lark delivery, command
recovery, and outbox scans cannot create another entry.

No entry is reserved for rejected, failed-before-creation, or uncertain worker
creation commands. A `created-start-failed` Worker still qualifies: the Worker
and its canonical Main Card exist durably, and the entry card reports that its
runtime failed to start.

### 2. Release only after the canonical group Thread is active

The canonical `group_card_create` ACK atomically activates
`worker_session_threads` and records its root message ID. In the same SQLite
transaction, it finds pending entry requests for that exact `(workerId,
workerSessionGeneration)`, verifies their parent binding is still the current
owner, and reserves a normal `card_reply` into each originating Primary root
lane.

This ordering guarantees that a rendered entry always targets a Worker Thread
that exists. A group-card retry merely retries that delivery; it cannot emit the
entry early. A lost in-process wake remains repairable from the durable pending
entry request.

### 3. Render one minimal immutable entry card

The card contains:

- success title containing the Worker name;
- a short instruction that the live Worker conversation is in the group-level
  Worker Thread;
- exactly one primary `打开 Worker Thread` callback button.

The button carries only the existing immutable identity fence:
`card_target_open`, aggregate kind `worker-session`, Worker ID, Worker session
generation, and canonical Worker Main message ID. It has no Worker status data,
task input controls, direct terminal behavior, or dynamic update lane.

### 4. Define stale and terminal behavior

If the canonical Worker Thread cannot be activated, the pending entry remains
undelivered behind the durable group-card retry/dead-letter workflow; it is not
replaced with a fabricated link. If the Worker session or its parent Primary
becomes stale before ACK, the pending entry request is terminalized without
delivery. If the callback is clicked after a Worker session ends or is replaced,
the existing `card_target_open` fence returns a stale-target warning.

The entry card never becomes a new Worker routing surface: replies to it remain
in the Primary Thread under normal Primary routing. Operators converse with the
Worker only in the canonical group Worker Thread.

## Invariants

- Exactly one canonical Worker Main Card Thread exists per active Worker session.
- At most one entry card is delivered for one Worker session and originating
  creation command.
- No entry is delivered before canonical Worker Thread activation ACK.
- Worker creation, canonical Main placement, entry intent, and entry delivery
  retain SQLite/outbox idempotency; no direct Lark call is added to a
  coordinator.
- The entry button remains a read-only navigation capability; it cannot issue
  Worker prompts, approvals, terminal input, interruption, or deletion.
- A stale session, chat, binding, or Main Card message fails closed.
- Existing `/instances` `发送到群` behavior for legacy/pre-existing Workers is
  unchanged.

## Testing

- A Worker create command persists one pending entry request bound to its
  Primary root and worker session generation.
- Repeated delivery of the same inbound command produces neither a second Worker
  nor a second entry request.
- Before group-card ACK, no Primary entry outbox row exists.
- Canonical group-card ACK activates the Worker Thread and atomically reserves
  exactly one immutable Primary entry reply.
- Replaying delivery settlement and repeated scans remain idempotent.
- `created-start-failed` produces the entry after canonical publication; rejected
  and uncertain creation commands do not.
- Entry card rendering contains only the expected `card_target_open` fence and
  no live status/task controls.
- A valid entry callback returns the canonical Worker Main Card; a stale or
  cross-Primary callback is rejected.
- Focused Worker-thread/outbox tests plus `npm run typecheck`, `npm run build`,
  and the full test suite remain green.

## Non-goals

- No unverified URL or AppLink deep link to a Feishu message/thread.
- No real-time Worker snapshot or live-updating card inside the Primary Thread.
- No change to Worker-thread message routing or direct replies to Primary entry
  cards.
- No primary Agent tool implementation in this slice; that future tool reuses
  the existing `worker_create` command seam.
