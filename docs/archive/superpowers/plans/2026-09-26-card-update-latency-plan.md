# Card Update Latency Implementation Plan

## Objective

Reduce pre-outbox latency and redundant card convergence for Primary Answer and
Main Cards while preserving durable projections, lane ordering, idempotency, and
recovery.

Design authority:
`docs/superpowers/specs/2026-09-26-card-update-latency-design.md`.

## Invariants

- Persist the newest view before scheduling Gateway work.
- Reserve an outbox intent before every Lark effect.
- Keep one ordered delivery lane per card target.
- Never send every transcript token directly to Lark.
- Terminal and checkpoint convergence remains immediate.
- Do not mutate historical production dead letters as part of this change.

## Task 1: Lock down the latency regression

Extend the scheduler and conversation projector tests with fake time. Prove that
repeated ordinary updates retain the earliest deadline, Main and Answer use the
same configured budget, and a newest durable version is selected when the timer
fires. Add an in-flight regression distinguishing newer-version work from an
ordinary same-version duplicate and an explicit checkpoint follow-up.

## Task 2: Unify the configured visibility budget

Pass `runtime.cards.updateDebounceMs` through outbound composition as both the
Answer and Main delay. Remove the private Main-only latency behavior. Keep
immediate terminal, first-content, tool-activity, and large-delta priorities.

## Task 3: Tighten in-flight coalescing

Refine `CardUpdateScheduler` so an in-flight ordinary request only creates a
follow-up when its desired view version advances. Preserve explicit immediate
checkpoint retries even when the view version is unchanged because delivery
facts may have changed. Keep retry backoff and shutdown semantics unchanged.

## Task 4: Verify and deploy

Run focused scheduler/projector/outbox tests, then the full suite, typecheck,
build, architecture check, documentation audit, public audit, and diff check.
Commit without automated co-author trailers. Stage an immutable release, force
restart through the supported lifecycle command, then verify readiness, SQLite
integrity, card convergence age, outbox lane state, and recent card-delivery
errors.
