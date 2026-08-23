# Request-scoped live Lark card implementation plan

## Objective

Implement the approved request-scoped live-card design in
`docs/archive/designs/2026-08-22-request-live-card-design.md`. Every accepted
ordinary prompt gets one CardKit message that is updated in place from queued
through completion or failure. The card streams filtered answer content and a
separate simplified progress trail, with ordinary patches coalesced to at most
one every 800 milliseconds.

The work starts from the current event-first/outbox changes already present in
the worktree. Preserve those changes and evolve them; do not revert them or
reintroduce direct worker-to-Lark calls.

## Implementation constraints

- Keep one Node.js process and SQLite; do not add a broker or event store.
- Keep FIFO execution per binding.
- Do not start a prompt until its initial run card has a confirmed Lark message
  ID.
- Do not send acknowledgement or final-answer text messages for ordinary
  prompts.
- Keep `/herdr help` and `/herdr status` as standalone command-card behavior.
- Keep approval terminal-only and do not add card actions.
- Store only filtered answer content and normalized progress events in the
  run-card snapshot.
- Use fake timers for the 800 ms scheduler tests; tests must not sleep.

## Task 1: Define the request-level card domain

**Files**

- Add `src/domain/run-card-view.ts`.
- Modify `src/domain/types.ts`.
- Modify `src/domain/events.ts`.
- Modify `src/domain/ports.ts`.
- Add `tests/run-card-view.test.ts`.

**Test first**

Add reducer tests that establish these transitions and invariants:

1. `PromptQueued` creates a `queued` view keyed by `promptId`.
2. `TurnStarted` records `startedAt` and produces `running`.
3. output observations append answer deltas and deduplicate progress events by
   stable key.
4. `blocked`, `completed`, and `failed` retain prior safe content.
5. completion replaces partial answer content with the authoritative final
   answer.
6. `viewVersion` changes only when visible state changes.
7. queue-position changes affect only the addressed prompt view.

**Implementation**

Define:

- `RunCardPhase = queued | running | blocked | completed | failed`;
- `ProgressEventKind` as a bounded display vocabulary;
- `RunProgressEvent` with `key`, `kind`, `label`, `state`, and `occurredAt`; and
- `RunCardView` with prompt/binding identity, Lark message ID, metadata, answer,
  progress, timestamps, queue position, `viewVersion`, and
  `deliveredVersion`.

Make prompt lifecycle events request-addressable. In particular, include
`promptId` on agent-state events emitted during a worker turn and add a
`TurnOutputObserved` event carrying only parsed safe output. Binding-level state
events remain separate and must not accidentally update every run card.

Extend `BindingStorePort` with request-card operations instead of exposing SQL
details to the projector. Keep topic-view methods temporarily for binding and
command compatibility until Task 7 removes obsolete prompt-state usage.

**Verify**

```bash
npx vitest run tests/run-card-view.test.ts
npm run typecheck
```

## Task 2: Add durable request-card persistence and transactional acceptance

**Files**

- Modify `src/store/sqlite-store.ts`.
- Modify `src/domain/ports.ts`.
- Modify `tests/sqlite-store.test.ts`.

**Test first**

Cover:

1. one transaction creates a prompt job, initial run-card snapshot, and
   card-create outbox item;
2. duplicate `lark_message_id` returns the original prompt/card and creates no
   second outbox row;
3. a card-create delivery stores the returned Lark message ID on the matching
   run card;
4. a prompt without a card message ID cannot be claimed;
5. FIFO claiming resumes once the first queued prompt's card is ready and never
   bypasses an earlier unready prompt;
6. saving a visible change increments `view_version`, while an identical view
   does not;
7. pending card-update work coalesces to the newest view version;
8. restart recovery returns queued prompts unchanged and marks running prompts
   and their run cards failed without replay; and
9. existing databases migrate idempotently.

**Implementation**

Add a `run_cards` table matching the approved snapshot and extend the outbox
with nullable `prompt_id` and `view_version` metadata. Use an idempotent schema
migration that preserves current bindings, prompts, topic views, and outbox
rows. Do not rebuild user tables unless column constraints require it; if a
rebuild is required, wrap it in one transaction and copy every existing row.

Add one store method for ordinary-prompt acceptance that takes the prompt,
initial `RunCardView`, and rendered create payload and commits all three records
atomically. Use a stable create key such as `run-card:create:<promptId>`.

Change prompt claiming so the oldest queued prompt is eligible only when its
run card has a known Lark message ID. A missing card on the head prompt blocks
that binding's FIFO rather than allowing later prompts to overtake it.

When a card-create outbox item is delivered, update both the outbox row and the
matching `run_cards.lark_message_id` in one transaction. For updates, persist the
latest desired full-card payload/version and supersede an older pending update
for the same prompt.

**Verify**

```bash
npx vitest run tests/sqlite-store.test.ts
npm run typecheck
```

## Task 3: Parse live TraeX output into safe answer and progress events

**Files**

- Add `src/runtime/traex-output-parser.ts`.
- Modify `src/runtime/output.ts`.
- Add `tests/traex-output-parser.test.ts`.
- Modify `tests/output.test.ts`.

