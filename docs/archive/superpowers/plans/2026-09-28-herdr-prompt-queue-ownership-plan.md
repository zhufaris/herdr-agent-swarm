# Herdr Prompt Queue Ownership Implementation Plan

## Objective

Submit ordinary Feishu prompts to Herdr's native input queue without waiting
for the active turn to finish, and make every native human message establish
the correct Swarm Answer ownership. Preserve exact runtime fences and the
no-replay rule across command failures, restarts, and source replacement.

Each work package is a vertical red-green slice. Core changes land in
`/workspace/herdr-core`; Swarm changes land in this repository.

## Confirmed public seams

- Herdr `agent.prompt` request/response schema and terminal submission result.
- Herdr canonical `agent.events` payload stream and source journal.
- Swarm `HerdrAdapter` normalized prompt-submission contract.
- Swarm `HerdrEventsReader` normalized observation contract.
- `PrimaryPromptDispatcher` ordinary FIFO dispatch behavior.
- `ExternalTurnObserver` prompt/turn ownership and Answer projection.

Tests exercise these seams rather than private helpers.

## Protected behavior

- Ordinary messages remain FIFO next-turn work; only `/swarm steer` targets an
  active turn.
- Blocked agents never receive ordinary queued input.
- A submission that may have reached the PTY is detached/uncertain and is never
  automatically replayed.
- Binding generation, pane, terminal, agent kind, native session, prompt,
  model revision, and operation fences remain authoritative.
- No standalone Human Message card or duplicate human prose is rendered.
- Older Core versions retain the conservative wait-until-idle path.

## Work package 1: Core native human-message event

### Red

Add focused codec/schema tests proving:

- a TraeX `role=user` message emits one bounded `human_message` payload;
- a Pi user message emits the same canonical payload;
- text extraction, truncation, message identity, and turn association are
  deterministic;
- assistant/reasoning filtering is unchanged; and
- duplicate source records do not create duplicate journal events.

### Green

- Add `ReplyPayload::HumanMessage` with message ID, bounded text, truncation,
  and optional submission ID.
- Decode TraeX and Pi native user messages through the canonical event codec.
- Preserve source cursor ordering and journal serialization compatibility.

### Focused gate

- `just test-one agent_events`

## Work package 2: Swarm adopts native human messages

### Red

Extend reader and external-turn tests proving:

- `human_message` becomes `requestText` and stable native message identity;
- an unmatched native message creates exactly one Herdr-originated prompt and
  Answer owner;
- duplicate delivery is idempotent;
- matching assistant/tool/lifecycle events append to that Answer; and
- the human text is used for context but not duplicated as an Answer block or
  standalone Human Message card.

### Green

- Extend the Herdr event schema and normalized observation type.
- Feed native human messages into `ExternalTurnObserver` ownership adoption.
- Reuse the existing transactional adoption/outbox path.

### Focused gate

- `npx vitest run tests/herdr-events-reader.test.ts tests/external-turn-observer.test.ts tests/event-card-integration.test.ts`
- `npm run typecheck`

## Work package 3: Core submission receipt and correlation

### Red

Add schema, agent API, source, and journal tests proving:

- `agent.prompt` accepts an optional bounded `submission_id` plus exact native
  session precondition;
- working agents accept queued input and blocked agents reject it;
- the response echoes the ID only after the terminal actor accepts the full
  submission;
- duplicate submission IDs are idempotent and never enqueue twice;
- accepted receipts survive restart and are never replayed;
- the oldest matching exact-runtime receipt binds to the next matching native
  human message; and
- process/session replacement makes unmatched receipts uncertain rather than
  binding them to a replacement runtime.

### Green

- Extend `AgentPromptParams` and the success response additively.
- Store bounded pending-submission metadata without duplicating prompt text.
- Correlate by exact source identity, FIFO sequence, and normalized text digest.
- Consume the receipt transactionally when emitting `human_message`.

### Focused gate

- `just test-one agent_prompt`
- `just test-one agent_events`
- `just test-one api_schema`

## Work package 4: Swarm immediate ordinary dispatch

### Red

Add adapter, dispatcher, store, and integration tests proving:

- a working agent receives the next ordinary prompt immediately with
  `submission_id = promptId`;
- FIFO claims prevent later prompts overtaking earlier prompts;
- blocked or unknown runtime identity leaves work queued;
- unsupported Core capability preserves wait-until-idle behavior;
- pre-acceptance failure releases the claim;
- possible/confirmed acceptance records detached non-replayable work; and
- a matching `human_message.submission_id` binds the existing prompt to the
  native turn instead of creating a second Answer.

### Green

- Add typed submission capability/evidence to the Herdr adapter port.
- Feature-detect the additive Core contract.
- Replace the dispatcher working-state gate with exact-session early
  submission when supported.
- Persist accepted-but-unbound state and bind it atomically on the canonical
  human-message event.

### Focused gate

- `npx vitest run tests/herdr-adapter.test.ts tests/concurrency-controls.integration.test.ts tests/steering-integration.test.ts tests/external-turn-observer.test.ts tests/sqlite-store.test.ts`
- `npm run typecheck`

## Work package 5: Runtime-model contract integration

Complete the already approved runtime-model plan against the same Core event
and snapshot boundary. Model evidence stays attached to the Swarm prompt while
the early submission is accepted-but-unbound, then follows the native turn ID
after `human_message` correlation.

### Focused gate

- Core gates from `2026-09-28-herdr-runtime-model-observation-plan.md`.
- Swarm model, adapter, reader, reconciler, store, and card tests from that
  plan.

## Work package 6: Cross-repository verification and rollout

### Verification

- Run Core focused tests, then its repository-required full gates.
- Run all affected Swarm tests, `npm run typecheck`, `npm run build`, and
  `npm test` because the change spans workflow, persistence, and runtime
  boundaries.
- Run `git diff --check` and inspect both repository diffs without staging
  unrelated user changes.

### Rollout

- Build and install Core with the repository-supported live handoff; do not
  stop or kill the active Herdr server.
- Run `./install.sh` in Swarm, then force the supported service restart.
- Verify build identity, MainPID replacement, `/ready`, Core feature
  detection, and structured logs.
- Exercise one working-state ordinary prompt and one Herdr-local prompt to
  confirm queue latency and Answer ownership end to end.
