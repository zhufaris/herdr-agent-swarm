# Card Context Boundary Implementation Plan

**Goal:** Implement the approved durable context-projection boundary for Primary Main, Primary Answer, Worker Main, and Worker Task cards.

**Spec:** `docs/superpowers/specs/2026-09-05-card-context-boundary-design.md`

## Constraints

- Work only in the isolated `feat/card-context-boundary` worktree.
- Preserve frozen Answer pages and canonical stream offsets.
- Renderer inputs are complete persisted views; renderers cannot query stores.
- Worker output remains exclusive to Worker Task Cards.
- Aggregate refresh failures never replay Agent work.
- All cross-aggregate selection is fenced by Worker session generation, parent binding, parent pane, and parent Primary prompt.

## Slice 1: Domain Views and Pure Selection

- Add shared card references and bounded Worker summary types.
- Add `WorkerMainView`, its reducer, context selector, stable ordering, and five-item terminal history.
- Extend `TopicViewState`, `RunCardView`, and `WorkerTurnCardView` with persisted context snapshots and references.
- Add pure renderer tests proving no request/result leakage and missing-link behavior.

## Slice 2: Durable Worker Session Identity and Persistence

- Add `workerSessionGeneration` to Worker instances with migration defaults.
- Add `worker_main_views` and `card_context_invalidations`.
- Implement generation-fenced load/save/freeze and coalesced invalidation operations.
- Add SQLite migration and lifecycle tests.

## Slice 3: Context Rebuild Workflow

- Implement pure selectors for Worker Main, Primary Main, and mutable Primary Answer context.
- Implement a bounded `CardContextRebuilder` that claims durable invalidations and transactionally saves/coalesces projections and outbox intent.
- Add startup/periodic recovery scanning and best-effort wake-up.
- Test lost wake-up, duplicate invalidation, unchanged snapshots, and stale generations.

## Slice 4: Product Card Integration

- Render Worker summaries on Primary Main.
- Render per-parent-turn Worker activity on mutable Primary Answer without modifying answer stream identity.
- Render Worker Main identity/runtime/current task/queue/recent-five history.
- Add Worker Task navigation references back to Worker Main and Primary Answer.
- Invalidate exact dependent projections from Worker create/runtime/turn/termination transitions.

## Slice 5: Delivery Lanes and Checkpoints

- Add Worker Main Card create/update validation and delivery checkpoints.
- Give Worker Main, Primary Main, and Primary Answer independent replaceable lanes.
- Invalidate dependent cards when target message IDs become available.
- Recreate missing outbox intent when `viewVersion > deliveredVersion`.

## Slice 6: Verification and Completion Audit

- Run focused domain, renderer, SQLite, outbox, Answer recovery, and Primary/Worker flow tests.
- Run `npm run typecheck`, `npm run build`, `npm run docs:audit`, and `npm test`.
- Audit every spec goal, invariant, migration rule, update policy row, and test requirement against concrete code/tests.
- Commit implementation in thematic verified commits without merging unrelated work.
