# Prompt-ID-Only Stability Design

## Goal

Stabilize Primary Prompt identity without changing Herdr Core:

- `prompt_id` is the only Swarm business identity;
- the same value is passed unchanged as Core `submission_id`;
- Swarm never reconstructs ownership from receipt `turn_id`, Prompt text,
  timing, queue position, the latest turn, or the active turn;
- Swarm-submitted Prompts and Herdr-origin external work use the existing
  binding-scoped `prompt_jobs` queue and remain ordered;
- a bad Prompt is terminalized after bounded safe observation and does not
  permanently block later work;
- Answer effects are isolated by immutable page identity.

Core may expose a `turn_id` in events or receipts. Swarm may retain an exact
turn envelope received in the same canonical event as diagnostic/observation
metadata, but it never uses a later receipt to associate a Prompt with a turn.

## Scope boundary

This design intentionally leaves `/workspace/herdr-core`
unchanged. It reuses the currently advertised `agent prompt` queue submission,
submission receipt, and Agent Events contracts.

When the Agent is non-idle, Swarm continues sending accepted work through the
existing native `queuePrompt` path in durable FIFO order. The Agent's existing
terminal UI is the Herdr-visible queue surface. This design does not add a new
Core queue panel, badge, API, schema, or persistence format.

If a future requirement needs a dedicated Herdr-owned queue list independent of
the Agent terminal, that is a separate Core feature. It is not necessary to
remove Swarm's unstable receipt→turn correlation.

## Non-goals

- Do not change Herdr Core source or its persisted Agent Events journal.
- Do not add another Swarm execution queue.
- Do not infer Prompt ownership from any positional or content heuristic.
- Do not replay Prompt text after terminal input may have occurred.
- Do not treat raw terminal input as a managed queued Prompt.
- Do not let Feishu/CardKit delivery determine Prompt execution state.

## Observed failure

Swarm currently sends Prompt ID as Core submission ID, but detached recovery
then accepts a receipt's candidate turn as authoritative. Live evidence showed:

- requested submission: `5dffc751-9634-49d3-92a3-2f2b8dbfb804`;
- receipt candidate turn: `01a0f0ca-6dbc-7901-b6d2-7c00636887d5`;
- canonical Human Message submission ID on that turn:
  `8fde43dc-0b1b-4d1f-8def-c09907e96b04`.

The current `recoverDetachedPromptOwnership` would persist that wrong turn.
Once persisted, later output, completion, and control can affect the wrong
Prompt. The safe solution within Swarm is to remove receipt-driven turn claiming
entirely rather than add another reconciliation heuristic.

A separate delivery defect compares a delayed old Answer-page update with the
Run Card's mutable current-page message. That rejects a valid page-0 update
after page 1 becomes current.

## Considered approaches

### 1. Strengthen receipt→turn cross-checking

Not selected. It would prevent the demonstrated mismatch but retain a second
identity and recovery protocol that Swarm does not need for business routing.

### 2. Add a new durable queue and submission API to Core

Not selected for this change. It could provide a dedicated Herdr queue UI, but
it expands the release surface across repositories and is unnecessary while
the existing native prompt path already queues non-idle input in the Agent
terminal.

### 3. Prompt-ID-only Swarm lifecycle

Selected. Use Core only as an existing queue/event provider. Route managed
lifecycle by `submission_id`, treat turn metadata as event-local runtime detail,
and bound any Prompt for which submission-keyed evidence never arrives.

## Identity model

### Managed Prompt

For every Swarm-managed Prompt:

`prompt_id == native_submission_id == Core submission_id`

That immutable ID keys acceptance, native enqueue, receipt lookup, lifecycle
routing, recovery state, audit, Run projection, and Answer pages. Binding
generation, Pane ID, Agent kind, and native session ID remain mandatory fences,
not alternate identities.

### Canonical Core event

A canonical event may mutate a managed Prompt only when:

1. it carries `requestSubmissionId` equal to the Prompt ID;
2. its binding generation, Pane, Agent kind, and native session match;
3. the Prompt is still eligible for that lifecycle transition.

If that event also carries a turn ID and canonical start time, Swarm may store
them as an observation cursor for the same event stream. Their presence cannot
create ownership, repair another Prompt, or override submission ID.

