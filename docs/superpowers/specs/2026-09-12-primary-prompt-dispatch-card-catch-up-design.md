# Primary Prompt Dispatch and Answer Card Catch-up Design

## Goal

Prevent a Primary topic FIFO from becoming permanently blocked when a direct
Herdr turn races with Bridge dispatch, and ensure an Answer Card catches up when
its durable queued view changes while the card is being created.

The motivating production case is `herdr-agent-swarm / lsny`: the `hi` prompt
was durably queued and its Answer Card was created, but an earlier prompt was
left in `running + not_started` without `dispatched_at` or a transcript turn
identity. The queued view advanced during card creation, but no later update was
reserved after the create settled.

## Invariants

- SQLite remains authoritative for the Prompt FIFO, Run Card projection, and
  outbound delivery intent.
- Herdr remains authoritative for the live pane, Agent state, native session,
  and active runtime turn.
- A prompt that may have reached TraeX is never automatically replayed.
- A prompt proven not to have reached TraeX may be returned to the FIFO.
- At most one ordinary Bridge prompt is active for a binding.
- Outbound intent is persisted before Lark delivery, and retries never repeat a
  TraeX prompt.
- Frozen Answer pages remain immutable; catch-up applies only to the current
  mutable page/card.

## Selected design

### 1. Pre-dispatch runtime fence

After claiming a queued prompt but before submitting its text, the prompt
workflow observes the exact bound Herdr pane. If the pane already has an active
turn that is not durably owned by the claimed prompt, the workflow must not send
the prompt. It atomically releases the unstarted claim back to `queued`, updates
the Run Card back to a queued projection, and invokes the existing external-turn
handoff path before retrying the FIFO.

The rollback is compare-and-swap fenced by prompt ID, binding ID, the claim's
`updated_at`, `state='running'`, `observation_state='not_started'`, and absence of
both `dispatched_at` and transcript identity. If any fence changed, the workflow
does not guess or replay.

This check narrows the race window but cannot eliminate a turn starting between
observation and submission. The dispatch receipt remains the decisive boundary
for that window.

### 2. Early durable dispatch receipt

The Herdr adapter must expose acceptance of `herdr agent prompt` separately from
waiting for the Agent to settle. A successful acceptance receipt immediately
invokes the existing dispatch checkpoint, persisting `dispatched_at` and moving
the observation state to `attached`. The long-running completion wait then
continues independently.

An explicit pre-dispatch rejection such as `agent_not_ready` or `agent_blocked`
does not write dispatch provenance and is eligible for safe requeue. A timeout,
transport loss, or ambiguous failure after acceptance is treated as possibly
dispatched and becomes detached rather than replayed.

If the installed Herdr CLI cannot provide a separate acceptance receipt, the
adapter keeps the current command but persists dispatch as soon as the spawned
command crosses the first authoritative evidence boundary: either a fresh
transcript turn start or a non-pre-dispatch command outcome. Merely spawning the
client process is not proof that TraeX accepted the prompt.

### 3. Running-claim safety recovery

The periodic safety scanner continues to recover only claims with no durable
dispatch evidence. A claim is eligible after the grace interval when it has
`running + not_started`, no dispatch timestamp, no transcript identity, and no
in-process owner. Recovery returns it to `queued` with a compare-and-swap update
and wakes that binding.

This mechanism is the crash and callback-failure backstop. It does not recover a
claim while the current process still owns its worker, and it never requeues a
prompt with any evidence that TraeX may have received it. Diagnostics must expose
recovered claims without logging prompt content.

### 4. Answer Card create catch-up

When a `stream_card_create` delivery succeeds, the delivery transaction writes
the returned message/card identifiers, advances `answer_delivered_version` to
the create intent's version, and records a durable `primary-turn` invalidation
when the latest Run Card is newer. The existing card-context rebuilder consumes
that invalidation and reserves one normal card update for the latest version.

The update uses the existing Answer lane and idempotency scheme. Repeated create
callbacks or dispatcher retries therefore cannot enqueue duplicates. If the
page was frozen, superseded, or replaced before create settlement, normal Answer
page recovery rules decide the target; the catch-up path does not mutate an old
page.

This closes the observed race:

1. queued Run Card version 1 reserves card creation;
2. queue feedback produces version 2 while creation is in flight;
3. version 2 cannot update because no message/card ID exists yet;
4. creation settles at version 1 and atomically records durable catch-up work;
5. the rebuilder reserves and delivers the version 2 update.

## Failure handling

- A failed pre-dispatch pane observation leaves the claim unstarted and lets the
  existing safe recovery path retry after the grace period.
- A changed binding generation or pane makes the release-to-queue operation a
  no-op; reconciliation owns the stale binding outcome.
- A prompt acceptance with uncertain outcome is detached and observed; it is not
  placed back in the FIFO.
- A failed catch-up delivery follows existing outbox retry, quarantine, and
  dead-letter policy. It does not alter prompt execution state.
- Existing historical `230031` and closed-stream failures are not bulk-replayed
  or rewritten by this change.

## Testing

Add focused tests at the real seams:

- Prompt workflow integration: a direct external turn is active when a queued
  prompt is claimed; assert no prompt text is sent, the claim returns to queued,
  and external-turn handoff runs before another claim.
- Adapter/executor: assert a successful acceptance checkpoint persists dispatch
  before the completion waiter settles; explicit pre-dispatch rejection remains
  undispatched; ambiguous post-acceptance failure detaches without replay.
- Safety scanner/store: assert an unowned stale `running + not_started` claim is
  requeued, while an in-process owned claim and any claim with dispatch evidence
  are untouched.
- Outbox delivery integration: mutate a queued Run Card after its create intent
  is reserved but before create delivery settles; assert one latest-version card
  update is reserved and duplicate settlement stays idempotent.
- Re-run the production read-only red-light query. The specific invalid state
  should disappear after normal recovery without editing SQLite directly, and
  the `hi` prompt should advance once preceding work completes.

## Scope

This change does not alter FIFO ordering, remotely interrupt an active TraeX
turn, add arbitrary terminal input, replay unresolved prompts, or bulk-recover
historical Lark dead letters. It is limited to prompt-dispatch fencing, safe
unstarted-claim recovery, and current Answer Card catch-up after creation.
