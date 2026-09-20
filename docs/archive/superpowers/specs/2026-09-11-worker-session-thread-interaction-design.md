# Worker Session Thread Interaction Design

## Status

Implemented. New Worker Sessions use a canonical group-root Worker Main Card;
pre-migration sessions retain their original Main Card and can publish one
passive compatibility entry from `/instances`.

## Goal

Give every active Worker Session one independent Lark thread where operators can
read its current state and send work directly to that Worker without first
selecting a mutable conversation target or repeating the Worker name. Preserve
the existing Worker FIFO, exact-turn control fences, single-card projection,
durable outbox, and no-replay guarantees.

The durable Worker Session identity is:

```text
workerId + workerSessionGeneration
```

The thread is also fenced to the owning Primary identity:

```text
parentBindingId + parentBindingGeneration + parentPaneId
```

A thread never follows a display name, a replacement Worker, a new Primary
generation, or a newly selected instance target.

## Chosen approach

Use a generation-aware gradual cutover. New Worker Sessions use their group-root
Worker Main Card as the sole live card and thread root. Worker Sessions whose
Main Card was already delivered under a Primary thread keep that canonical card
and may receive one static group-root entry card. They are not moved and do not
gain a second live projection.

Rejected alternatives:

- Repointing an already delivered Worker Main View to a new message would make
  claimed or uncertain delivery effects ambiguous and invalidate exact-card
  callback identity.
- Keeping a live Main Card in both the Primary and Worker threads would create
  two physical writers for one view version and violate the one-card-per-session
  contract.

The cutover is per `workerSessionGeneration`, not per process restart. A routine
runtime restart that preserves the logical Worker Session keeps its existing
thread mode and card identity. Only creation of a new logical Worker Session
generation selects the new canonical group-root mode.

## User experience

### New Worker Sessions

Creating a Worker reserves one Worker Main Card as a new root message in the
configured group. That root starts the Worker's independent thread. The root
card remains the single stable Worker Main Card for the lifetime of that Worker
Session generation and is updated in place as runtime state, current work, queue
depth, progress, and recent results change.

The Primary Main Card and `/instances` directory show a bounded Worker summary.
They do not create another live Worker card. The directory exposes a
`发送 Worker 卡片到群` action. If the Worker thread is still being delivered,
the action reports that state. If the thread is already active, it returns
`Worker 对话已存在` and its bounded root identity without reserving another
delivery effect. It never creates a second Worker thread.

### Existing Worker Sessions

Upgrade does not automatically publish cards for every existing Worker. From
`/instances`, an operator may choose `发送 Worker 卡片到群`. The action creates
one static Worker entry card as a group root and activates an independent thread
for the exact existing Worker Session. Repeating the action reuses the same
thread identity and does not create another root.

The entry card shows Worker identity, owner Primary, runtime state, current task
summary, queue depth, and a note that it is a compatibility entry. It is a
snapshot, not a live Worker Main Card. It has no current-turn mutation buttons.
`/status` inside the thread provides a fresh status card, and the existing
canonical Worker Main Card continues to receive live updates in the Primary
thread.

When that logical Worker Session is replaced by a new
`workerSessionGeneration`, the old entry thread becomes stale and the new
generation uses a canonical group-root Worker Main Card. Historical cards stay
visible but cannot route instructions to the replacement.

### Thread-local interaction vocabulary

Inside an active Worker thread:

| Input | Meaning | Durable behavior |
| --- | --- | --- |
| Ordinary text | Start new work for this Worker | New independent FIFO turn |
| `/steer <text>` | Supplement the current active task | Exact-turn steering after fresh ownership checks |
| `/stop` | Stop the current active task | Exact-turn interrupt; queued work is untouched |
| `/status` | Inspect this Worker | Fresh passive status card in this thread |

Ordinary text always means a new FIFO turn, even when another turn is running.
It never silently becomes steering. `/steer` never falls back to creating a new
turn when no exact active turn exists. `/stop` never stops the Worker process,
removes the Worker, or cancels its queue. High-risk approval and protected local
input remain in Herdr.

