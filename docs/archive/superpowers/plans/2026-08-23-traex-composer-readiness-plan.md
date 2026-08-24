# TraeX Composer Readiness Implementation Plan

## Goal

Prevent a newly created TraeX Pane from becoming active before its composer is ready, while preserving restart-safe provisioning and FIFO safety.

## Steps

1. Add adapter regression tests for an existing TraeX process with empty output, delayed composer readiness, and readiness timeout without duplicate launch.
2. Change `HerdrCliAdapter.startTraex()` so it launches at most once and polls exact process identity plus bounded composer evidence until the command timeout.
3. Return the observed ready Pane from the startup port so provisioning can persist `lastAgentState=idle` before activation.
4. Update all provisioning paths and test doubles for the stronger startup contract. Interrupted project selection must stay at `pane_created` when startup is not ready and reuse the Pane on retry.
5. Add integration coverage proving a healthy newly provisioned binding can dispatch its first prompt and a timed-out runtime cannot become active.
6. Run focused tests, typecheck, build, full suite, and diff validation. Commit implementation separately from the design/plan.
7. Rebuild after commit, restart the plugin, and verify health/readiness/build identity. Recover `wH:p1C` in place, then confirm exactly one existing queued prompt transitions from `queued/not_started` and no duplicate Pane/topic is created.
