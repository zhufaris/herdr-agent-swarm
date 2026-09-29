# Worker Answer Startup Race Implementation Plan

**Goal:** Keep a newly dispatched Worker turn observable long enough to bind its exact TraeX transcript turn instead of completing it with an empty rich-text Answer during a transient idle-pane report.

**Design:** Add a 15-second Worker runtime-turn binding grace policy to `InstanceTurnSupervisor`. Use the Worker card's durable `startedAt` and an injected clock. During the grace period, idle/done is non-terminal; after expiry it becomes `dispatch-uncertain`. Do not change transcript parsing, Answer rendering, outbox delivery, or prompt dispatch.

## Task 1: Lock the startup-race contract

**Files:**

- Modify `tests/instance-turn-supervisor.test.ts`

1. Make the fixture enter `running` through the real card projection so `startedAt` is durable.
2. Assert an idle pane before 15 seconds leaves the turn running with no completion event or wake.
3. Assert an idle pane after 15 seconds becomes `dispatch-uncertain`, not completed.
4. Preserve coverage for dispatching, working, blocked, exact-turn recovery, snapshots, and targeted observation.

## Task 2: Implement the bounded observation policy

**Files:**

- Modify `src/coordinator/instance-turn-supervisor.ts`

1. Add a named 15-second runtime-turn binding grace constant.
2. Inject a clock for deterministic tests.
3. When a running or blocked Worker card has no exact runtime identity, ignore idle/done inside the grace window.
4. After expiry, transition to `dispatch-uncertain` with an actionable notice and no prompt replay.
5. Retain the existing conservative behavior for legacy/headless turns without a stable `startedAt`.

## Task 3: Verify and commit

1. Run the focused supervisor and rich-text Worker Answer tests with the Vite runner config loader.
2. Run `npm run typecheck` and `npm run build`.
3. Run the full Vitest suite with the runner config loader.
4. Review the final diff and commit source/tests separately from the design and plan docs.
5. Stage a release with `./install.sh`; restart only when the active-work safety gate permits it, then verify the exact build identity and a live Worker Answer turn.
