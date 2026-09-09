# Worker Session Single-Card Implementation Plan

**Goal:** Replace new per-turn Worker Card messages with one stable, continuously updated card per Worker session while preserving durable turn history and exact-turn controls.

**Architecture:** Promote `WorkerMainView` to the only visible Worker-session projection. Keep turns and their canonical output as durable execution/history aggregates. Feed bounded current-turn state into the session view and serialize all visible delivery on the existing `worker-main:<workerId>:<workerSessionGeneration>` lane.

## Task 1: Lock down target behavior with tests

- Add domain tests for current-turn projection, terminal retention, next-turn replacement, bounded recent history, and session-generation replacement.
- Add rendering tests for live request/output/progress, legal actions, queue state, and terminal summaries.
- Add ownership tests proving a stale turn payload cannot act on the current turn.
- Add store tests proving turn acceptance creates no new Worker Task Card message.

## Task 2: Extend the Worker session projection

- Add the exact current-turn identity and bounded presentation fields to `WorkerMainView`.
- Reduce turn lifecycle/output changes into the Main View through a named projection boundary.
- Preserve per-turn rows and canonical output as history; do not make the session view authoritative for execution.
- Add idempotent SQLite migration and transactional updates where the turn and visible projection must advance together.

## Task 3: Consolidate rendering and delivery

- Render current request, status, recent progress, bounded output, terminal result, queue, and recent tasks in `worker-main-card.ts`.
- Move visible Worker live convergence to the stable session lane with monotonic view-version checks.
- Stop reserving new `worker-turn:create:<turnId>:0` and continuation-message intents.
- Keep legacy turn pages readable but permit null card/message targets for post-migration turns.

## Task 4: Move exact-turn interactions to the stable card

- Emit steer and stop actions only for a legal current turn, with turn, instance, runtime, session, and source-card identity.
- Reload and verify the stable view's current turn before acting.
- Reject prior-turn callbacks and legacy Task Card callbacks/replies without reinterpretation.
- Keep independent new-task submission and explicit `/to`, `/steer`, and `/stop` semantics unchanged.

## Task 5: Migrate recovery and retire visible Task Card writers

- Classify legacy pending, delivered, and uncertain Task Card outbox work without replaying possible external effects.
- Converge one stable card for every active Worker session at startup.
- Remove or disable per-turn visible workflow producers only after all acceptance, observer, reconciliation, and startup paths use the session projection.
- Update architecture and Feishu usage documentation to remove the one-card-per-turn model.

## Task 6: Verification and thematic commits

- Run focused Worker Main, ownership, card interaction, SQLite, outbox, concurrency, steering, observer, and reconciliation tests.
- Run `npm run typecheck`, `npm run build`, and `npm test`.
- Inspect migrations, outbox keys, action payloads, and startup convergence against the design invariants.
- Commit persistence/domain, presentation/interaction, and legacy cleanup as independently verifiable batches where the dependency order permits.
- Do not deploy, restart, merge, or push without an explicit request.
