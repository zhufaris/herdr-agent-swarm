# Fenced Prompt Composer Sanitation and Submission Settlement

## Problem

Herdr Agent Swarm can durably accept a Lark prompt while the target TraeX pane
still contains unsubmitted composer text. The next `herdr agent prompt` may then
fail with `agent_prompt_stalled`: Herdr observes no lifecycle change, the TraeX
transcript contains no fresh turn, and the pane returns to or remains `idle`.

The bridge currently treats every post-dispatch stall as potentially delivered.
That is safe against replay, but an identityless detached prompt remains the
single active FIFO head indefinitely. Later Lark messages are durably queued but
cannot run. Rejecting arbitrary slash-prefixed text is not a solution: the bridge
owns only its explicit command namespaces, and other slash-prefixed text may be
a legitimate model prompt.

## Decision

Prompt dispatch will use one fenced submission boundary that owns composer
sanitation, prompt submission, and transcript settlement. Before submitting each
ordinary Primary or Worker prompt, the boundary clears the idle TraeX composer
with logical `ctrl+u`. If submission creates no transcript turn, the boundary
clears the composer again and returns a proven `not_started` result.

The operation returns one of three domain outcomes:

```ts
type PromptSubmissionOutcome =
  | { kind: "started"; turnId: string; startedAt: string }
  | { kind: "not_started"; composerCleared: true; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "uncertain"; reason: string };
```

`started` and `not_started` require positive evidence. Missing, conflicting, or
changed identity evidence before any terminal effect returns `rejected`; the same
evidence failure after an effect may have occurred returns `uncertain`. The prompt
text is submitted at most once.

## Ownership and scope

This behavior applies only while Agent Swarm is dispatching durable FIFO work to
a managed Primary or Worker pane. At that dispatch boundary, the TraeX composer
is bridge-owned staging state. Unsubmitted text typed manually into that composer
may be cleared. Operators who want manual work preserved must submit it as a turn
or use a pane not currently managed as an Agent Swarm dispatch target.

The operation never clears input while the agent is `working`, `blocked`, or
`unknown`. It does not interrupt an active turn, answer an approval, close a pane,
replace a session, reorder the durable FIFO, or replay a prompt.

Slash routing remains namespace-based:

- `/swarm ...` is owned by `SwarmCommandGateway`;
- `/steer ...` and `/stop ...` are owned Worker commands; and
- every other text, including unknown slash-prefixed text, remains an ordinary
  prompt.

Composer sanitation therefore fixes transport staging rather than attempting to
enumerate every possible slash command.

## Fences

The coordinator supplies an immutable expected target:

```ts
interface PromptSubmissionTarget {
  paneId: string;
  generation: number;
  agentSession: HerdrAgentSession;
}
```

Before invoking the adapter, the owning workflow must verify that the claimed
binding or instance generation still matches. Before the first `ctrl+u`, the
adapter must then verify all of the following from a fresh, uncached targeted
observation:

1. the expected pane ID still resolves;
2. the exact native agent session is unchanged;
3. the TraeX process is present;
4. the structured agent state is `idle` or `done`;
5. the composer is ready; and
6. the transcript cursor was opened for that exact session before mutation and
   has no active fresh turn.

Generation is checked by the owning coordinator/store before invoking the port.
Pane and native-session identity are checked again by the adapter immediately
before each terminal effect. Herdr should eventually expose a native atomic CAS
operation for this sequence; until then, fresh observations before and after
each effect form the fail-closed approximation.

## Submission sequence

```text
claim one durable FIFO head
        |
        v
open exact-session transcript cursor
        |
        v
fresh target check: same pane/session + idle/done + composer ready
        |
        v
send logical ctrl+u
        |
        v
fresh target and transcript check
        |
        +-- changed/active/ambiguous --> uncertain; no prompt submission
        |
        v
submit prompt exactly once
        |
        v
bounded transcript settlement
        |
        +-- fresh exact turn ----------------> started(turnId, startedAt)
        |
        +-- identity/state/evidence conflict -> uncertain
        |
        `-- no fresh turn + same settled target
                    |
                    v
              send logical ctrl+u
                    |
                    v
              final fresh verification
                    |
                    +-- still settled and unchanged -> not_started
                    `-- otherwise -----------------> uncertain
```

The bounded settlement window reuses the existing exact transcript cursor and
dispatch-time fence. A newly observed turn is `started` even if it completes very
quickly; the existing exact-turn observer then owns completion projection. A
different or ambiguous fresh turn is never attributed to the claimed prompt.

## Proving `not_started`

`agent_prompt_stalled` alone is not proof. `not_started` may be returned only
after repeated observations through a bounded settlement window establish all of
these facts:

- no fresh transcript turn started after the pre-dispatch cursor;
- the exact agent session did not change;
- the pane remained `idle` or `done`, never `working`, `blocked`, or `unknown`;
- the TraeX process and composer remained available;
- the post-failure `ctrl+u` succeeded; and
- a final fresh observation still shows the same settled target and no fresh
  transcript turn.