### Receipt

A receipt is queried by `prompt_id` and may report `prepared`, `observed`,
`terminal`, `cancelled`, or `legacy_unavailable`. Swarm validates the returned
submission ID and session fences. Receipt turn fields are ignored.

A receipt can confirm queue acceptance or provide bounded recovery evidence. It
cannot append output, settle success, or claim a turn. Canonical submission-keyed
events remain the only output/lifecycle input.

### Herdr-origin work

A canonical Herdr event carrying a submission ID creates or updates an external
Prompt whose ID is that submission ID. It is stored in the same `prompt_jobs`
table and ordered workflow as bridge-origin Prompts.

An event without submission ID is unmanaged external activity. It may be shown
as an external run, but it cannot consume, complete, supersede, or inherit the
identity of a queued managed Prompt merely because text or position matches.

### Answer page

An Answer delivery target is identified by:

`(prompt_id, page_index, message_id, card_id, element_id)`.

The matching `answer_pages` row is authoritative. Run Card current-page fields
are a compatibility cache and cannot validate an effect for another page.

## One ordered queue

SQLite retains one binding-scoped ordered Prompt queue containing bridge and
Herdr origins. Core's existing native `queuePrompt` call is the only managed
terminal submission path.

The dispatcher:

1. claims bridge Prompts in durable queue order;
2. calls `queuePrompt` with `submissionId = prompt.id`, including while the
   Agent is working when Core advertises native queue support;
3. persists the returned receipt without waiting for the Prompt to finish;
4. continues offering later queued Prompts to the same native queue in order;
5. relies on canonical submission-keyed events to update each Prompt.

This keeps queued Prompts visible in the existing Herdr/TraeX terminal surface
while the Agent is non-idle. Swarm does not execute a second PTY path and does
not serialize the whole queue behind one observer.

External managed events are inserted into the same durable Prompt stream. A
fresh external event is reconciled before a non-native fallback dispatch claim;
native queued submissions are already ordered by the Core call sequence. Queue
position governs scheduling only and is never identity evidence.

## Detached and abnormal recovery

Detached recovery no longer calls `claimPromptTranscriptTurn` from a receipt.
Observer ownership is exclusive: `DetachedPromptObserver` handles only
bridge-origin Prompts, while `ExternalTurnObserver` handles Herdr-origin
Prompts. Both the durable scan and the workflow hint consumer enforce this
boundary so one exact recovered Core-event lane cannot be acknowledged by two
competing Prompt observers.

Before reopening an exact Herdr-origin turn, `ExternalTurnObserver` checks for
the narrow crash window where immutable Core events already contain one
projected terminal event but the fenced Prompt is still `running/detached`.
SQLite may then repair only the missing owner terminal transition under exact
Binding generation, Pane, session, turn, and canonical-start fences. The repair
does not change lane state or checkpoints, replay generic view projection,
reserve duplicate delivery, or submit Prompt text. Missing or ambiguous
evidence falls through to normal exact-turn recovery.

For each due Prompt it reloads the submission receipt and current runtime:

- exact canonical events with matching `requestSubmissionId` resume normal
  projection;
- a matching `prepared` receipt remains queued/running evidence;
- `observed` or `terminal` without any matching canonical event is
  identity-unverified rather than a turn locator;
- `legacy_unavailable`, a mismatched receipt ID/session, or persistent prepared
  state on a safely idle runtime is identity-unverified;
- transport failure and unavailable evidence remain retryable.

At most three qualifying read-only observations are stored with 30-second then
60-second backoff. An observation counts only when the exact binding/session is
freshly `idle` or `done`, there is no matching canonical event, and no active
managed or unmanaged execution could still be the submission.

`working`, `blocked`, unknown runtime, transport failure, or stale fences do not
consume attempts. Recovery never calls a Prompt submission method.

On the third qualifying observation, one SQLite transaction:

1. rechecks Prompt, binding, session, and recovery fences;
2. marks the Prompt `skipped/identity_unverified`;
3. updates Run/Topic projections;
4. reserves the page-scoped Answer notice;
5. records audit evidence and removes the recovery row;
6. wakes the next durable queue item.

The transition does not require a currently queued successor. Later canonical
evidence becomes a late result and never triggers replay.