**Test first**

Create representative terminal fixtures and assert that the parser:

1. extracts incremental user-facing answer text after the TraeX answer marker;
2. recognizes a small set of file-read, search, edit, and test activities;
3. emits stable keys so repeated terminal polls do not duplicate progress;
4. converts absolute paths under the workspace root to relative paths;
5. strips ANSI and cursor-control sequences;
6. rejects thinking/reasoning blocks, raw tool JSON, raw commands, and unknown
   terminal lines;
7. redacts credential-shaped values, authorization headers, private keys, and
   sensitive URL query parameters; and
8. returns no display content when safety is uncertain.

**Implementation**

Keep terminal cleanup separate from semantic parsing. Implement an allowlist
parser that returns `{ answerDelta, progressEvents }`; do not try to summarize
arbitrary terminal text. Progress labels come from code-owned templates and may
include only sanitized repository-relative paths or safe counts.

The answer parser must track the previously accepted answer so overlapping
terminal snapshots append only new content. The final-answer extraction uses the
same safety filter and becomes authoritative on completion. Logs may record only
parse category and input/output lengths.

**Verify**

```bash
npx vitest run tests/output.test.ts tests/traex-output-parser.test.ts
npm run typecheck
```

## Task 4: Expose live Herdr observations during a turn

**Files**

- Modify `src/domain/ports.ts`.
- Modify `src/adapters/herdr-adapter.ts`.
- Modify `tests/herdr-adapter.test.ts`.

**Test first**

Assert that `runPrompt` reports output snapshots while TraeX remains working,
reports state transitions without duplicate callbacks, continues polling while
blocked, and reports the final snapshot before returning `done`. Verify that a
consumer callback failure aborts the turn visibly instead of being silently
ignored.

**Implementation**

Replace the state-only callback with an observation callback containing the
current agent state and terminal output snapshot. Reuse the adapter's existing
250 ms turn polling; do not add a second independent polling loop. Invoke the
callback only when state or output changes. The coordinator will compute and
parse deltas, so the Herdr adapter remains transport-focused.

**Verify**

```bash
npx vitest run tests/herdr-adapter.test.ts
npm run typecheck
```

## Task 5: Render request cards and enforce deterministic size limits

**Files**

- Modify `src/cards/run-card.ts`.
- Add `src/cards/binding-card.ts` if Herdr-originated topic creation still needs
  a non-request root card.
- Modify `tests/run-card.test.ts`.

**Test first**

Cover all phases and assert:

1. metadata, progress, and answer occupy distinct regions;
2. running cards enable streaming presentation;
3. blocked cards contain terminal-approval guidance and no approval action;
4. completed cards are green and keep the progress region expanded;
5. failed cards retain safe partial content and show an actionable error;
6. rendering never includes raw hidden fields or rejected output; and
7. oversized cards remove oldest progress first, report the omitted count, and
   truncate the answer only as the final fallback with an explicit marker.

**Implementation**

Change `renderRunCard` to accept `RunCardView`. Keep the CardKit document
complete on every render, with `update_multi: true`. Use a conservative,
testable serialized-size budget below Lark's hard limit. Extract the existing
binding/provisioning card if needed so topic creation does not fabricate a
prompt-level view.

**Verify**

```bash
npx vitest run tests/run-card.test.ts
npm run typecheck
```

## Task 6: Add per-card scheduling and version-aware outbox delivery

**Files**

- Add `src/events/card-update-scheduler.ts`.
- Modify `src/events/lark-channel-publisher.ts`.
- Modify `src/events/card-projector.ts`.
- Modify `src/main.ts`.
- Add `tests/card-update-scheduler.test.ts`.
- Rewrite request-card assertions in `tests/event-card-integration.test.ts`.
- Modify `tests/lark-channel-publisher.test.ts`.

**Test first**

Use Vitest fake timers to prove:

1. the first card is created once with a stable prompt-scoped key;
2. ordinary view changes within 800 ms produce one patch containing the latest
   view;
3. completed, failed, and blocked views flush immediately;
4. only one patch per card is in flight;
5. a view produced during an in-flight patch is sent afterward;
6. an older completion cannot reduce `deliveredVersion` or overwrite a newer
   desired version;
7. a temporary failure leaves only the latest desired view pending;
8. one failed card does not block another card; and
9. ordinary prompt events produce no `replyText` calls.

**Implementation**

Make `CardProjector` request-scoped: load the view by `promptId`, reduce the
event, save it, render it, and notify the scheduler. The projector must not call
Lark or manipulate timers.

The scheduler owns one timer/in-flight slot per prompt and a bounded global
dispatch pool. Ordinary updates wait until the prompt's 800 ms window permits a
patch. Critical phases cancel the pending timer and enqueue immediately. Timer
cleanup must be explicit during shutdown.

Change `LarkChannelPublisher` into a transport/outbox dispatcher. Remove the
`PromptQueued`, `TurnCompleted`, and `TurnFailed` text mapping. Card-create
delivery assigns its returned message ID to the run card; card updates target
that ID and advance `deliveredVersion` only after success. Keep standalone help
and status cards on the durable path.

