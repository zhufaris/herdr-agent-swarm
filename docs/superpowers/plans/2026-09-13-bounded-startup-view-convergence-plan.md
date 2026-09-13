# Bounded Startup View Convergence Implementation Plan

**Goal:** Replace startup traversal of all historical Run Cards with durable,
bounded SQLite selection while preserving complete recovery behavior.

## Task 1: Lock selection behavior

- Add SQLite tests covering active phases, missing Answer targets, open pages,
  unresolved recovery, legacy delivery lag, and fully delivered history.
- Add a startup workflow regression with many terminal historical Run Cards and
  a small actionable subset.
- Run the focused tests red before implementation.

## Task 2: Add startup selectors

- Add `listActionableStartupRunCards(bindingId)` to the startup-view port and
  SQLite projection implementation.
- Add `loadStartupMainRunCard(bindingId, preferredPromptId)` for one-card Main
  Card restoration.
- Keep selection read-only and indexed where existing indexes suffice.

## Task 3: Refactor startup convergence

- Converge Answer state only for actionable Run Cards.
- Do not rewrite excluded historical cards for binding identity changes.
- Restore the Main Card from the independent preferred/latest selector.
- Preserve per-Binding failure isolation and outbox wake behavior.

## Task 4: Verify and commit

- Run startup-view, SQLite, Answer page, outbox dispatcher, architecture,
  typecheck, build, and the full suite.
- Run a read-only production dry-run count for the selector.
- Commit independently; do not install or restart production in this slice.