The user-visible notice is:

> ⚠ 无法确认该请求的最终执行结果，已跳过；请求不会自动重放，后续队列继续处理。

## Answer page isolation

Every existing-Answer effect carries its `page_index`, `message_id`, `card_id`,
and `element_id`. Validation loads that exact `answer_pages` row and checks the
complete tuple plus Prompt and binding ownership.

Moving the active-page pointer does not invalidate a final delivery intent
already reserved for an older page. `frozen` prevents new projection mutation;
it does not retarget or cancel an immutable previously reserved revision.

Each page uses a page-scoped outbox lane. An old-page failure cannot block a
newer page, another Prompt, Prompt execution, or another binding. Missing or
ambiguous legacy identity is quarantined rather than guessed.

## Persistence and cleanup

- Keep `prompt_id` and `native_submission_id`; enforce equality for new bridge
  submissions.
- Stop writing Prompt→turn ownership from receipt recovery.
- Existing transcript turn columns remain readable for legacy audit and exact
  event-cursor observation, but no receipt path may populate them.
- Reuse the existing detached recovery table and backoff.
- Generalize qualifying recovery beyond `legacy_unavailable` and remove the
  queued-successor prerequisite.
- Keep bridge- and Herdr-origin entries in `prompt_jobs`; do not add a queue
  table.
- Remove receipt-only recovery helpers and tests after references are gone.
- Validate legacy Answer intents without page index only when exactly one page
  matches every available immutable target field.

## Failure behavior

| Condition | Result |
| --- | --- |
| Agent working and native queue supported | Submit once to existing Core queue and persist receipt |
| Receipt returns another submission/session | Reject as identity mismatch; never claim its turn |
| Receipt contains a candidate turn | Ignore turn fields |
| Matching canonical submission event arrives | Update only that Prompt |
| Canonical event has no submission ID | Treat as unmanaged external work |
| Runtime working, blocked, or unknown | Do not count recovery and do not unsafe-dispatch fallback PTY input |
| Definitively unverifiable on safe idle runtime | Count due observation; skip at three |
| Old Answer update arrives after continuation | Validate against that page |
| Answer target is missing or ambiguous | Quarantine only that page lane |

## Testing

- receipt turn mismatch never calls `claimPromptTranscriptTurn`;
- receipt turn fields are ignored even when complete;
- repeated identical Prompt text has no effect on routing;
- matching `requestSubmissionId` updates exactly one Prompt;
- missing or mismatched submission ID mutates no managed Prompt;
- multiple bridge Prompts are offered to native `queuePrompt` in durable order
  while the Agent is working;
- Herdr-origin entries share `prompt_jobs` but never consume a bridge Prompt by
  text or position;
- prepared/observed/terminal-without-event and legacy-unavailable states become
  bounded only under fresh idle/done evidence;
- recovery never submits Prompt text and the next item wakes after skip;
- a delayed page-0 update succeeds after page 1 becomes current when its exact
  page tuple matches;
- a bad page target quarantines only that page lane;
- recovery counters, native receipts, and page targets survive restart.
- Herdr-origin detached Prompts are excluded from bridge detached-observer
  hints, including when a stale or manually delivered hint reaches the workflow.

Verification includes focused recovery, dispatcher, external-turn, SQLite,
Answer page, and outbox tests, followed by TypeScript typecheck, build,
architecture checks, and full Vitest. Core source, install, and service restart
remain untouched.

## Success criteria

1. Every bridge Prompt uses `prompt_id` unchanged as Core `submission_id`.
2. No receipt path can create or change Prompt→turn ownership.
3. Managed lifecycle/output routing requires the same canonical event's
   `requestSubmissionId` and runtime fences.
4. Bridge and Herdr-origin work share one durable ordered Prompt workflow, while
   raw external work cannot impersonate a managed Prompt.
5. Non-idle native queue submissions remain visible through the existing
   Herdr/TraeX terminal surface without Core changes.
6. One identity-unverified Prompt terminalizes after bounded safe observation
   without replay and the queue advances.
7. Answer effects validate immutable page-scoped identity and cannot block other
   page lanes.
8. Focused and full Swarm verification passes with no Herdr Core source diff
   introduced by this task.
