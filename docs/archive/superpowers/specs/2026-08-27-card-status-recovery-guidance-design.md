# Card Status and Recovery Guidance Design

## Goal

Make an individual Feishu CardKit card easier to trust at a glance by showing
when its visible state was last refreshed, clearly distinguishing active work
from a finished result, and giving safe, concrete recovery guidance when TraeX
is blocked or a binding becomes orphaned.

## User-visible behavior

### Relative update time

The request card and answer card show a compact relative update time in their
existing metadata row, for example `最后更新 刚刚` or `最后更新 3 分钟前`. The
time derives from the existing `RunCardView.updatedAt` value. It uses the same
local formatting convention as operational session cards: just now, minutes,
hours, days, then an ISO date for older values. Invalid or unavailable values
are omitted rather than displayed as misleading text.

Topic and project-entry cards may receive an optional, render-only activity
time from their caller. When it is available they render a `最后更新` label
with the formatted relative time in the existing status area. When it is
absent, the card retains its current layout. `TopicViewState` does not gain a
timestamp, and no existing topic projection or migration changes.

### Snapshot and final-result wording

Existing state labels make the output freshness clear without a separate
source badge:

- `running` cards identify the response as `实时更新中`.
- `completed` cards identify it as `最终结果`.
- queued, blocked, and failed cards retain their lifecycle-focused labels.

This wording belongs in the same compact metadata/status line that already
contains run state, Pane identity, duration, and continuation page number. It
does not add a new card section or alter answer content.

### Safe blocked and orphaned recovery guidance

Blocked and orphaned cards replace generic action callouts with an explicit
safe recovery path. The callout explains that the bridge has kept the current
work protected and has stopped automatic dispatch, then directs the user to
the matching Herdr Pane to complete approval or inspect TraeX. It states that
the bridge will automatically reconcile after the local interaction.

The card does not offer a replay/retry action or a button. It must not imply
that sending the same request is safe: a request which may have reached TraeX
remains non-replayable. High-risk approval stays local to Herdr.

## Architecture and ownership

This is a CardKit rendering-only slice. `src/cards/run-card.ts` remains the
presentation boundary and accepts only already-owned values:

1. `renderRequestRunCard()` and `renderRequestAnswerCard()` use
   `RunCardView.updatedAt`; no new adapter or store read is required.
2. The caller of `renderRunCard()` / `renderProjectEntryCard()` can provide a
   separate optional activity timestamp derived from binding runtime state,
   such as `Binding.lastActivityAt`. That timestamp is not added to
   `TopicViewState` and is not persisted as card-specific state.
3. A shared card-local relative-time helper avoids a behavior mismatch with
   `operations-card.ts`; extracting a shared utility is optional only if it
   remains a focused presentation concern.
4. State-specific text derives solely from the existing run/topic phase. The
   coordinator, event bus, runtime reconciler, SQLite store, and outbox do not
   participate in the new behavior.

## Invariants

The slice must not change any durable workflow behavior:

- no SQLite schema, reducers, migrations, view versions, outbox records, or
  idempotency keys change;
- no prompt is re-dispatched, steered, cancelled, or approved from Lark;
- no CardKit action/button, Herdr command, stream sequence, answer-page source
  offset, or continuation decision changes;
- long-message head/tail previews remain presentation-only and keep their
  current limits;
- a missing or unparsable activity time never blocks rendering.

## Error handling and compatibility

- Relative-time calculation clamps future timestamps to `刚刚`, matching the
  existing operations-card behavior.
- Historical topic/main-card callers without an activity timestamp render the
  old status layout without placeholder text.
- Custom notices from a real failure remain visible. The safe standard
  recovery instruction supplements only the blocked/orphaned presentation; it
  must not erase diagnostic context needed to inspect the Pane.
- `error` / `failed` remain failure-oriented and do not claim that automatic
  reconciliation will recover them.

## Verification

- Card-render tests cover fresh, minute-old, and unavailable timestamps,
  including omission when no timestamp is supplied to topic/main cards.
- Request and answer cards assert `实时更新中` while running and `最终结果` when
  completed.
- Blocked request/run cards and orphaned topic/main cards assert the safe Herdr
  Pane recovery instruction and absence of any replay-oriented action.
- Existing tests continue to show unchanged output, preview, pagination, and
  streaming behavior.
- Run focused CardKit tests, `npm run typecheck`, `npm run build`, and the full
  `npm test` suite before handoff.

## Non-goals

- No new output-source label such as `实时快照` or `恢复观察`.
- No tool-progress aggregation or additional monitoring dashboard content.
- No absolute timestamp display or hover/detail affordance.
- No persisted topic-card timestamp.
- No remote TraeX stop, approval, restart, or replay control.
