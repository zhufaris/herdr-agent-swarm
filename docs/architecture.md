# Herdr Lark Bridge Architecture

## Who this is for

This document is for an engineer taking ownership of the bridge or diagnosing a
production session. After reading it, they should be able to identify the
authority for any observed state and follow a request from Lark through Herdr
and back to a durable Lark delivery.

## System purpose

Herdr Lark Bridge connects a Lark topic to one TraeX process in a real Herdr
pane. It lets a person start work, queue later requests, and see a safe terminal
stream in Lark while preserving Herdr as the place for local observation and
high-risk approval.

The bridge is a durable workflow coordinator, not a message relay. It does not
assume that a Lark API call, a terminal read, or a plugin event is a complete
transaction by itself.

## Ownership and authority

| Concern | Authority | Why |
| --- | --- | --- |
| Pane identity, terminal identity, agent state, foreground process | Herdr snapshot and targeted runtime observation | Herdr owns panes and the TraeX process. |
| Binding lifecycle, prompt queue, delivery intent, retry state, audit, lease | SQLite | These facts must survive a bridge restart. |
| Visible cards and messages | Lark | Lark is the external delivery target, not the source of workflow truth. |
| Process lifecycle | user systemd service | The plugin controls the service; the application does not manage PID files. |
| Plugin events | bounded wake-up hints | Events improve latency but do not create a second event log. |

When these sources disagree, do not repair SQLite from a Lark card or infer a
pane state from a card. Reconcile against Herdr, then let the normal durable
projection update SQLite and Lark.

## Runtime shape

```text
Lark message or card action                 Herdr plugin event
             |                                      |
             v                                      v
  durable inbound acceptance                    UDP wake-up hint
             |                                      |
             +----------> SyncCoordinator <---------+
                              |
                +-------------+--------------+
                |                            |
                v                            v
        prompt and binding workflow    SessionReconciler
                |                            |
                v                            v
          Herdr command adapter      authoritative Herdr snapshot
                |                            |
                +------------ BridgeEvent ---+
                              |
                              v
                    run-card and topic projection
                              |
                              v
                    SQLite outbox -> Lark adapter
```

The composition root creates every adapter and injects it into the application
modules. Runtime modules do not read plugin paths or process-manager state
directly.

## Request lifecycle

1. The Lark adapter normalizes an incoming message or card action.
2. The coordinator rejects messages outside the configured chat and bridge-owned
   messages, then durably records the rest before attempting business handling.
3. A command is handled as a binding or operational workflow. Ordinary text in
   an active bound topic becomes a prompt job. A message received during an
   active turn may become steering when the runtime confirms that steering is
   safe. Exact, case-insensitive `/stop` is a priority steering command only
   while the supervised turn is explicitly `working`: it bypasses queued
   ordinary prompts without cancelling or reordering them. In every other
   state, including a race where the turn stops before injection, it is rejected
   and never falls back to the ordinary FIFO.
4. A per-binding worker claims one dispatchable job. The user text is sent to
   Herdr unchanged; the bridge adds no hidden prompt suffix.
5. Herdr runs or observes TraeX. Structured state is preferred; terminal and
   process evidence provide bounded fallbacks where Herdr reports `unknown`.
6. The coordinator publishes domain events. Card projection materializes
   run-card and topic views, then records Lark work in the outbox.
7. The publisher delivers outbox work, retaining retries and dead letters. A
   delivery failure never repeats a submitted TraeX prompt.

Interrupted running prompts are detached instead of replayed. On restart the
bridge observes the surviving pane and resumes delivery or marks the situation
explicitly uncertain. Jobs that never started remain queued.

## Reconciliation and events

Herdr plugin hooks send a small loopback datagram containing only bounded event
metadata. The event receiver coalesces bursts and requests reconciliation for
the affected workspaces. It does not mutate bindings from the hook payload.

`SessionReconciler` is the sole convergence path for event-driven and periodic
recovery:

1. Read one current Herdr snapshot when available, with a compatibility fallback
   for older Herdr installations.