**Verify**

```bash
npx vitest run tests/card-update-scheduler.test.ts tests/lark-channel-publisher.test.ts tests/event-card-integration.test.ts
npm run typecheck
```

## Task 7: Wire prompt execution, queue positions, and recovery

**Files**

- Modify `src/coordinator/sync-coordinator.ts`.
- Modify `src/events/bridge-event-bus.ts` if the new safe-output event requires
  subscription typing changes.
- Modify `src/main.ts`.
- Modify `tests/herdr-discovery-integration.test.ts`.
- Modify `tests/lark-adapter.test.ts` only if fake-port expectations change.
- Add `tests/request-live-card-integration.test.ts`.

**Test first**

Add integration coverage for:

1. inbound acceptance persists the prompt/card/create-outbox atomically;
2. the worker waits for card-create delivery;
3. two FIFO prompts create two cards and expose queue positions 1 and 2;
4. claiming/completing the first prompt recalculates the second card's position;
5. live Herdr observations produce parsed output events during execution;
6. the final output produces the authoritative completed view;
7. blocked state updates only the active prompt and stops later prompts from
   running until approval clears;
8. pane loss fails the active card and blocks queued cards with binding guidance;
9. restart marks an interrupted run failed on its existing card and runs an
   unstarted queued prompt only after its card exists; and
10. duplicate inbound delivery creates no duplicate card.

**Implementation**

Update ordinary-message enqueueing to build the initial `RunCardView`, render it,
and call the transactional store operation. Schedule work only after the
publisher confirms card creation; startup and reconciliation also schedule
eligible bindings after draining creates.

During `runPrompt`, compare observations with the previous snapshot, pass deltas
through the safe TraeX parser, and publish `TurnOutputObserved` only for visible
changes. Include the active `promptId` in agent-state events. On return, parse the
final snapshot and publish `TurnCompleted` with the authoritative filtered
answer. Do not fall back to arbitrary cleaned terminal output. If no safe answer
is available, use a fixed explanatory message.

After enqueue, claim, completion, failure, or recovery, recalculate queued
positions and project changes for affected prompt IDs. Remove topic-card updates
from prompt lifecycle paths. Preserve binding-only cards for provisioning, help,
status, rename, archive, and Herdr-originated topic creation as applicable.

On startup, recover interrupted runs before scheduling workers, project their
failed views, drain card creates/updates, then schedule only eligible queued
work. On pane loss, fail the active prompt and block queued card views without
reassigning them.

**Verify**

```bash
npx vitest run tests/request-live-card-integration.test.ts tests/herdr-discovery-integration.test.ts tests/lark-adapter.test.ts
npm run typecheck
```

## Task 8: Remove obsolete topic-run behavior and update operations docs

**Files**

- Modify or remove `src/domain/topic-view.ts` according to remaining binding-card
  use.
- Modify `src/cards/run-card.ts` imports and obsolete topic-card call sites.
- Modify `README.md`.
- Modify affected tests.

**Implementation**

Delete the topic-scoped prompt answer/phase projection once no caller relies on
it. Do not remove binding metadata or command-card behavior. Update the README
architecture and behavior description to say that every ordinary prompt has one
live card, that updates are filtered/coalesced, and that completion sends no
extra text reply. Document the terminal-only approval boundary and restart
failure behavior.

Search for stale behavior and remove or update every match:

```bash
rg -n 'statusMessageId|TopicView|replyText|已接收，处理中|TurnCompleted.*text|topic-scoped' src tests README.md
```

`replyText` may remain in the adapter interface only if a non-prompt feature
still needs it; otherwise remove it from `LarkPort`, `LarkSdkAdapter`, and all
fakes. `statusMessageId` may remain for legacy schema compatibility but must not
drive new prompt cards.

## Task 9: Full verification and live readiness check

Run fresh verification after the final code change:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Then start or restart the configured bridge through the repository's existing
operational path and verify:

```text
GET /health returns success
GET /ready confirms SQLite, Herdr workspace, and Lark WebSocket readiness
```

Perform one live Lark smoke test in the configured chat:

1. send two prompts into the same bound topic;
2. confirm two distinct cards appear and no acknowledgement text appears;
3. observe the first card update during execution no faster than the configured
   coalescing interval;
4. confirm the card shows filtered answer content plus expanded simplified
   progress;
5. confirm completion updates the same card and sends no final text reply; and
6. confirm the second card advances from queue position 2 to execution.

Inspect structured logs for prompt IDs, phases, and versions and confirm they do
not contain the prompt body, answer body, raw terminal output, tokens, or tool
arguments. Record the exact test totals and readiness response in the handoff.

## Suggested commit sequence

Keep the implementation in independently verifiable commits while preserving
the current uncommitted event-first work:

1. `feat: add request card domain and persistence`
2. `feat: parse safe live traex output`
3. `feat: schedule versioned lark card updates`
4. `feat: wire request-scoped live cards`
5. `docs: document request-scoped live cards`

Before each commit, stage only the files for that task and inspect
`git diff --cached --stat` plus `git diff --cached`. Do not absorb unrelated
worktree files such as the runtime database under `var/`.
