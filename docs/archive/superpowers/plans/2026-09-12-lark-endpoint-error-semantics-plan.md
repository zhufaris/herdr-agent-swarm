# Lark Endpoint Error Semantics Implementation Plan

**Goal:** Make future Lark semantic recovery depend on the exact failed port
operation and durable target, while preserving effect certainty, claim fencing,
and existing valid Main Card and Primary Answer recovery.

**Architecture:** Wrap each Lark port failure at the executor call site with a
bounded operation/target context. Make the pure classifier return the complete
failure policy. Make SQLite consume only explicit `recoveryKind` values and keep
all settlement and replacement work in its existing fenced transaction.

## Test seams

- `classifyDeliveryError`: pure classification from error plus exact operation
  context.
- `LarkOutboxDispatcher` with a fake `LarkPort`: externally visible delivery,
  retry, dead-letter, and replacement behavior.
- `SqliteBindingStore`: durable failure settlement through its public store
  methods, using temporary or in-memory SQLite.

Tests do not call executor private methods or mock internal store modules.

## Task 1: Make `230028` a terminal content rejection

- Add a failing classifier test proving a definite `230028` response is
  `permanent + rejected`.
- Add a dispatcher test proving the current revision is dead-lettered on its
  first attempt and is not selected by automatic recovery.
- Add only the classifier rule required to make this vertical slice pass.

## Task 2: Add exact external-operation context

- Define finite operation and target enums in the delivery domain.
- Add an internal error wrapper that retains the original cause and the exact
  operation context without copying payloads or raw SDK responses.
- Wrap each Lark port call independently, including both phases of streaming-card
  creation.
- Teach `classifyDeliveryError` to unwrap the cause for safe transport facts and
  to expose the bounded operation/target fields for logging.
- Add focused tests proving effect-certainty classification remains unchanged
  through the wrapper.

## Task 3: Restrict Main Card recovery

- Add failing classifier cases proving `230099` recovers only Primary Main
  `update_card` or `update_cardkit`, and `300317` recovers only Primary Main
  `update_cardkit`.
- Add dispatcher counterexamples for a representative nonmatching reply/target;
  assert no replacement intent is created.
- Derive `stale_main_card` only from the matching context.
- Preserve existing positive Main Card replacement tests and the old-pointer
  until ACK invariant.

## Task 4: Restrict Primary Answer stream recovery

- Add failing classifier cases proving `300309` recovers only Primary Answer
  `stream_card_content`.
- Add dispatcher counterexamples for Worker stream content and a non-content
  streaming operation; assert no Primary Answer state or replacement is created.
- Derive `closed_answer_stream` only from the matching context.
- Preserve the existing positive static replacement and coverage-evidence tests.

## Task 5: Remove SQLite raw-code policy fallback

- Add store tests proving raw `230099`, `300317`, and `300309` metadata without a
  recovery kind cannot trigger semantic repair.
- Add or update positive store tests to pass the explicit matching recovery kind.
- Remove raw-code checks from Main Card and Answer recovery predicates.
- Keep uncertain effects blocked even if metadata contains a recovery kind.
- Verify stale claim settlement cannot create a replacement or mutate a newer
  attempt.

## Task 6: Diagnostics and documentation

- Include only the finite operation and target enums in delivery failure logs.
- Ensure safe-error normalization uses the wrapped cause and never emits payload,
  SDK configuration, or raw response data.
- Update `docs/architecture.md` and the stability roadmap to describe the new
  single policy boundary and mark this stage-E slice complete.

## Task 7: Verification and implementation commit

- Run focused classifier, dispatcher, adapter, and SQLite tests after each
  vertical slice.
- Run `npm run typecheck`, `npm run build`, `npm run architecture:check`,
  `npm test`, and `git diff --check`.
- Review the final diff for only this semantic-policy slice.
- Commit the implementation independently.
- Do not push, install, restart, deploy, or send real Lark messages.
