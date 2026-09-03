# P0 Delivery Pressure Reduction Implementation Plan

**Goal:** Bound high-frequency CardKit updates and durable outbox history.

**Architecture:** The projector coalesces presentation updates before durable
outbox intent creation. A small runtime maintainer asks the fenced SQLite store
to delete only old terminal delivery records in bounded batches.

### Task 1: Coalesce presentation delivery

**Files:** `src/events/conversation-view-projector.ts`,
`src/events/card-update-scheduler.ts`, `tests/card-update-scheduler.test.ts`,
`tests/event-card-integration.test.ts`

- [ ] Test 1.5-second Answer coalescing, 400-character immediate Answer flush,
  and 3-second primary-card coalescing.
- [ ] Keep blocked, completed, failed, and continuation delivery immediate.

### Task 2: Retain only bounded outbox history

**Files:** `src/config.ts`, `src/domain/ports.ts`, `src/store/sqlite-store.ts`,
`src/runtime/outbox-retention-maintainer.ts`, `src/main.ts`,
`tests/sqlite-store.test.ts`, `tests/outbox-retention-maintainer.test.ts`

- [ ] Add a 14-day configurable retention window and bounded batch size.
- [ ] Delete only old delivered/dismissed rows; preserve pending/dead-letter.
- [ ] Run at startup and hourly, with no VACUUM.
