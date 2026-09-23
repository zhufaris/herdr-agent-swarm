# Herdr Socket Shutdown Writer Fencing Implementation Plan

## Objective

Make the Herdr socket subscriber's write-capable event drain participate in the
existing shutdown ownership fence, without changing its API, event handling, or
the runtime's shutdown stage order.

## Work packages

### 1. Add failing shutdown regressions

- Change the `runtime-shutdown` fixture to classify
  `herdrSocketSubscriber` as a writer, matching the intended production wiring.
- Replace the outdated expectation that a subscriber stop failure releases
  SQLite ownership with an expectation that shutdown returns
  `ownership_retained`.
- Assert that write-fence deactivation, lease release, and store close are not
  called after that failure, while later cleanup stages are still attempted.
- Add a bounded-deadline test in which the subscriber's stop promise remains
  unsettled; assert that `herdrSocketSubscriber` is reported in
  `unsettledWriters` and SQLite ownership is retained.
- Run `npx vitest run tests/runtime-shutdown.test.ts` and confirm the production
  classification has not yet satisfied the composition-level behavior.

### 2. Apply the minimal production change

- In `ManagedBridgeRuntime`, keep `herdrSocketSubscriber` in the `ingress` stage
  and change only its lifecycle kind from `non-writer` to `writer`.
- Do not modify `HerdrSocketSubscriber.stop()`, the shutdown coordinator, the
  shared deadline, or the event callback contract.
- Run the focused shutdown and managed-runtime tests.

### 3. Synchronize architecture documentation

- Clarify in `docs/architecture.md` that stopping Herdr socket ingress also
  drains a potentially write-capable callback and therefore participates in
  the writer settlement gate.
- Preserve the existing statement that socket events are bounded hints and
  fresh Herdr snapshots are authoritative.
- Run the documentation and architecture checks.

### 4. Verify behavior and scope

- Run `npx vitest run tests/runtime-shutdown.test.ts
  tests/managed-bridge-runtime.test.ts tests/herdr-socket-subscriber.test.ts`.
- Run `npm run typecheck`, `npm run build`, and the full `npm test` suite.
- Run `npm run architecture:check`, `npm run docs:audit`, and
  `npm run public:audit`.
- Inspect the final diff and confirm there are no subscriber API, SQLite schema,
  reconciliation, no-replay, outbox, or CardKit changes.

### 5. Review and commit

- Review the implementation against repository standards and the approved
  design as separate axes.
- Resolve all material findings and repeat affected validation.
- Commit the implementation separately from the design and plan documents.
- Inspect the final commit and remove any automatically injected
  `Co-authored-by: TRAE CLI` trailer before handoff.
