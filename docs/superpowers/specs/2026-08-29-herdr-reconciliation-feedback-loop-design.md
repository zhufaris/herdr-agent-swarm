# Herdr Reconciliation Feedback Loop Design

## Problem

The latest bridge build can consume nearly one CPU core after startup and stop
serving `/health`. A production-database snapshot reproduced repeated
`binding-runtime-observed` passes at sub-second intervals. Each Herdr event
arriving during a reconciliation currently queues another pass, including an
event for a workspace already covered by the active pass. Terminal observation
can itself provoke another pane event, so the drain never becomes idle.

## Design

Track the workspace coverage of the active reconciliation pass. An event-driven
request is absorbed when the active pass already covers every requested
workspace. A full reconciliation covers every scoped request; a workspace pass
covers another request for the same workspace. Requests that broaden coverage
remain queued for one follow-up pass.

Periodic reconciliation remains unchanged. Herdr events are documented as
best-effort wake-up hints, so absorbing an overlapping hint is safe: the active
pass reads authoritative Herdr state, and the periodic pass remains the
convergence fallback. Prompt dispatch, uncertain-turn recovery, SQLite
transactions, and Lark delivery are not changed.

## Verification

- A reconciler test injects a same-workspace request while a scan is in flight
  and asserts that only one scan runs.
- The existing different-workspace test continues to require a follow-up scan.
- The isolated production snapshot must keep `/health` responsive without a
  continuous reconciliation loop.
- Focused tests, typecheck, full tests, and production build must pass before
  deployment.
