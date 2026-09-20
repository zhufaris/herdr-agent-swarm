# Legacy Worker Queue Convergence Design

## Goal

Remove permanently non-executable legacy Worker turns from the live queue while
preserving uncertain historical work and truthful audit state. After startup,
`queuedTurns` must describe work that can still become runnable.

## Production evidence

Production reports six queued Worker turns. Every one belongs to a Worker with
`worker_session_lifecycle = 'legacy'`, `observed_state = 'detached'`, no current
pane, and no pending pane. The current start workflow rejects legacy sessions,
so these turns can never be dispatched. The same legacy Workers also own three
`dispatch-uncertain` turns; those may have reached an Agent and must remain
unchanged.

## Selected design

Extend startup's existing `recoverInterruptedInstanceTurns()` transaction to
cancel only queued turns whose current Worker row satisfies all of these facts:

- role is `worker`;
- Worker session lifecycle is `legacy`;
- observed state is `detached`;
- both current and pending pane identities are null;
- turn generation equals the Worker's current generation;
- turn state is `queued`.

Each selected turn moves to `cancelled` with a stable explanation that the legacy
Worker session cannot be resumed. A `turn.cancelled` event is appended. If an
internal Worker Task Card projection exists, it is updated to cancelled with the
same notice, zero queue position, terminal timestamp, and unavailable result
capture. Recovery does not create or update a Gateway card.

The recovery result adds `cancelledLegacyTurnIds`. `InstanceTurnSupervisor` logs
the count separately from safe requeues. Diagnostics naturally stop counting the
cancelled rows as queued. Re-running startup is idempotent.

## Alternatives

### Exclude legacy rows only from health diagnostics

This hides the symptom but leaves misleading executable state in the source of
truth. Other queue/capacity queries could still count the work.

### Delete legacy turns

Deletion loses audit history and may break references. Terminal cancellation is
explicit and recoverable for diagnosis.

### Cancel all turns owned by detached Workers

Current active sessions can become temporarily detached and later reattach. The
legacy lifecycle plus missing current/pending pane is required proof.

## Invariants

- `dispatch-uncertain`, running, blocked, and dispatching turns are untouched.
- Active or terminated Worker sessions are untouched.
- A legacy Worker with any current or pending pane is untouched.
- Only never-started `queued` work is cancelled.
- No Agent command or Gateway delivery is issued.
- Turn state, optional internal card projection, and audit event change in one
  SQLite transaction.

## Testing

- Startup cancels queued turns for an exact detached legacy Worker and records
  `turn.cancelled`.
- Existing internal Task Card state is updated consistently without outbox work.
- `dispatch-uncertain` work remains unchanged.
- Active, terminated, or pane-bearing Workers remain unchanged.
- Repeated recovery is idempotent and diagnostics exclude cancelled legacy work.
- Run Worker store/supervisor, health, typecheck, build, architecture, and full
  test suites.

## Non-goals

- No deletion of Worker or turn history.
- No replay or resolution of `dispatch-uncertain` work.
- No attempt to revive legacy Worker sessions.
- No manual production database cleanup or deployment.
