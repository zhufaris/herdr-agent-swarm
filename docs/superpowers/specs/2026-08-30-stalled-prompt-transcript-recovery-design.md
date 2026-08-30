# Stalled Prompt Transcript Recovery Design

## Problem

`herdr agent prompt --wait` can return `agent_prompt_stalled` when Herdr does not
observe an agent-state or sequence change within five seconds. This result is
ambiguous: the prompt may already have reached TraeX. Current handling marks the
prompt detached immediately. If the normal observation callback did not run
before the error, the prompt has no persisted transcript turn identity, so the
detached observer correctly refuses to consume any transcript output. The TraeX
turn can therefore finish successfully while its Answer Card remains empty.

## Decision

Treat a possibly-dispatched prompt failure as a transcript handoff point. Before
leaving the attached workflow, perform a bounded transcript read. If that read
observes a fresh turn start created after this prompt's dispatch attempt, claim
its exact `turnId` and `startedAt` using the existing atomic store operation,
publish any owned output, and then detach. The normal detached observer resumes
from that durable identity and completes the prompt without replaying it.

Do not weaken detached ownership checks. A detached prompt without an exact
identity remains uncertain. A transcript turn that predates dispatch, conflicts
with an already claimed turn, or lacks lifecycle identity is ignored.

## Data flow

1. Persist `dispatchedAt` immediately when Herdr may have submitted the prompt.
2. If `runPrompt` returns normally, keep the existing attached observation flow.
3. If it fails after possible dispatch, read the already-open transcript cursor
   once before marking the observer detached.
4. Accept only a fresh lifecycle start whose timestamp is not earlier than the
   persisted dispatch timestamp. Atomically persist `turnId` and `startedAt`.
5. Publish any output owned by that identity, mark the observer detached, and
   let the existing detached observer observe completion.
6. Never invoke `runPrompt` again for the same prompt.

## Existing backlog recovery

For live prompts already detached without identity, recovery is permitted only
when the bound session transcript contains exactly one unclaimed turn beginning
at or after the prompt's persisted `dispatchedAt`. Persist that exact identity,
then let the ordinary detached observer converge the answer and unblock FIFO.
Ambiguous or missing matches remain untouched for operator review.

## Failure handling

- Transcript read failure preserves the current detached-without-replay state.
- Identity conflict is logged once and does not alter prompt ownership.
- Lark delivery remains driven by durable run-card projection and the outbox.
- Recovery does not infer state from the visible Lark card or terminal scrollback.

## Verification

- Add a regression test where `runPrompt` dispatches, the transcript receives a
  complete turn, and Herdr throws `agent_prompt_stalled` before an observation
  callback. The prompt must gain exact ownership and its Answer Card projection
  must complete without a second dispatch.
- Add a negative test for an old or conflicting transcript turn.
- Run focused prompt workflow and transcript tests, typecheck, build, and the full
  suite because the change crosses workflow, persistence, and recovery behavior.
- Before live recovery or restart, confirm no active/uncertain instance turns or
  active deliveries. Verify the recovered prompts, answer versions, outbox, and
  both readiness endpoints afterward.