Existing explicit Primary-thread commands remain compatible:

```text
/to <worker> <text>
/steer <worker> <text>
/stop <worker>
```

The persistent `conversation_targets` selection remains supported for unbound
legacy conversations, but Worker threads do not read or write it. The thread's
immutable session binding is its routing authority. The `设为当前目标` action is
not shown as the primary way to enter a Worker thread.

## Reply and command precedence

Ingress persists and deduplicates the normalized Lark event before routing. It
then applies this order:

1. Resolve the message topic/root against an active Worker Session thread.
2. In that context, parse the thread-local `/status`, `/steer <text>`, and
   `/stop` forms.
3. Route any remaining non-command text as a new FIFO Worker turn.
4. Only when no Worker thread owns the root, continue through existing global
   instance-command and Primary-binding routing.

Historical Task Cards retain the current single-card migration behavior: direct
replies do not regain steer/follow-up semantics and do not override the owning
Primary message path. This order makes replies to the Worker Main root and
ordinary messages elsewhere in its thread target the fixed Worker Session.
Global commands that name a Worker retain their current grammar.
Topology-changing Primary commands such as creating, attaching,
resetting, resuming, archiving, renaming, reattaching, or closing a Primary are
rejected in Worker threads with guidance to return to the owning Primary thread.
Worker create, remove, start, and stop-process operations remain available only
from their existing fenced management surfaces, not as ordinary thread text.

## Durable authority and schema

Add a dedicated `worker_session_threads` aggregate rather than overloading
`binding_thread_aliases`. A Primary alias routes to a Binding FIFO; a Worker
thread routes to an instance-turn FIFO and therefore has different ownership and
lifecycle rules.

Each row stores:

- a unique thread record ID;
- `worker_id` and `worker_session_generation`, unique as a pair;
- parent Binding ID, captured Binding generation, and parent pane ID;
- configured chat ID;
- mode `canonical-main` or `legacy-entry`;
- lifecycle `legacy-unpublished`, `reserving`, `active`, or `stale`;
- returned topic ID and root message ID, each unique once known;
- the source Worker Main message ID for legacy-entry fencing;
- a stable publication key and originating action identity when user initiated;
- creation, activation, stale, and update timestamps.

The row owns only Lark conversation routing and card placement.
`agent_instances`, `instance_turns`, `worker_turn_cards`, and
`worker_main_views` remain the runtime, FIFO, history, and projection
authorities. The thread does not own a second queue or Agent session. It is
lease-fenced, included in SQLite integrity checks, and retained while referenced
by inbound or outbound durable records. Worker and parent Binding identifiers
are logical, generation-fenced references rather than cascading foreign keys so
that a removed Worker cannot erase the historical root needed to reject later
messages safely. Active-row integrity checks still require both owners to exist
and match.

An active lookup succeeds only if all of these still match: chat, Worker ID,
Worker Session generation, parent Binding ID and generation, parent pane, active
Worker Session lifecycle, and active/attached parent Binding. Any mismatch fails
closed even if asynchronous cleanup has not yet marked the row stale.

## Card placement and delivery protocol

Extend the existing `group_card_create` intent with a Worker Session thread
target. The outbox row carries the thread record ID plus Worker ID and Worker
Session generation. Target chat, mode, card payload, aggregate identity, and
idempotency key are frozen after claim. Worker Session group creates use a
session-specific lane such as:

```text
worker-thread:<workerId>:<workerSessionGeneration>
```

For a new canonical Worker Session, normal Worker provisioning first persists
the instance and establishes its runtime according to the existing checkpointed
lifecycle. The first eligible Worker-card projection then uses one SQLite
transaction to record the Worker Main View, reserve a `canonical-main` thread
row, and insert the group-card create intent. No Lark call occurs in that
transaction. Worker provisioning success does not depend on immediate Lark
delivery. On delivery ACK, one transaction activates the thread, checkpoints the
returned root/topic, sets the Worker Main View's sole `messageId` and `cardId`,
advances delivered version, records the bridge message, and settles the outbox
row. Subsequent Worker Main updates keep using the existing
`worker-main:<workerId>:<workerSessionGeneration>` projection lane and target the
confirmed root card.

