# Ticket: Durable Answer Page State Machine

## Status

Implemented. Final migration-cleanup rollout pending on 2026-08-26.

## Problem

Long TraeX answers span multiple Lark CardKit cards. Previously, live projection
and startup recovery each advanced pagination from RunCard mirror fields. A
process exit or delayed delivery checkpoint could therefore reserve duplicate
work, mutate an older page, or leave a delivered page in a writable state.

## Outcome

Treat each persisted Answer page as an independent lifecycle object. Page
content, finalization, and continuation creation are reserved atomically with
their Lark outbox intents. Live updates, delivery checkpoints, and startup
recovery all converge through the same idempotent workflow.

The detailed behavior is defined in the linked design specification and its
implementation plan.

- Design: [Durable Answer Page State Machine](../specs/2026-08-26-answer-page-state-machine-design.md)
- Plan: [Durable Answer Page State Machine Implementation Plan](../plans/2026-08-26-answer-page-state-machine.md)

## Acceptance Criteria

1. `answer_pages` is authoritative for page identity, sequence, source offset,
   and lifecycle; RunCard page fields are compatibility mirrors only.
2. A page moves monotonically through `creating`, `active`, and either `frozen`
   or `finished`. Frozen and finished pages cannot receive new stream updates.
3. Content, terminal finish, and continuation reservations atomically update the
   page state, RunCard mirror, and durable outbox intent.
4. Each stream operation targets an exact page and uses a monotonically
   increasing sequence local to that page.
5. Live event projection, delivery checkpoints, and startup recovery use one
   `AnswerPageWorkflow`; repeating convergence creates no duplicate logical work.
6. A crash during card creation, reply attachment, content delivery, page
   continuation, or terminal finish converges without replaying the TraeX prompt.
7. Existing legacy terminal cards with a delivered finish are sealed during
   migration, and superseded pending or dead-letter stream writes are dismissed.
8. The page size remains 9,000 characters and CardKit typewriter configuration
   remains unchanged.
9. Focused tests, the full test suite, typecheck, build, clean commit-boundary
   inspection, plugin restart, readiness, and production database invariants pass.

## Out of Scope

- Scheduler retry policy.
- Health or status degradation policy.
- Worktree-name resolution.
- Prompt dispatch, steering, or Herdr observation semantics.
- CardKit typewriter timing.

## Delivery Evidence

- Design commit: `095f202`
- Implementation commit: `fc25a27`
- Legacy migration commit: `f4c4ac1`
- Focused Answer Page suite: 123 tests passed.
- Full suite: 533 tests passed.
- Typecheck and production build passed.
- The previously deployed migration build reported `ready` with matching expected
  and observed build identity. Production invariant checks found no duplicate
  active pages, no duplicate creating pages, no pending writes to immutable
  pages, and no legacy terminal page left active. The final cleanup that also
  dismisses superseded dead-letter rows is awaiting rollout.
