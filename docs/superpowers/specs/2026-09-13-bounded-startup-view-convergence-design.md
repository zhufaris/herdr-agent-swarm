# Bounded Startup View Convergence Design

## Goal

Stop bridge startup from loading and re-publishing every historical Primary Run
Card while preserving recovery of unfinished, missing, or provably lagging
Answer views and correct Main Card restoration.

## Production evidence

The deployment of build `a631299` created 1,336 history outbox rows during
startup. Of those, 1,335 were Primary Answer `card_update` rows for 1,335
different Prompts across 48 Bindings. Five targeted messages older than the
Gateway update window and were permanently rejected with `230031`. The outbox
drained, but startup performed unnecessary external work and refreshed durable
history.

The cause is `StartupViewConverger`: it calls `listRunCards(bindingId)`, mutates
identity metadata on every historical Run Card, and converges every Answer page.
The database already owns enough state to select only actionable records.

## Selected design

Replace broad startup traversal with two SQLite queries exposed through
`StartupViewStore`:

1. `listActionableStartupRunCards(bindingId)` returns only Run Cards that still
   require startup work.
2. `loadStartupMainRunCard(bindingId, preferredPromptId)` returns one card for
   Main Card restoration: the preferred active Prompt when present, otherwise an
   active phase, otherwise the latest Run Card.

The actionable selector includes a Run Card when any of these durable facts is
true:

- phase is `queued`, `running`, or `blocked`;
- no Answer message has been created;
- an Answer page is `creating`, or is an unfinished streaming page;
- an active quarantine or replacement-pending delivery recovery references the
  Prompt;
- a legacy non-CardKit Answer target has a desired version newer than its
  delivered version.

Finished/frozen historical pages with no unresolved recovery are excluded even
when binding title or space metadata changed. Historical Answer Cards are not a
live directory and must not be rewritten merely to refresh identity text.

For selected records, current convergence logic remains unchanged. Main Card
restoration is independent of the actionable Answer list, so a Binding with no
pending Answer repair still mirrors the correct current/latest Run Card.

## Alternatives

### Load all records and filter in JavaScript

This reduces outbox writes but still materializes every historical JSON view at
startup and leaves the broad port in place. The database is the correct selection
owner.

### Converge only active phases

This is fast but loses terminal Answer repair, missing-card creation, and
delivery-recovery convergence. It is too aggressive.

### Use an age cutoff only

Age is not proof that a view is converged. Recent completed history can already
be final, while an older unresolved recovery may still require action. Durable
state predicates are safer than time alone.

## Invariants

- No active, queued, or blocked Prompt is skipped.
- Missing Answer creation and unfinished Answer pages remain recoverable.
- Active quarantines and replacement-pending delivery recovery remain actionable
  regardless of age; released historical unresolved records do not trigger card
  replay.
- Frozen and finished Answer pages are not patched solely for title or space
  changes.
- Main Card restoration still selects the active Prompt before the latest Prompt.
- Selection is read-only and uses the shared SQLite context; no schema migration
  is required.
- Existing outbox idempotency, Answer pagination, frozen-page, and no-replay
  semantics remain unchanged.

## Testing

Add store tests proving each actionable predicate and excluding fully delivered
history. Add workflow tests with hundreds of terminal Run Cards proving startup
converges only the selected subset while restoring the Main Card from the
preferred/latest card. Run startup view, SQLite, outbox/Answer, architecture,
typecheck, build, the full test suite, and `git diff --check`.

## Non-goals

- No cleanup or mutation of production SQLite.
- No outbox quarantine resolution in this slice.
- No change to live event-driven card projection.
- No service installation or restart.