2. Restrict the result to configured workspaces.
3. Detect missing panes, terminal identity changes, unknown agent states, and
   eligible unbound TraeX panes.
4. Read bounded terminal output only where it is needed.
5. Update binding state, publish lifecycle events, and wake eligible queues.

Periodic reconciliation remains required. A missed UDP datagram may delay an
update, but must not change the final converged state.

## Answer streaming and pagination

Every new ordinary prompt owns an Answer CardKit entity. Its fixed Markdown
element is updated through CardKit streaming rather than by repeatedly replacing
the whole Lark message. The original Lark message remains the request record.

Terminal observations are normalized before persistence or delivery. ANSI and
terminal chrome, prompt echo, reasoning blocks, internal protocol markup, and
secret values are removed or redacted. Overlapping terminal windows append only
new visible material. When a terminal redraw has no reliable overlap, the active
transient terminal view is replaced with the new safe screen (`replace-all`),
which prevents an entire redrawn terminal from being appended twice. Final
TraeX answers then converge the card to the completed result.

Each run-card stores the active Answer page: its Lark message ID, CardKit ID,
element ID, source start offset, page index, and sequence. When content reaches
the safe CardKit size, the bridge finishes the active page, creates a
continuation card with a stable page idempotency key, and makes that page active.
Frozen pages are never patched again. Markdown fences are closed and reopened
only in the render copy; the persisted Answer remains canonical source text.

The current implementation keeps the active page in the run-card projection and
uses durable outbox records as the history of creation and delivery. It does not
yet have a separate `answer_pages` table.

## Lark delivery

All user-visible replies are first represented as SQLite outbox rows with stable
idempotency keys. The publisher delivers card replies, card updates, streaming
card creation, stream content, and stream finalization. It marks successful rows
delivered; transient failures are retried with backoff; repeated failures become
dead letters that an operator can retry or dismiss.

Order is important inside one CardKit element because sequences must increase.
The publisher assigns every outbox row a durable delivery order and drains only
the head of each target lane. Work is serial within a lane, including retries,
while up to four independent lanes may make progress concurrently. A failed or
future-due head blocks only its own lane. Lark requests use a dedicated bounded
timeout; HTTP 429 responses honor a bounded `Retry-After`, and other transient
failures use jittered exponential backoff.

## Process lifecycle and diagnostics

The supported production owner is a user systemd service installed and operated
through Herdr plugin actions. The application also holds a fenced SQLite lease,
which protects against accidental duplicate processes sharing one database.

Health endpoints have separate meanings:

- `/health` means the process can answer requests.
- `/ready` additionally requires the lease, configured project paths, Herdr,
  and Lark to be usable.
- `/status` returns a sanitized operational snapshot even when dependencies are
  degraded.

Shutdown stops ingress, waits for known work, and detaches observers if the
grace period expires. It does not replay work or delete user state. Logs and
status deliberately exclude prompt bodies, raw terminal output, card payloads,
and credentials.

## Safety rules

- Lark may not approve a high-risk TraeX action. Approval remains in Herdr.
- `/stop` is TraeX steering, not a remote process or pane kill. It cannot bypass
  approval, and it is never queued when no `working` turn can accept it.
- A prompt is never automatically replayed after uncertain dispatch or restart.
- Pane attachment and replacement validate workspace, project directory, and
  terminal identity before changing a binding.
- Plugin events and Lark cards are not trusted business-state sources.
- Runtime SQLite files are service-owned data and are never version-controlled.

## Current evolution priorities

1. Model Answer pages explicitly when page-level recovery, audit, or operations
   need more than the active page and outbox history.
2. Make Lark delivery concurrent across independent card targets while retaining
   strict sequence order within each target.
3. Split the coordinator into dedicated inbound, binding-provisioning, prompt
   execution, and operations workflows.
4. Narrow the store dependency into capability-focused interfaces so workflows
   do not depend on the entire SQLite surface.

## Related documents

- [Feishu group usage](feishu-group-usage.md) explains user commands and safety
  behavior.
- Historical design and iteration records live in
  [archive/](archive/), including [archive/designs](archive/designs/) and
  [archive/superpowers](archive/superpowers/).
