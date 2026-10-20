# Bounded Detached Prompt Recovery Design

## Goal

Prevent one identity-unverified detached Primary Prompt from blocking later ordinary
messages indefinitely while preserving the no-replay invariant. Swarm will make
at most three durable, read-only recovery observations before terminalizing an
eligible Prompt as skipped and waking the next item in the binding FIFO.

This changes only recovery and queue admission. It never resubmits Prompt text,
never treats a Core lookup failure as proof that a turn did not run, and never
lets CardKit delivery determine Prompt state.

## Current behavior

Detached recovery treats `prompt_id` as the only business identity and requires
the native `submission_id` to equal it. A receipt reports submission state but
never establishes Prompt-to-turn ownership; only a canonical event carrying the
matching `requestSubmissionId` may do that. The bounded fallback applies when a
fresh observation proves that the fenced Pane and native session are idle or
done but the Prompt still has no matching canonical event.

The fallback is safe but time-only. A single Prompt can therefore hold its
binding FIFO for the full timeout even after Core repeatedly reports that the
legacy submission cannot be associated with a turn.

## Considered approaches

### 1. Reuse `prompt_jobs.attempt_count`

Rejected. That field counts dispatch claims. Reusing it for recovery reads
would mix external side-effect attempts with observation attempts and make the
no-replay invariant harder to audit.

### 2. Keep only the age timeout

Rejected. This preserves current behavior but does not satisfy the requirement
that repeated conclusive observations release a blocked FIFO promptly.

### 3. Durable bounded recovery observations

Selected. Store recovery evidence in a dedicated table and expose one atomic
store operation that either records another qualifying observation or performs
the existing skip transition when the threshold is reached. This keeps
recovery bookkeeping behind the persistence seam and leaves the coordinator
responsible only for obtaining current Core and Herdr evidence.

## Eligibility and counting

The default threshold is three qualifying observations. An observation counts
only when all of these facts are true:

1. submission lookup is conclusively identity-unverified: a persistent
   `prepared`, `observed`/`terminal` without a canonical matching event,
   `legacy_unavailable`, cancelled, or mismatched receipt;
2. the Prompt is the oldest `running/detached` Primary Prompt for its binding;
3. both transcript turn identity fields remain null;
4. the binding generation, Pane ID, and native session still match;
5. a fresh Herdr observation reports that exact Pane/session as `idle` or
   `done`;
6. no active detached observer owns a proven exact turn.

Null receipts, Core transport failures, working/blocked/unknown runtime, and
stale fences do not increment the counter. A queued successor is not required:
one abnormal Prompt must become terminal even when no later message exists yet.

Qualifying observations are durably rate-limited. The first observation may be
recorded immediately. Later observations must be due according to persisted
exponential backoff (30 seconds, then 60 seconds, capped at 5 minutes). Repeated
wake hints inside the same interval therefore cannot consume the threshold.

`DETACHED_PROMPT_AUTO_SKIP_MS` remains the global enable and maximum-wait
fallback: `0` disables automatic skipping, while a positive value allows a
skip at either three due qualifying observations or the existing age limit.
The attempt threshold is an internal recovery policy constant rather than a new
operator setting; introducing a second knob would add configuration surface
without a demonstrated operational need.

## Persistence module

Add `detached_prompt_recovery_attempts` with one row per Prompt:

- `prompt_id` primary key and foreign key;
- binding generation, Pane ID, and native session fences;
- `attempt_count`;
- `first_attempt_at`, `last_attempt_at`, and `next_attempt_at`.

The Prompt recovery store exposes one deep operation for a qualifying
identity-unverified observation. Inside one SQLite transaction it:

1. rechecks every durable eligibility and ownership fence;
2. resets stale evidence when the generation, Pane, or session fence changed;
3. returns `deferred` without incrementing when `next_attempt_at` is in the
   future;
4. increments the durable count;
5. when the count reaches three, atomically marks the Prompt
   `failed/completed`, updates canonical Run and Topic projections, reserves
   the Answer outbox intent, records `swarm.auto_skip`, and removes the attempt
   row;
6. otherwise returns the count and next due time without changing Prompt
   state.

The operation returns a small discriminated result:

- `stale`: a fence or eligibility condition no longer holds;
- `deferred`: the next observation is not due;
- `observed`: a qualifying miss was persisted but the threshold is not met;
- `skipped`: the terminal transition committed.

The coordinator logs these outcomes, wakes outbound delivery only when an
outbox intent was reserved, and wakes `prompt-ready` only after `skipped`.

## Queue and publication behavior

The detached Prompt remains unresolved only while its
recovery result remains uncertain and the threshold has not been reached. On
the third qualifying observation, or the configured maximum-age fallback, its
terminal transition and card intent are committed before the scheduler checks
for the next durable queue item.

Card publication remains lane-isolated. Failure to deliver the skipped
Prompt's warning card does not revert its terminal state and does not block the
next Prompt, another binding, or an unrelated Answer page. Existing outbox
retry and quarantine rules remain unchanged.

The user-visible terminal reason covers both the attempt threshold and the
maximum-age fallback without claiming an inaccurate count:

> ⚠ 无法确认该请求的最终执行结果，已跳过；请求不会自动重放，后续队列继续处理。

## Recovery precedence

Every observation cycle retains this order:

1. observe an already known exact turn;
2. query the native submission receipt;
3. never claim turn ownership from any receipt field;
4. requeue only work proven not to have reached terminal input;
5. for a qualifying identity-unverified result, obtain fresh runtime evidence
   and record one bounded recovery observation;
6. skip only when the atomic store result reaches the threshold or the existing
   maximum-wait fallback applies.

If exact identity appears at any point, normal exact-turn recovery wins and the
bounded-skip path becomes ineligible.

## Testing

Focused tests must prove:

- the first and second due qualifying observations persist counts and keep the
  Prompt detached;
- the third due observation atomically skips it and wakes its FIFO successor;
- rapid duplicate wake hints do not consume multiple attempts;
- the counter survives store reopen and process restart;
- transient/null receipts and non-idle runtime never count; persistent prepared
  receipts count only with a freshly fenced idle/done runtime;
- exact turn identity appearing before the threshold prevents a skip;
- changed generation, Pane, or session fences reset or reject stale evidence;
- no successor is required for counting or skipping;
- outbox failure after the transition cannot restore Prompt blocking;
- the Prompt text is never submitted during any recovery observation.

Verification includes the focused recovery and migration tests, the full
SQLite suite, architecture-boundary tests, TypeScript typecheck, build, and the
full Vitest suite because this changes workflow and persistence behavior.
