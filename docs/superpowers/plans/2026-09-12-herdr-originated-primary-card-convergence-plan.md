# Herdr-Originated Primary Card Convergence Implementation Plan

**Goal:** Make a direct TraeX turn in an already bound Primary Herdr pane update
its durable Answer Card and Primary Main Card promptly from Herdr hints.

**Architecture:** Extend `HerdrEventRouter` with a Primary external-turn observer
consumer ordered after binding reconciliation. Preserve EOF baselining for
Bridge dispatch, use a bounded active-turn cursor for direct Herdr turns, and
route all observed transcript lifecycle through the existing `BridgeEventBus`,
`ConversationViewProjector`, card workflows, and durable outbox.

## Test seams

- `HerdrEventRouter.handle` for ordering, scope, coalescing, and failure isolation.
- `ExternalTurnObserver` for baseline/no-history and exact adoption behavior.
- Existing discovery/card integration harness for visible Main and Answer
  delivery from one direct Herdr turn.

## Task 1: Define router ordering

- Add failing pane, workspace, and full-scope tests for
  `observePrimaryTurns`.
- Prove binding reconciliation completes before Primary observation starts.
- Prove Worker/runtime/cleanup consumers still run if the ordered Primary chain
  fails.

## Task 2: Wire Primary observation

- Add the narrow observer function to `HerdrEventRouterOptions`.
- Build one ordered Primary promise per routed hint; keep independent consumers
  in the existing all-settled group.
- Wire targeted `externalTurns.observeByPane` and full
  `externalTurns.scanActiveBindings` in production composition.
- Update test fixtures and architecture boundary assertions as needed.

## Task 3: Prove baseline and deduplication

- Keep normal Bridge dispatch at its EOF baseline. For external observation,
  boundedly replay only the latest active turn and assert completed transcript
  history creates no prompt or outbox work.
- Parse legacy `user_message`, current `history_mutation` user messages, and
  current `item_completed/UserMessage` records with message-ID deduplication.
- Reopen exact-owned detached turns from their persisted boundary after restart,
  restore the latest Main status, and append only a provable missing Answer
  suffix while retaining the durable RunCard answer as baseline.
- Bound exact-turn lookup to the final 64 MiB of large transcripts and discard
  only the partial record at the beginning of that scan window.
- Append a direct turn after baseline, deliver repeated pane hints, and assert one
  `executionOrigin='herdr'` prompt with exact transcript identity.
- Assert duplicate hints do not create duplicate prompts or card intents.

## Task 4: Prove Main and Answer convergence

- Build an integration test with real event bus, projector, temporary SQLite,
  fake transcript cursor, and fake Lark adapter.
- Observe start, Answer output, Main-only status, and completion from one direct
  Herdr turn.
- Assert the Answer Card contains current output and terminal state, and the
  Primary Main Card reflects the same turn phase/status through its own
  projection.
- Assert no TraeX prompt submission occurs.

## Task 5: Documentation, validation, and commit

- Mark the TODO complete and update architecture behavior.
- Run event-router, external-observer, discovery/card integration, startup, and
  shutdown tests.
- Run `npm run typecheck`, `npm run build`, `npm run architecture:check`,
  `npm test`, and `git diff --check`.
- Review and commit the implementation independently with the TRAE CLI co-author
  trailer.
- Do not push, install, restart, deploy, or send real Lark messages.
