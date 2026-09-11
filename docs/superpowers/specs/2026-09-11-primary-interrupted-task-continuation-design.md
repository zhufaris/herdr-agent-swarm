# Primary Interrupted-Task Continuation Design

## Goal

Let a user explicitly continue a Primary task that TraeX records as interrupted
by a human operator, from its terminal Feishu Answer Card. Continuation creates
a new, linked FIFO prompt and a new Answer Card; it never changes or replays the
interrupted prompt.

## Scope

- Show a `继续这个任务` action only on a Primary Answer Card whose terminal
  notice is exactly `TraeX turn was interrupted by a human operator`.
- Open a CardKit form requiring a non-empty continuation instruction.
- Authorize submission through the current Primary binding, card ownership, and
  binding generation; only the topic creator can submit it.
- Atomically accept a new normal FIFO prompt, retain the interrupted prompt as
  its parent, create its run-card and Answer-card intent, and wake the normal
  prompt worker.
- Render the new card with a bounded `承接自中断任务` relationship marker.

## Non-goals

- Retrying, mutating, or reopening the interrupted prompt.
- Automatically including the original prompt text or partial output in the new
  prompt. The operator supplies the continuation boundary explicitly.
- Offering continuation for generic failures, completed prompts, detached
  prompts, queued prompts, or Worker Task Cards. Worker continuation remains
  its existing separate feature.

## Design

### Eligibility and ownership

The run-card renderer derives eligibility from its terminal phase and exact
human-interruption notice. The card action carries the parent prompt ID,
binding ID, expected binding generation, source card message ID, a new
interaction ID, and the requesting operator ID.

The submit path reloads SQLite state rather than trusting card text. It requires
all of the following: the binding is active and attached, its generation equals
the action generation, the source Answer Card belongs to the parent prompt, the
parent is terminally failed with the exact human-interruption notice, and the
operator is the binding creator. A stale, reset, retargeted, or non-eligible
card fails closed.

### Durable continuation transition

Add a nullable `parent_prompt_id` to `prompt_jobs`, referring to `prompt_jobs`.
The existing `RunCardView.conversionParentPromptId` becomes the presentation
projection of that field for Primary continuations. The store provides one
transactional acceptance operation that:

1. validates the parent prompt and binding-generation fence;
2. de-duplicates on the form interaction's idempotency key;
3. inserts the new queued prompt with `parent_prompt_id`;
4. computes queue position, creates the queued Run Card, and reserves its
   Answer Card/outbox intent;
5. records an audit fact without copying continuation text into audit data.

The command action only invokes this transition and then wakes the normal
binding-owned FIFO worker and outbox delivery. No terminal input is sent as part
of the form callback.

### Presentation

The interrupted Answer Card remains terminal and includes its normal error and
any safely captured partial answer. It gains one `继续这个任务` button. The
form tells the user to state both the point to resume from and what must not be
repeated.

The child prompt's Run Card and Answer Card identify it as a continuation of an
interrupted task. They show only the parent prompt ID's short safe identifier;
they do not duplicate the original request text or output.

### Failure behavior

| Condition | Result |
| --- | --- |
| Empty continuation text | Reject form; no durable mutation |
| Replayed callback | Return existing accepted child; no duplicate prompt |
| Wrong creator, stale card, reset generation, or different Answer Card | Reject; no durable mutation |
| Parent not exact human interruption | Reject; no durable mutation |
| Interrupted task's pane is unavailable | Normal prompt acceptance rules reject or retain queue state; no old prompt replay |

## Verification

- Renderer tests prove that only exact human-interruption Primary failures expose
  the action.
- Action tests prove form ownership, creator authorization, empty-text rejection,
  stale-card rejection, and idempotent submission.
- SQLite tests prove the parent relation, atomic queued-card/outbox creation,
  and no mutation of the old failed prompt.
- Integration tests prove FIFO submission of a new child prompt and a distinct
  Answer Card without submitting the parent text.
- Run focused tests, typecheck, build, and the full suite before installation
  and a safety-gated service restart.
