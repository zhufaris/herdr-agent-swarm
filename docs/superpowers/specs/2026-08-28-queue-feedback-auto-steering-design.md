# Queue Feedback and Conservative Auto-Steering Design

## Status

Approved conversational design, ready for implementation planning.

## Problem

An ordinary message sent to a busy binding is durably accepted but waits behind
the active turn and all earlier ordinary prompts. This preserves correctness,
but users can experience a long silent interval and may send more messages
because they cannot tell whether the bridge received the first one. Short
continuations such as `继续` also enter the ordinary FIFO even when the user
clearly intends to affect the active turn.

Recent production evidence from `task-esk0` showed both effects. One request
waited about 67 seconds before execution because earlier turns occupied the
binding, while Lark delivery itself generally completed in under two seconds.
The optimization must therefore improve queue visibility and safe routing, not
weaken the single-turn or no-replay guarantees.

## Goals

1. Show a durable queued Answer card immediately after prompt acceptance.
2. Keep its queue position, active-turn elapsed time, and bounded wait estimate
   current without creating an outbox backlog.
3. Automatically steer only high-confidence continuation messages into a
   recent, supervised active turn.
4. Preserve every accepted message across races, restarts, and delivery errors.
5. Preserve one ordinary turn at a time per binding and never replay text that
   may already have reached TraeX.

## Non-goals

- Parallel ordinary turns within one binding.
- Model-based intent classification.
- Exact completion-time promises or countdown timers.
- Automatic steering of slash commands, attachments, code blocks, long text,
  or ambiguous requests.
- Replaying an uncertain steering delivery as an ordinary prompt.
- Changing Primary/Worker instance routing in this increment.

## Approach

Use two independent, deterministic additions at the inbound and projection
boundaries:

1. A pure conservative classifier identifies a small set of continuation
   messages that are eligible for automatic steering.
2. Queue presentation derives bounded timing information from durable SQLite
   facts and projects it through the existing versioned outbox.

The classifier does not call a model and does not inspect rendered Lark cards.
SQLite remains authoritative for prompt order, active-parent identity, timing,
and delivery intent. Herdr remains authoritative for the live pane state.

## Inbound routing

For an ordinary message in an active binding, `InboundRouter` first applies a
pure classification function. A message is an automatic-steering candidate
only when all of the following hold:

- normalized text is at most 100 characters;
- it is either an exact continuation phrase or starts with an approved
  continuation prefix;
- it is not a slash command;
- it contains no fenced code block;
- the normalized event contains no unsupported rich-content nodes or
  attachments;
- SQLite identifies exactly one supervised active parent turn for the binding;
- the active turn has had durable output or state activity within the previous
  five minutes; and
- the authoritative runtime state is `working` or `blocked`, never `unknown`,
  `idle`, `done`, or detached.

The initial exact phrase set is:

- `继续`
- `继续处理`
- `按这个做`
- `可以`
- `确认`

The initial prefix set is:

- `补充：` and `补充:`
- `另外注意：` and `另外注意:`
- `再看下`
- `顺便检查`

Matching is performed after trimming surrounding whitespace. The sets are
deliberately narrow and code-owned; configuration and fuzzy matching are out of
scope until production evidence justifies them. Messages that do not meet every
condition follow the existing ordinary FIFO path unchanged.

## Durable acceptance and race handling

Inbound idempotency continues to use the original Lark event and message IDs.
Classification is advisory; the store owns the final routing decision.

The prompt-acceptance transaction must atomically:

1. confirm the inbound message has not already been accepted;
2. reload the active parent prompt and its binding generation;
3. validate that the parent is still supervised and recently active;
4. create either a steering prompt bound to that parent or an ordinary FIFO
   prompt;
5. create the initial Run Card projection and durable outbox intent; and
6. commit before publishing the workflow wake-up.

If the active parent is invalid before this transaction commits, the message is
safe to accept as an ordinary FIFO prompt because no external steering effect
has begun.

After a steering prompt has been committed, existing no-replay semantics apply.
If the active turn ends before delivery, the steering prompt fails with a clear
notice and offers a user action to enqueue the same text as a new ordinary
prompt. If steering delivery starts and returns an error or uncertain result,
the bridge must not enqueue or resend the text automatically. This prevents a
message that may have reached TraeX from executing twice.

The conversion action uses its own idempotency key and revalidates that the
failed steering prompt has not already been converted. It creates a new ordinary
prompt that records the steering prompt as its conversion source for audit and
user explanation; it does not mutate the failed prompt into a different
dispatch kind after an external effect may have occurred.

## User-visible steering state

An automatically routed continuation owns an Answer card like explicit
steering. Its card must say `已自动加入当前执行` and identify the parent task
without copying private prompt content. Audit records distinguish automatic
steering from explicit `/swarm steer` and card-triggered steering.

When automatic steering cannot be delivered because the parent ended first,
the card says `当前任务已结束，未自动注入` and exposes `作为新任务排队`. An
uncertain external delivery uses stronger wording that the bridge will not
retry automatically; it must not offer an action that could disguise the risk
of duplicate execution.

## Immediate queue feedback