For a legacy entry, one transaction verifies the exact active Worker, Worker
Session generation, parent Binding generation/pane, current canonical Main Card
message, configured chat, and operator authorization. It then reserves or reuses
the `legacy-entry` row and inserts a group-card create containing a passive
snapshot. Delivery ACK activates only the thread row; it never changes the
canonical Worker Main View's `messageId`, `cardId`, or delivered version.

A duplicate action, retry, or restart reuses the unique session-thread row and
stable Lark idempotency key. If Lark may have accepted creation but SQLite cannot
checkpoint the result, the effect remains uncertain. The service does not issue
another create automatically or infer success from a visible card.

An action for an already active thread is a read-only lookup. It returns a
bounded `already exists` result with the known root identity and creates no
outbox row. This version does not attempt to forward or re-share an existing
thread.

## Message acceptance and result placement

For ordinary text in an active Worker thread, acceptance atomically persists a
new `instance_turn`, its durable Worker-turn history/projection facts, the source
message identity, and relevant projection invalidations. It uses the inbound
Worker thread root as the result context. The existing per-Worker scheduler still
dispatches at most one ordinary turn at a time and preserves FIFO ordering.

The canonical Worker Main Card is the live result surface for new-mode sessions.
No per-turn live Task Card is created. For a legacy-entry thread, the canonical
Main Card remains in the Primary thread, so `/status` and bounded operation-result
cards in the Worker thread acknowledge acceptance and expose current state
without becoming a competing live Main projection. Durable turn history remains
available regardless of where the canonical Main Card is displayed.

Prompt acceptance and Agent dispatch are independent of Lark delivery success.
A retry repeats only card or pointer delivery. It never repeats a Worker turn,
steer, stop, or TraeX prompt.

## Exact-turn controls

Thread-local `/steer <text>` and `/stop` first resolve the active thread and then
reload the Worker instance, Worker Session generation, parent ownership, current
turn, runtime generation, runtime turn ID, and Agent session identity. The
operation is accepted only if the current turn is uniquely active and eligible.
Its durable operation records the exact turn identity before transport.

If the active turn settles, changes, detaches, or becomes uncertain between
rendering and execution, the operation fails closed. Steering is never queued as
ordinary work and stopping never affects the next FIFO item. Existing Worker Main
Card buttons keep their exact source-card and turn fences. A legacy entry card
does not carry those buttons because it is not the canonical live projection.

## Lifecycle, migration, and rollout

The schema migration classifies every already persisted active Worker Session as
`legacy-unpublished`, whether or not its Main Card message ID is populated. This
is an explicit compatibility marker: upgrade creates no Lark message, cancels or
repoints no existing create effect, and sends no Worker prompt. Only an operator's
later `/instances` action can atomically move that marker to `reserving` and
create the passive entry intent. Worker Sessions created after migration have no
legacy marker and select canonical group-root placement on their first eligible
Main View projection.

New Worker creation uses canonical group-root placement after the migration is
active. Existing legacy sessions receive an entry thread only through an explicit
operator action. A Worker process restart that preserves the logical session does
not change placement. Session termination freezes the Main View and stales its
thread. A new logical generation receives a new row and root card; an old thread
never rebinds to it.

Parent Binding archive, reset cutover, pane replacement, detach, or generation
change makes the Worker thread unroutable. Reconciliation may mark it stale
eagerly, while every lookup independently enforces the same fence. Queued or
running work follows the existing Worker lifecycle policy; this feature does not
invent automatic replay, retry, reassignment, or cancellation.

Rollout order:

1. Add the thread schema and dual-mode read support.
2. Add group-create ACK handling and routing while preserving old Worker Main
   delivery.
3. Enable canonical group-root placement for newly created Worker Sessions.
4. Expose the opt-in legacy-entry action in `/instances`.
5. Observe duplicate-root, stale-route, outbox uncertainty, and exact-turn
   rejection metrics before removing selected-target emphasis from the UI.

