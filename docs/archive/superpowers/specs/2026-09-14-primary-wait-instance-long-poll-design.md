# Primary `wait_instance` Long-Poll Design

## Goal

Make the Primary MCP `wait_instance` tool honor its advertised `timeoutMs`
contract without weakening durable event cursors, authorization checks, or the
gateway's bounded request lifetime.

## Selected design

Move the waiting behavior behind `PrimaryToolMessagingPort`. A new asynchronous
`waitForEvents(actor, instanceId, afterId, timeoutMs)` operation will own the
authorization and durable SQLite reads. It will query immediately, then poll at
a conservative fixed interval until events appear or the deadline expires. Each
poll re-runs authorization before querying so a stale Primary generation cannot
continue observing a Worker after its authority changes.

`PrimaryToolBroker.waitInstance` will validate and normalize the opaque cursor
and timeout, delegate to this operation, and return the last event ID as the new
cursor. A missing timeout or `timeoutMs = 0` preserves the existing immediate
poll behavior. Positive timeouts are bounded below the MCP client's 30-second
socket deadline, leaving transport and serialization headroom. Timeout is a
normal empty result, not an error.

The implementation uses low-frequency polling rather than reusing an existing
notifier. Current notifiers cover scheduler, inbound, outbound, or bridge-event
work; none is emitted after every transaction that inserts an `instance_event`.
Polling the durable table therefore avoids missed wakeups and keeps SQLite as
the source of truth. The port boundary allows a future commit-time instance
event notifier to replace polling without changing the MCP contract.

## Alternatives

### Add an instance-event notifier now

This gives lower latency and fewer reads, but every event-producing transaction
would need a reliable post-commit notification. Missing one producer would make
the wait nondeterministic. That broader infrastructure change is not justified
for this fix.

### Remove or ignore `timeoutMs`

This preserves immediate polling but contradicts the public tool schema and
forces repeated model tool calls. It does not satisfy the intended observation
workflow.

## Timing and validation

- Accept only finite integer cursors at or above zero.
- Accept only finite integer timeouts from 0 through 29,000 milliseconds.
- Query immediately before sleeping.
- Poll no more often than every 250 milliseconds and never sleep beyond the
  remaining deadline.
- Return at most the store's existing 100-event page and advance the cursor only
  to the last returned event.
- Let authorization or storage errors fail the tool call normally.
- Do not retain timers after completion.

The 29-second server bound leaves one second before the MCP client's existing
30-second gateway timeout. The MCP schema will advertise the same maximum so
clients cannot request a duration the transport cannot honor.

## Testing

Add focused tests for existing events returning immediately, `timeoutMs = 0`,
an event arriving during the wait, a deadline returning an empty page with an
unchanged cursor, invalid cursor/timeout input, and authority becoming stale
during a wait. Run the focused broker/workflow/MCP tests, typecheck, build, full
Vitest suite, architecture check, and `git diff --check`.

## Non-goals

- No SQLite schema or event-retention changes.
- No automatic Primary turn when a Worker completes.
- No changes to prompt dispatch, Worker scheduling, or Lark card delivery.
- No service installation, restart, or deployment.
