# Worker Dispatch Settlement Race Implementation Plan

**Goal:** Preserve exact transcript-owned Worker state when prompt transport settlement arrives late, and make one-time Worker snapshot cards acceptable to Lark.

**Architecture:** Keep evidence precedence in `InstanceWorkScheduler`: exact persisted runtime identity outranks a later transport failure. Keep transcript completion in `WorkerTurnObserver` and preserve no-replay handling for turns without exact identity. Snapshot immutability remains an outbox/projection property rather than a CardKit `update_multi: false` setting.

## Task 1: Lock the returned-receipt race

- Add an integration test where transcript observation claims an exact turn before the driver returns `delivery-uncertain`.
- Assert the turn/card stay `running` and can later complete from the same exact transcript.
- Run the focused test and confirm it fails before production changes.
- Add the smallest scheduler guard and rerun to green.

## Task 2: Lock the thrown-error race

- Add the equivalent integration test where the driver throws after transcript ownership.
- Assert exact state is retained while a throw without exact identity still becomes `dispatch-uncertain`.
- Extend the same scheduler evidence guard to the catch path and rerun to green.

## Task 3: Correct snapshot CardKit configuration

- Add a renderer assertion that the snapshot does not emit `update_multi: false`.
- Confirm the test fails, then change only the snapshot configuration.
- Preserve the one-time banner, timestamp, canonical-card target, and absence of mutation actions.

## Task 4: Close review coverage gaps

- Strengthen duplicate display-request coverage to prove the original serialized payload and timestamp remain unchanged.
- Assert the canonical target carries worker ID, session generation, and message ID.
- Exercise current task details through `renderWorkerStatusSnapshot`.

## Task 5: Verify

- Run the affected integration and card tests.
- Run `npm run typecheck`, `npm run build`, and `npm test`.
- Run `git diff --check` and review the final diff.
- Do not mutate production SQLite, install, restart, or push without a separate explicit request.
