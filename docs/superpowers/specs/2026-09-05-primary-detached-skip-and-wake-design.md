# Primary Detached Skip and Wake Design

## Goal

Make recovery from a stuck Primary prompt explicit and safe without weakening
exact-turn steering or the no-replay invariant. `/swarm awake` remains an
observation command. A new `/swarm skip` command resolves exactly one durable
detached blocker and then wakes the existing FIFO dispatcher.

This first version applies only to the Primary binding associated with the
current Lark topic. Worker skipping is out of scope.

## User-visible semantics

### `/swarm awake`

`/swarm awake` keeps its current meaning:

- inspect the oldest detached Primary prompt through the typed TraeX transcript;
- recover completed later turns when exact transcript identity permits it;
- never submit the prompt to TraeX again;
- never terminalize a prompt merely because the pane is idle;
- report `none`, `busy`, or `unavailable` without changing the prompt when safe
  recovery is impossible.

### `/swarm skip`

`/swarm skip` operates on the current topic's Primary binding. It selects only
the oldest prompt whose durable state is `running` and whose observation state
is `detached`. The command does not accept a prompt ID and never skips more than
one prompt per invocation.

On success it:

1. changes that prompt to `failed` with completed observation;
2. records a fixed reason stating that a human skipped the prompt and its prior
   execution result remains uncertain;
3. updates the existing Run Card through the normal durable projection path;
4. records the operator and source message in audit data;
5. wakes the binding scheduler so the next queued prompt may run.

The operation never sends terminal input, interrupts TraeX, replays the skipped
request, or changes a non-detached turn. If no detached blocker exists, it is a
safe no-op with a result card explaining that there is nothing to skip.

## Authorization and durable command handling

`skip` is a creator-authorized mutation scoped to the current active Primary
topic. It uses the existing durable `swarm_command_intents` path and the
binding's frozen generation, pane, and active-prompt context. Duplicate Lark
delivery therefore resolves to the same command intent and cannot skip a second
prompt.

The command gateway revalidates the frozen Primary context before executing the
mutation. Unlike `/swarm steer`, `skip` does not require a live exact runtime
turn: its target is the durable detached blocker. The store performs the final
generation and prompt-state compare-and-set in one SQLite transaction.

## Atomic store transition

Add a store operation conceptually shaped as:

```ts
skipOldestDetachedPrompt({
  bindingId,
  expectedBindingGeneration,
  actorOpenId,
  sourceMessageId,
  reason,
  occurredAt
})
```

Inside `BEGIN IMMEDIATE`, it:

- verifies the binding is still the expected active generation;
- selects the oldest `running` / `detached` ordinary prompt by creation order;
- updates only that row to `failed` / `completed` with the fixed uncertainty
  reason;
- transitions its Run Card to failed using the existing card reducer/projection
  contract rather than directly delivering to Lark;
- inserts an audit record identifying the human actor and Lark source message;
- commits and returns the skipped prompt ID, or commits a no-op result.

The compare-and-set predicates prevent an `awake` recovery or transcript
completion racing with `skip` from being overwritten. A concurrent winner makes
`skip` return `none`; it does not search for and skip the next prompt in the same
invocation.

## Scheduling and concurrency

The command executes in the existing per-binding command-intent lane. After a
successful store transition, the gateway wakes the prompt scheduler for that
binding and wakes outbound delivery. The scheduler remains the only component
that claims queued prompts. Existing claim rules continue to prevent a queued
turn from starting while another durable active turn remains.

`awake` and `skip` are serialized by the same binding lane at the command level,
and the SQLite compare-and-set is the final authority if transcript observation
races independently. No in-memory flag is treated as durable ownership.

## Steering boundary

`/swarm steer <text>` remains strict exact-turn control:

- it requires the exact active runtime turn, pane, native session, and binding
  generation;
- unsupported native steering fails immediately as `unsupported`;
- a proven native `not-active` response may use the existing freshly observed
  idle-to-priority conversion;
- `delivery-uncertain` never becomes queued work;
- it never invokes `skip` and never silently becomes an ordinary prompt.

The result card for unsupported steering should direct the operator to
`/swarm awake` to recover observable completion or `/swarm skip` to explicitly
release a detached blocker.

## Error handling and observability

The command returns a durable result card with one of these outcomes:

- `skipped`: includes the skipped prompt's short ID and states that its result
  remains uncertain;
- `none`: no detached blocker exists;
- `stale`: binding generation or target state changed before the transaction;
- `rejected`: the topic is not an active Primary binding or authorization fails.

Structured logs and audit data include `bindingId`, `promptId`, actor ID, source
message ID, and outcome, but never include prompt text. `/status` does not need a
new aggregate for the first version; the prompt moves from `running` to `failed`
and existing counters expose the effect.

## Test strategy

Focused tests must prove:

1. parsing and policy classify `/swarm skip` as a creator-authorized,
   reconcilable mutation with active-topic context;
2. the store skips only the oldest detached prompt and atomically updates its
   prompt state, observation state, Run Card, and audit record;
3. no detached prompt produces a no-op and a concurrent completion produces a
   stale/no-op result without skipping the next prompt;
4. command redelivery is idempotent and cannot skip two prompts;
5. successful skip wakes prompt and outbound schedulers, allowing the next FIFO
   prompt to be claimed;
6. attached, queued, delivered, failed, Worker, and other-topic turns are never
   modified;
7. `/swarm awake` still never terminalizes or resubmits an unrecoverable
   detached prompt;
8. strict `/swarm steer` unsupported and uncertain paths still do not enqueue
   ordinary or priority work.

Before handoff, run the focused command/parser, store, gateway, prompt scheduler,
and pane lifecycle tests, followed by `npm test`, `npm run typecheck`,
`npm run build`, and `git diff --check`. Installation or service restart is a
separate operator step and is not part of this implementation.

## Non-goals

- Worker `/skip <name>` support.
- Automatic timeout-based skipping.
- Treating pane `idle` as proof of turn completion.
- Replaying a detached or uncertain prompt.
- Changing the existing priority queue into an implicit steer fallback.
