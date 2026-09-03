# Card Freshness and Wait Projection Design

## Goal

Make Lark cards reflect active work promptly and accurately without exposing
bridge-internal polling mechanics. This change covers three related symptoms:

1. Answer Card content appears later than the corresponding TraeX activity.
2. Main Card `最后更新` does not represent the latest visible business event.
3. Transcript projection emits duplicate, low-value rows such as
   `✓ Wait · write_stdin`.

The durability, replay-safety, page-freezing, and ordered CardKit stream
invariants remain unchanged.

## Answer Card freshness

`TurnOutputObserved` continues to update the durable `RunCardView` before any
Lark delivery is attempted. The projector then coalesces bursts for at most one
short render interval. Every visible output change must become eligible for a
delivery after that interval; a minimum character threshold must not postpone a
small update indefinitely. Terminal transitions remain immediate.

Coalescing is per prompt. While a delivery is in flight, newer view versions are
retained and trigger one subsequent convergence pass. The outbox remains the
only delivery mechanism, and CardKit sequence allocation remains transactional.

Acceptance criteria:

- A small output delta below 400 characters reserves an Answer update after one
  coalescing interval even if no later output arrives.
- Multiple deltas within one interval collapse into the latest durable content.
- Completion, failure, and blocked states do not wait for the interval.
- An in-flight update cannot cause a newer view version to be lost.

## Main Card activity time

The Main Card timestamp represents the occurrence time of the latest event that
changed its visible topic projection. It must not be taken from a stale Binding
snapshot and must not be advanced by delivery retries, health checks, duplicate
observations, or persistence bookkeeping.

`TopicViewState` therefore owns a durable presentation timestamp. The reducer
updates it whenever a business event changes visible Main Card state. Main Card
rendering reads that timestamp from the desired view in every live, recovery,
and checkpoint convergence path. Existing Binding timestamps remain operational
metadata and are not presentation authority.

Acceptance criteria:

- Starting, producing visible output, blocking, completing, failing, renaming,
  orphaning, and other visible topic transitions set the displayed time to the
  event's `occurredAt`.
- Re-rendering or retrying the same view does not change the displayed time.
- A duplicate event that produces no visible change does not change the time or
  increment `viewVersion`.
- Startup convergence renders the same persisted time as the live path.

## Wait activity projection

`write_stdin`, explicit wait calls, and equivalent polling wrappers are internal
continuations of an already-running command. They are not standalone successful
user-facing activities.

Projection rules:

- A successful wait result emits no activity row. The associated Command row is
  responsible for communicating the eventual outcome.
- Repeated successful waits remain silent and cannot create duplicate rows.
- If waiting is long enough to need feedback, the bridge may expose one
  transient `… 等待命令完成` state, keyed to the underlying command/session.
- A wait failure is attributed to the associated Command when correlation is
  available. Without correlation, emit one bounded, redacted
  `✗ 等待后台任务完成 · <summary>` row.
- Raw names such as `write_stdin`, session polling mechanics, and successful
  wait payloads are never shown in the Answer Card.

The initial implementation may omit the transient long-wait row if the
transcript does not provide a stable command/session correlation. Silence is
preferred to misleading duplicate activity.

## Recovery and compatibility

No persisted prompt text, canonical answer offsets, or frozen Answer pages are
rewritten. Older `TopicViewState` rows without a presentation timestamp are
read compatibly and use a deterministic existing timestamp only for their first
convergence. New writes persist the presentation timestamp in the existing JSON
view representation. No destructive database migration is required.

## Verification

Focused tests must cover:

- a sub-threshold Answer delta becoming deliverable within the bounded interval;
- burst coalescing and in-flight follow-up convergence;
- Main Card event-time rendering, duplicate stability, and restart convergence;
- successful and repeated `write_stdin`/wait suppression;
- bounded redacted fallback for an uncorrelated wait failure.

Before deployment, run the affected integration tests, the complete Vitest
suite, typecheck, and build. Restart only through the Herdr plugin action and
confirm readiness plus an empty or draining outbox.