Every accepted ordinary prompt continues to create its Answer card and outbox
intent in the acceptance transaction. The initial queued view displays at
least:

```text
排队中 · 前方 2 条
当前任务已运行 48 秒
预计等待约 1–3 分钟
```

The card is useful even when no estimate is available. `前方 N 条` is derived
from durable FIFO order and must not be inferred from previously rendered card
text. The active elapsed value comes from the current ordinary parent Run
Card's `started_at` and the current clock.

## Wait estimation

Wait estimates are deliberately coarse:

- use only the same binding's ten most recent normally completed ordinary
  turns;
- exclude steering, failed, cancelled, detached/recovered, and missing-timestamp
  samples;
- require at least three valid samples;
- use the median completed duration to resist outliers;
- estimate remaining active work as `max(0, median - activeElapsed)`;
- add one median duration for each earlier queued ordinary prompt;
- present a range from 0.5 to 1.5 times the estimate;
- round bounds outward to 30-second units and ensure the upper bound is greater
  than the lower bound; and
- label the result as an estimate, never a deadline or countdown.

If there is no active ordinary turn, the estimate is the median multiplied by
the number of prompts ahead. If fewer than three valid samples exist, the card
shows only queue position. Estimates are presentation data and never influence
dispatch order.

## Refresh and outbox behavior

Queued views refresh when:

- the prompt is accepted;
- a prompt ahead starts, completes, fails, or is cancelled;
- queue positions change; or
- the active elapsed time crosses a 30-second display bucket.

The periodic elapsed refresh is a bounded projection tick, not a workflow
wake-up and not a polling source of truth. It reloads SQLite state, updates only
views whose rendered queue information changed, and records normal versioned
outbox intent. Existing replaceable-card coalescing keeps only the newest pending
version for each queued Answer card. A failed card update retries delivery only
and never repeats prompt or steering execution.

The tick must not update completed, failed, or cancelled cards. It should stop
scheduling elapsed refreshes when no queued ordinary prompts exist.

## Data and interfaces

Prefer derived data over new mutable counters. Existing prompt and Run Card
timestamps provide queue order and duration samples. Add store queries with
narrow contracts for:

- atomically accepting a classified continuation against an expected active
  parent and binding generation;
- reading recent valid ordinary-turn durations for one binding;
- loading queued prompt views with the current active turn timing; and
- recording the optional conversion relationship from failed automatic
  steering to a newly accepted ordinary prompt.

If current schema cannot represent conversion provenance without overloading
`parent_prompt_id`, add an explicit nullable source column through an idempotent
SQLite migration. `parent_prompt_id` remains the execution parent only for
steering and must not acquire two meanings.

The classifier belongs in the domain or coordinator layer as a pure function.
Lark-specific payload normalization remains in the adapter; transaction and
queue facts remain in the store; visible wording remains in card reducers and
renderers.

## Observability

Add bounded structured events without logging message bodies:

- `auto-steering-classified`, with outcome `eligible` or a bounded rejection
  reason;
- `auto-steering-accepted`, with binding and parent prompt IDs;
- `auto-steering-fell-back-before-dispatch`, for the safe transactional FIFO
  path;
- `auto-steering-delivery-failed`, distinguishing rejected and uncertain; and
- `queue-estimate-projected`, with queue position, sample count, and rounded
  range.

Operational status should expose aggregate counts only. It must not expose
prompt bodies or actor identity.

## Testing

Focused tests must cover:

1. exact phrases and approved prefixes classify as candidates;
2. slash commands, long messages, code blocks, unsupported rich content, and
   ambiguous new tasks remain ordinary prompts;
3. active-state, five-minute freshness, binding-generation, and parent-prompt
   checks occur atomically with acceptance;
4. duplicate Lark events cannot create both steering and FIFO prompts;
5. a parent ending before commit safely produces one FIFO prompt;
6. a parent ending after committed steering produces a failed steering card and
   never auto-replays;
7. user-triggered conversion is idempotent and produces one ordinary prompt;
8. estimates use only eligible samples and the specified median/range rules;
9. insufficient samples suppress ETA while retaining queue position;
10. 30-second refresh buckets and queue transitions coalesce replaceable card
    updates;
11. restart convergence restores queued feedback without redispatching turns or
    steering; and
12. existing FIFO, steering, outbox, redaction, and recovery tests remain green.

Before deployment, run the focused coordinator/store/card tests, `npm run
typecheck`, `npm run build`, and the full `npm test` suite because the change
spans inbound routing, persistence, workflow scheduling, and presentation.

## Acceptance criteria

- A newly accepted ordinary message produces a queued Answer card without
  waiting for the active turn to finish.
- The queued card shows the exact durable queue position and, when enough valid
  history exists, a coarse wait range plus active elapsed time.
- High-confidence continuations such as `继续` automatically steer only a
  recent supervised active turn.
- Commands, new tasks, ambiguous messages, and unsafe payloads retain their
  existing semantics.
- Every race has exactly one durable disposition, and no uncertain steering is
  automatically replayed.
- Queue-card refreshes remain bounded and do not create a persistent outbox
  backlog.
- Restart recovery reconstructs presentation from SQLite without repeating any
  external Agent action.
