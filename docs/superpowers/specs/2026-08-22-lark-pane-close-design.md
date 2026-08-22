# Lark-initiated Herdr pane close design

## Goal

Allow a user in the configured Lark group to close the Herdr pane bound to the
current topic without making accidental or unsafe termination easy. Preserve the
existing `/herdr close` command as a non-destructive binding archive.

## Commands and user experience

The command surface is:

```text
/herdr close
/herdr pane close
/herdr pane close confirm <code>
```

`/herdr close` keeps its current meaning: archive the binding, stop accepting new
prompts from that topic, and leave the Herdr pane and TraeX process running.

`/herdr pane close` never closes immediately. For an active, safe-to-close pane,
it creates a one-time confirmation valid for 60 seconds and replies with a warning
card containing the workspace, pane ID, current agent state, expiry, and exact
confirmation command. The confirmation code is short enough to copy but is
generated with cryptographically secure randomness.

`/herdr pane close confirm <code>` closes only the pane bound to the same Lark
topic. The confirming actor must be the actor who requested the close. The code
cannot name or redirect the operation to another pane.

## Authorization and safety gates

The bridge accepts a close request only when all of these conditions hold:

- the message belongs to the configured Lark group and an active managed topic;
- the binding has a pane ID;
- no bridge worker or steering worker is active for the binding; and
- a fresh `HerdrPort.getPane()` reports `idle` or `done`.

The request is rejected when the pane reports `working`, `blocked`, or `unknown`.
`blocked` continues to require approval handling in Herdr. There is no Lark force
close command, flag, button, or permission bypass.

All safety gates are evaluated again during confirmation. A turn that started
after the confirmation was issued therefore prevents closure. Herdr does not
provide an atomic close-if-idle operation, so a small state-check/close race
remains; requiring both no bridge-owned worker and an immediate structured-state
check minimizes it without claiming a guarantee the underlying CLI cannot make.

## Durable confirmation model

SQLite stores a close request with:

- request ID and binding ID;
- pane ID captured at request time;
- requesting actor open ID;
- a hash of the confirmation code, never the plaintext code;
- `pending`, `consumed`, `expired`, or `cancelled` state;
- creation, expiry, and consumption timestamps.

Creating a new close request atomically cancels any older pending request for the
same binding. Confirmation atomically validates and consumes one pending request
before the external close call. It must match the binding, captured pane, actor,
code hash, and expiry. Lark event/message deduplication remains the outer
idempotency boundary.

The confirmation is intentionally at-most-once. If the bridge crashes after
consuming it, the bridge does not automatically retry a destructive operation on
restart. The user can inspect the pane and issue a new close request if needed.
Expired requests are harmless and may be lazily marked expired when accessed.

## Close execution and verification

`HerdrPort` gains `closePane(paneId)`, implemented as:

```text
herdr pane close <pane_id>
```

After consuming a valid confirmation, the coordinator calls `closePane()` and
then polls `getPane()` for a short bounded interval. Closure succeeds only when
the pane is no longer present. A command error followed by a missing pane is also
treated as success, making the external effect idempotent.

On verified success, the bridge archives the binding, publishes
`BindingArchived` with a pane-closed reason, and posts a final confirmation card.
Lark history is never deleted. On failure or if the pane remains present, the
binding stays active and the user receives an actionable error.

If the pane is already missing before a close request or confirmation, the bridge
does not execute a close command. It converges the binding to `orphaned` and tells
the user that the pane no longer exists.

## Concurrency and lifecycle behavior

- Normal prompt and steering acceptance remain disabled only after verified close
  archives the binding; merely requesting confirmation does not pause the topic.
- A prompt arriving before confirmation may start a worker and cause confirmation
  to be rejected by the repeated safety check.
- Concurrent confirmations compete in one SQLite transaction; only one can consume
  the request and invoke `closePane()`.
- Shutdown waits for an in-flight confirmed close operation through the same
  coordinator lifecycle tracking used for workers.
- Reconciliation observing the pane disappear after an uncertain close converges
  the binding through the existing orphan handling rather than recreating it.

## Events, cards, and audit

Close-request and close-result replies use bridge-owned standalone cards. They do
not reuse a prompt run card. The topic status card changes only after verified pane
closure archives the binding.

Audit records include:

- `pane.close.requested` for an issued confirmation;
- `pane.close.rejected` for state, actor, expiry, or code failures;
- `pane.close.completed` after verified pane disappearance; and
- `pane.close.failed` when the external operation cannot be verified.

Logs and cards may include binding and pane IDs, but never the plaintext
confirmation code after the initial response card.

## Scope

This change includes command parsing, confirmation persistence and migration, the
Herdr close adapter operation, coordinator safety checks and lifecycle tracking,
confirmation/result cards, audit records, README/help updates, and tests. It does
not add force close, remote approval, arbitrary pane targeting, process signals,
or Lark message deletion.

## Tests and acceptance criteria

Automated coverage must demonstrate:

1. `/herdr close` remains a soft archive and never calls `closePane()`.
2. `/herdr pane close` on `idle` or `done` creates a 60-second confirmation and
   does not close the pane immediately.
3. `working`, `blocked`, `unknown`, or a bridge-owned active worker prevents a
   close request and confirmation.
4. A valid code from the requesting actor closes only the pane bound to the same
   topic, verifies disappearance, then archives the binding.
5. A wrong actor, wrong code, expired code, duplicate confirmation, or superseded
   request cannot invoke `closePane()`.
6. A prompt starting between request and confirmation causes the confirmation to
   be rejected without closing the pane.
7. A missing pane converges to `orphaned`; a failed or unverifiable close leaves
   the binding active.
8. Restart never automatically replays a consumed close request.
9. Existing FIFO, steering, approval, delivery, and graceful-shutdown tests remain
   green.

Live validation uses a disposable idle pane: request close from its bound Lark
topic, confirm as the same user, verify `herdr pane get` no longer finds it, and
verify the topic becomes archived. No active or blocked production pane is used.
