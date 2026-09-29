# Card Update Latency Design

## Problem

Answer Cards and Primary Main Cards can visibly trail their durable projections.
Production evidence separates projection latency from Gateway latency: recent
Lark delivery averages below one second, while Main Card convergence can remain
pending for almost two seconds before an outbox intent exists. The runtime card
debounce setting is wired only to Answer convergence; Main Card ordinary updates
still use a private 2.5-second default.

Answer updates use a 500 ms default and already flush first content, tool
activity, and terminal states immediately. Later small deltas are coalesced. The
scheduler keeps the earliest due time, so continuous updates do not move an
existing deadline, but an update arriving while a Gateway projection is in
flight currently causes another immediate convergence even when the desired
version did not advance. That duplicate work can create redundant replaceable
card updates and compete with the next useful snapshot.

Historical pending Worker stream finishes without lane heads are a separate
recovery-cleanup issue. They do not share the active Primary Answer or Main Card
lanes and are not part of this change.

## Decision

Use one configured card visibility budget for both Answer and Main Card
convergence. `runtime.cards.updateDebounceMs` remains the public setting and is
passed to both scheduler families. The scheduler continues to coalesce by card
key and retain the earliest deadline.

Priority behavior remains explicit:

- terminal lifecycle transitions flush immediately;
- first Answer content and tool activity flush immediately;
- interactive Main Card transitions use the configured budget;
- ordinary Answer and Main changes use the configured budget;
- an Answer increment at or above the existing size threshold flushes
  immediately.

When an update arrives during an in-flight convergence, a follow-up convergence
runs immediately only if its desired durable view version is newer than the
version already being converged. A same-version delivery checkpoint is still
allowed to request a follow-up because the checkpoint changes delivery facts
without changing the view version. The scheduler therefore records whether the
in-flight request came from an explicit terminal/checkpoint request instead of
treating every coalesced call as forced follow-up work.

## Data flow and invariants

The flow remains:

```text
Bridge event -> durable reducer -> keyed convergence scheduler
             -> Answer/Main workflow -> durable outbox intent
             -> ordered lane delivery -> Lark CardKit
```

No coordinator writes Lark directly. SQLite remains the projection and delivery
authority, outbox intent still precedes the external effect, and lane ordering,
idempotency, checkpoint callbacks, frozen Answer pages, and restart recovery are
unchanged. The change reduces time before intent reservation and redundant
follow-up reservations; it does not weaken durability or increase per-token
delivery.

## Observability

Existing `cardConvergence` diagnostics remain authoritative for pre-outbox
latency: pending counts by Answer/Main family, oldest pending age, coalescing,
failures, and last successful flush. Existing outbox timing continues to measure
Gateway delivery separately. This separation lets operators distinguish
scheduler delay from Lark latency and lane blocking.

## Tests

Regression tests must prove that:

- composition passes the configured debounce to Main as well as Answer;
- ordinary and interactive Main changes reserve within the configured budget;
- repeated small Answer deltas keep the first deadline and converge the newest
  version;
- a newer version arriving during an in-flight flush runs one immediate
  follow-up;
- an ordinary same-version coalesced request does not create a redundant
  follow-up, while an explicit terminal/checkpoint request still can;
- terminal updates, durable outbox ordering, and existing recovery behavior are
  unchanged.

## Out of scope

- Direct CardKit writes outside the durable outbox.
- Disabling batching or sending every transcript token.
- Mutating historical production dead letters or pending Worker stream rows.
- Changing Lark retry, quarantine, or Answer pagination policy.