## Failure behavior

- Group-root creation failure leaves the thread `reserving`; it is not routable.
- Permanent delivery rejection or exhausted retries surfaces through normal
  dead-letter health. It does not roll back Worker creation or submit work.
- An active thread with a temporarily stale card still routes by SQLite identity,
  not visible card text.
- A missing, duplicate, or mismatched root mapping rejects the message and emits
  a bounded operator-facing explanation. It does not fall through to Primary or
  a selected instance.
- A stale session returns guidance to open `/instances` from the owning Primary.
- Queue-full, stopped Worker, detached runtime, or inactive parent errors are
  persisted and presented using existing bounded error handling.
- Shutdown detaches in-flight observers and preserves durable work; it does not
  manufacture delivery success or replay uncertain prompts.

## Security and observability

Configured-chat, user-origin, and operator allowlists remain mandatory before
thread lookup or command execution. Callback values and messages cannot select an
arbitrary chat, Worker, pane, generation, terminal command, or root. High-risk
approval, arbitrary terminal input, process kill, and pane kill remain outside the
Lark bridge.

Structured logs and status diagnostics include bounded `workerThreadId`,
`workerId`, Worker Session generation, parent Binding ID/generation, root ID,
outbox reply ID, turn ID, and outcome. They do not include prompt text, card
payloads, credentials, or raw terminal output. Health distinguishes
legacy-unpublished, reserving, active, stale, retrying, dead-lettered, and
uncertain thread publication.

## Verification

Focused tests must prove:

- a new Worker Session reserves exactly one group-root Worker Main create;
- delivery ACK atomically activates its route and checkpoints the sole Main Card;
- several turns update the same group-root Worker Main Card without Task Card
  creation;
- ordinary thread text creates FIFO work for the fixed Worker even when another
  conversation target is selected elsewhere;
- `/steer <text>` and `/stop` operate only on the freshly resolved exact active
  turn and never fall back to queueing;
- `/status` renders a fresh bounded snapshot in the Worker thread;
- historical Task Card replies retain the current single-card fail-closed or
  Primary-path behavior and are never reinterpreted as Worker-thread commands;
- global named `/to`, `/steer`, and `/stop` commands retain their Primary-thread
  behavior;
- topology-changing commands are rejected from Worker threads;
- stale chat, root, Worker generation, Worker Session generation, parent Binding
  generation, pane, lifecycle, or attachment fails closed;
- a legacy session keeps its original Main target and gets at most one passive
  entry root after explicit action;
- a process restart preserves the logical session thread, while a new Worker
  Session generation gets a distinct root and fences the old one;
- duplicate action, duplicate inbound delivery, retry, restart, and uncertain
  group-create checkpoint do not duplicate a root or Agent operation;
- migration supersedes only provably unattempted card creates and preserves all
  attempted or uncertain effects;
- outbox ordering, claim immutability, lease fencing, shutdown, retention,
  integrity, authorization, queue, Worker Main, and full regression suites remain
  green.

Before handoff, run the focused command/routing, instance messaging, Worker Main,
SQLite migration/store, outbox delivery/recovery, concurrency, and lifecycle
tests, followed by `npm run typecheck`, `npm run build`, `npm test`, and
`git diff --check`. A configured real-user smoke remains non-mutating unless the
operator separately authorizes live Lark writes.

## Non-goals

- Moving an already delivered Lark card or deleting historical cards.
- Maintaining two live Worker Main Cards for one session generation.
- Making a display name, selected target, or visible card text routing authority.
- Changing per-Worker FIFO order or dispatch concurrency.
- Retrying failed, cancelled, or dispatch-uncertain Agent work automatically.
- Cancelling queued Worker turns through `/stop`.
- Remote approval, arbitrary terminal input, process kill, or pane kill.
- Changing Primary Main, Primary Answer pagination, canonical output offsets, or
  the existing group-root Primary pane-entry alias contract.
