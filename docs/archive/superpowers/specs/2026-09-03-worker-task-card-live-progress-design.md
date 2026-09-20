# Worker Task Card Live Progress Design

## Goal

Make each Worker task card show the same trustworthy live progress available on
the Primary task surface: the current visible status, plan steps, tool activity,
and sanitized answer deltas. The card remains a per-turn projection and never
uses generic terminal scrollback.

## Scope and Safety Boundary

Only an observation that the `WorkerTurnObserver` has attributed to the exact
Worker turn may update a task card. Attribution continues to require the current
Worker generation plus a matching runtime turn ID and canonical start time.
Unowned, mismatched, or later transcript turns are ignored.

The card may show only already-parsed, visible transcript fields:

- `mainStatus.statusTitle`;
- normalized plan steps;
- normalized tool activities;
- sanitized answer deltas and final answers.

It must not render reasoning, transcript protocol records, prompt echoes, raw
terminal output, or secrets. A dispatch receipt is still not progress or an
answer. If delivery becomes `dispatch-uncertain` before a matching transcript
turn is observed, the card retains the existing explicit uncertainty notice and
does not invent progress.

## Durable Projection

Extend `WorkerTurnCardView` with a bounded live-progress snapshot: a status
title, recent normalized progress events, and their summary. Use the same
`RunProgressEvent` vocabulary and bounded reduction rules as the Primary card
rather than introducing a parallel progress representation. Persist these fields
in `worker_turn_cards`, with migration defaults for existing rows.

Add one Worker-card reducer change for an owned observation. It updates the
answer and progress atomically in the existing projection transaction, increments
the view version only when a rendered field changes, and reserves the ordinary
Worker-card outbox update. Existing per-turn CardKit stream sequencing and page
freeze behavior remain unchanged.

## Observation and Rendering Flow

1. The transcript reader produces a typed observation.
2. `WorkerTurnObserver` first claims or validates exact transcript ownership.
3. It converts `mainStatus.planSteps` and `toolActivities` into timestamped
   `RunProgressEvent` values, and accepts a status title only after redaction and
   bounded normalization.
4. It applies the answer/progress change to the Worker-card projection, then
   wakes the Worker-card outbox workflow.
5. `renderWorkerTurnCard` presents the live status and recent progress above the
   streamed result element. Final result pages preserve their current rendering
   and continuation semantics.

The Worker card uses the same source fields as the Primary card, but does not
share the Primary's binding or Answer Card aggregate. This preserves independent
outbox lanes and prevents one task card's failure from blocking another.

## Failure and Recovery

- Card delivery or progress update retry never resubmits the Worker prompt.
- Restart recovery may replay only observations from the already-owned transcript
  boundary; each reducer operation is idempotent.
- A completion or abort transition retains the last trustworthy progress snapshot
  and applies the existing terminal state/result handling.
- For agents without typed structured observations, cards retain lifecycle-only
  behavior and explicitly keep result capture unavailable.

## Tests and Acceptance

Focused tests prove that:

1. An owned Worker observation with status, plan, tool activity, and answer
   updates only that turn's card and creates one durable delivery wake-up.
2. Repeated or unchanged progress observations do not create version churn.
3. A mismatched runtime turn, start time, or generation cannot alter progress.
4. A `dispatch-uncertain` turn with no owned transcript remains uncertainty-only.
5. The rendered Worker card includes visible status/progress and preserves
   redaction, output pagination, and existing View Worker navigation.
6. Existing lifecycle, completion, recovery, and full-suite tests remain green.
