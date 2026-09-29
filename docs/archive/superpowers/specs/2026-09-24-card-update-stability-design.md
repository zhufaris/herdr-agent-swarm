# Card Update Stability Design

## Goal

Make Primary Answer/Main Cards and Worker Task/Main Cards converge through the
same durable update semantics while making continuation pages discoverable. A
reader who remains on a frozen page must understand that output continued, and
the corresponding Main Card must open the current page rather than the original
page.

## Invariants

- SQLite remains the authority for projections, page identity, sequence, and
  delivery intent.
- Every external card effect is reserved through the durable outbox before it is
  sent.
- A frozen page is immutable. Creating a continuation never patches it later.
- Delivery retries never repeat a TraeX prompt or Worker turn.
- Card navigation is fenced by aggregate generation and exact message identity.
- Primary and Worker projections remain separate domain models; transport and
  pagination mechanics may be shared.

## Chosen design

Introduce a small domain policy for continuation handoff. It owns the page
number language used by finish summaries, frozen-page notices, and Main Card
navigation labels. Primary and Worker pagination call this policy instead of
constructing their own strings. This is the shared interface; each workflow
keeps its existing transactional reservation implementation.

`CardTargetRef` remains the durable navigation interface. Primary Main derives a
target from the active `RunCardView`; Worker Main derives one from the current
`WorkerTurnCardView`. Both references use the current page's message ID already
checkpointed in SQLite. No Lark state is queried and no new database authority is
introduced.

Main Card renderers show a consistent action when a current page exists:

- Primary Main: `打开当前回复`
- Worker Main: `打开当前 Task`

The target changes only after the continuation card identity has been
checkpointed. Until then the Main Card retains the previous valid target. This
prevents navigation to an uncreated card. Frozen page content retains the
existing render-only continuation notice and the stream finish summary uses the
same policy text.

## Stability and failure handling

Sequence allocation, idempotency keys, lane ordering, stale-target checks, and
recovery remain inside the existing SQLite/outbox transactions. The change does
not create an in-memory delivery authority.

Convergence logs describe decisions rather than loop activity. Continuation
reservation records the aggregate kind, aggregate ID, old and new page indexes,
source offset, and outcome. Delivery failures continue to persist on outbox rows
and appear through existing status diagnostics. No prompt text or unredacted
answer content is logged.

## Verification

Tests must prove:

1. Primary and Worker continuation summaries use the same domain policy.
2. A frozen page announces the next page without changing canonical offsets.
3. Primary Main opens the latest checkpointed Answer page.
4. Worker Main opens the latest checkpointed Task page.
5. Missing or not-yet-checkpointed page identities do not render invalid actions.
6. Duplicate convergence preserves idempotency and monotonic sequence behavior.
7. Existing retry, dead-letter, stale-target, and restart recovery tests remain
   green.

Run focused card/domain/store tests, architecture checks, typecheck, build, and
the full test suite.