If any fact cannot be established, the result is `uncertain`. Terminal
scrollback, answer text, a Lark card, elapsed time by itself, or a cached Herdr
snapshot cannot prove `not_started`.

## Durable transitions

The adapter reports evidence; it does not update SQLite. The owning workflow
performs the durable transition:

| Submission result | Durable transition | Scheduling |
| --- | --- | --- |
| `started` | Persist exact `turnId` and `startedAt`; remain running and attached | Observe that exact turn |
| `not_started` | Atomically mark the prompt failed/completed with a safe user-visible reason and update projections | Wake the same FIFO after commit |
| `rejected` | Apply the existing safe pre-dispatch rejection or requeue policy according to the stale cause | Wake only after the durable transition |
| `uncertain` | Mark running prompt detached; preserve no-replay fence | Do not dispatch later FIFO work |

The `not_started` transition must update Prompt, Run Card, Main Card, and Lark
outbox intent in the same transaction used by other terminal prompt outcomes.
The recovery path never directly submits the next prompt; it emits a scoped
workflow wake-up after commit, and the normal claim path selects the next FIFO
head.

Historical identityless detached prompts are not retroactively declared
`not_started`. They were created without the pre-dispatch cursor and sanitation
evidence required by this protocol and therefore remain explicit operator
recovery cases.

## Code boundaries

- `src/domain/ports/external.ts` defines a capability-focused prompt submission
  contract and the three explicit outcomes. `PromptRunWorkflow` must not call a
  raw `send-keys` method.
- `src/adapters/herdr-adapter.ts` owns fresh runtime checks and invokes the
  installed Herdr command surface. It never parses terminal pixels as proof.
- `src/runtime/herdr-traex-shim.ts` owns the exact-session transcript cursor,
  one-shot submission, short-turn settlement, and `not_started` proof.
- The installed shim/Herdr boundary owns logical `ctrl+u`; callers never write
  raw escape bytes to a guessed PTY.
- `PromptRunWorkflow` maps submission outcomes to durable Primary prompt
  transitions.
- Worker dispatch uses the same submission capability and outcome vocabulary,
  then maps results to `InstanceTurn` transitions without inventing a parallel
  sanitation protocol.
- SQLite remains authoritative for queue ownership and terminal workflow state;
  Herdr and the transcript remain authoritative for live identity and turn
  evidence.

The existing `runPrompt(...): Promise<AgentState>` API cannot express
`not_started` versus `uncertain`. It should be replaced or wrapped by the new
submission capability rather than encoding these outcomes as special error
strings. Waiting for completion remains a separate exact-turn observation
responsibility.

## Failure handling

- A pre-sanitation fence failure returns `rejected` without sending `ctrl+u` or
  prompt text.
- A session or state change after the first `ctrl+u` returns `uncertain` without
  submitting text.
- A prompt submission transport error is settled from transcript evidence; it is
  never retried automatically.
- Failure to send or verify the post-failure `ctrl+u` returns `uncertain`.
- A fresh exact turn always wins over a concurrent idle observation and returns
  `started`.
- A fresh conflicting turn returns `uncertain` and is left for normal external
  turn reconciliation.
- Shutdown after prompt submission preserves detached/no-replay behavior unless
  `not_started` was durably committed first.
- Logs contain hashes and identities, not prompt text or composer contents.

## Verification

Focused deterministic tests must cover:

1. idle exact-session Primary sanitation sends `ctrl+u` before one prompt
   submission;
2. Worker dispatch uses the same sanitation boundary;
3. `working`, `blocked`, `unknown`, missing process, missing composer, generation
   mismatch, and session mismatch prevent sanitation and submission;
4. a fresh exact transcript turn returns `started`, including a turn that
   completes before Herdr reports a lifecycle change;
5. no fresh turn plus an unchanged settled target performs the second `ctrl+u`
   and returns `not_started`;
6. any conflicting or ambiguous evidence returns `uncertain`;
7. prompt text is submitted at most once in every outcome;
8. `not_started` atomically fails the current run card, records delivery intent,
   and makes the next FIFO item claimable without sending it inline;
9. `uncertain` remains detached and blocks FIFO;
10. unknown slash-prefixed ordinary prompts follow the same protocol and are not
    rejected by command enumeration; and
11. prompt text and composer contents do not appear in errors or logs.

Before deployment, run the focused adapter, shim, Primary concurrency, Worker
dispatch, and SQLite transition suites, followed by `npm run typecheck`,
`npm run build`, and `npm test`. A live smoke must use a disposable managed pane
and demonstrate both a normal exact turn and an intentionally non-starting
submission. The smoke must verify FIFO continuation without restarting Herdr or
replaying the failed prompt.

## Operational consequence

After this change, stale composer text cannot silently contaminate the next
bridge-owned dispatch. A prompt that provably creates no TraeX turn becomes a
visible terminal failure and releases the FIFO. A prompt whose delivery cannot
be proven remains detached and blocks automatic progress, preserving the
existing safety invariant.
