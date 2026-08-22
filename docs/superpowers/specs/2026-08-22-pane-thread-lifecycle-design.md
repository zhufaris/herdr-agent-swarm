# Pane and Thread Lifecycle Design

## Goal

Make one Lark project thread and its Herdr pane behave as one recoverable
session without treating either resource as the other. Every accepted user
message gets a durable visible outcome, partial creation can resume after a
restart, archive has deterministic queue semantics, and pane loss can recover
without silently replaying uncertain work.

## Model

The session owns three independent state dimensions:

- lifecycle: `provisioning | active | draining | archived | closed | failed`;
- attachment: `unattached | attached | degraded | orphaned`; and
- runtime: `idle | working | blocked | done | unknown`.

The binding remains the stable session identity. Its `generation` starts at one
and increments whenever a replacement pane is attached. The pane is tagged with
the binding ID, generation, and project ID when TraeX starts. A stored runtime
session ID and these tags prevent a reused pane ID or matching cwd from being
mistaken for the original session.

Presentation state is derived from these dimensions. A newly activated session
is `ready`, not `done`. `done` means that a turn actually completed.

## Lifecycle transitions

Only the lifecycle module may change lifecycle or attachment state. It validates
the expected prior state and records the transition with its user-visible outbox
work in one SQLite transaction. Supported transitions are:

```text
provisioning -> active | failed
active -> draining | archived | failed
draining -> archived | orphaned
active | draining -> orphaned
orphaned -> active | archived | closed
archived -> active | closed
```

`/herdr close` is a soft archive. It immediately stops accepting new work, lets
an already running turn finish, cancels queued turns and steering jobs, then
converges through `draining` to `archived`. If no turn is running it archives
immediately. The pane and TraeX process remain alive. A later resume operation
is allowed only after the pane identity and runtime state are freshly verified.

The separately designed confirmed pane-close flow is the only remote path to
`closed`. It never force-closes a working, blocked, or unknown pane.

## Durable inbound disposition

Processing an inbound Lark message returns exactly one disposition:

```text
prompt_queued | command_completed | user_feedback | rejected | retryable_failure
```

`accepted` means the command mutation, prompt plus request card, or explanatory
reply has been durably committed. A handler may not silently return. Retryable
failures return the inbound row to `received`; permanent rejections enqueue an
actionable card before acceptance. Duplicate delivery reuses the prior durable
result.

## Recoverable provisioning

Project creation is a persisted saga with checkpoints:

```text
selected -> pane_created -> runtime_started -> thread_created -> activated
```

Each checkpoint stores the concrete pane, runtime session, or Lark root identity
before advancing. Restart recovery inspects the last checkpoint and continues
only the missing idempotent steps. It never creates a second pane when an
existing pane may already have been created. If the external effect cannot be
determined, the selection becomes recoverable and the user gets explicit retry
or cleanup guidance instead of a terminal opaque failure.

## Attachment health and recovery

A command timeout or transient read failure changes attachment from `attached`
to `degraded`. A structured pane-not-found result, or repeated failed probes,
changes it to `orphaned`. A successful probe clears `degraded`.

When orphaned, the current running turn is failed as uncertain and is never
automatically replayed. Queued work remains non-runnable and visible. The user
can reattach the verified original pane, create a replacement generation, or
archive the session. Replacement does not replay queued work until the user
explicitly resumes it.

## Selection navigation

Completed project selections store the resulting topic and root message IDs.
The selector receipt includes a direct Lark client link to the new project root
when the platform identifiers support it, plus project, Space, and Pane details
as a fallback. Feedback posted in the old selector thread reuses the same target
when known.

## Persistence and delivery

Lifecycle transition, lifecycle-event persistence, projection version change,
and outbound card creation are committed together. The in-memory event bus is a
wakeup mechanism, not the source of truth. Startup drains persisted events and
outbox rows before accepting new messages.

Prompt state adds `cancelled`. Bindings record provisioning checkpoint,
attachment state, generation, last successful observation, degradation count,
archive timestamp, and last activity timestamp. Existing rows migrate without
destructive rewrites and preserve their current pane/thread identities.

## Retention and operations

The status endpoint reports lifecycle and attachment counts, recoverable
provisioning sessions, archived panes still present, degraded sessions, and the
oldest inactive session. It never exposes prompt bodies or terminal output.
Archived panes are not automatically deleted by default. A configurable
retention period only marks or reports cleanup candidates; destructive closure
still requires the confirmed close workflow.

## Verification

Tests cover every legal and illegal transition, durable inbound dispositions,
archive during idle/running/blocked states, queue cancellation, restart at each
provisioning checkpoint, transient versus confirmed pane loss, reattachment and
replacement generation, pane identity mismatch, direct selection navigation,
ready versus done rendering, transactional outbox recovery, migration from the
current schema, retention metrics, and existing FIFO/steering behavior.

Live verification creates a disposable project session, sends and steers work,
soft-archives it, verifies old-thread feedback, exercises a non-destructive
orphan/reattach cycle where possible, and confirms readiness and PM2 stability.
