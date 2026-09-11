# First-Turn Transcript Recovery and Outbox Fairness

## Problem

Two independent delays made a successful TraeX turn appear lost in Lark.

First, a newly started TraeX process may not expose its native Agent session until
the first prompt has been submitted. The current transcript acquisition waits for
session identity only before dispatch and reads only the persisted Binding. That
creates a cycle: the session does not exist until dispatch, but the transcript
observer becomes permanently unavailable before dispatch. A later periodic Herdr
reconciliation repairs the Binding, but it is too late for the active prompt.

Second, the Lark outbox always selects globally oldest lane heads. A large set of
old, independent lanes can therefore delay a newly accepted interactive Answer
Card for minutes even though the new lane is immediately deliverable.

## Goals

- Recover the exact typed transcript for the first prompt when native session
  identity appears only after dispatch.
- Preserve pane, terminal, Binding generation, native session, prompt, and exact
  transcript-turn fences.
- Preserve strict ordering inside every outbox lane.
- Give new interactive reply and Answer lanes bounded delivery latency while old
  lanes continue to make progress.
- Never use terminal text as structured output and never replay a prompt.

## Non-goals

- Reintroducing a TraeX shim or accepting legacy session identities.
- Inferring workflow state from Lark or repairing SQLite from card contents.
- Changing retry, dead-letter, quarantine, or Answer-page immutability semantics.
- Giving newer work absolute priority or abandoning historical outbox work.

## Considered approaches

### 1. Delay first dispatch until session identity exists

Rejected. Native TraeX creates the session as a consequence of the first prompt,
so a longer pre-dispatch wait cannot close the cycle.

### 2. Reopen the transcript after dispatch from an unfenced pane snapshot

Rejected. A pane may be replaced or start another native session during the wait.
Accepting the latest session without Binding ownership checks would attach output
from the wrong runtime.

### 3. Fenced post-dispatch identity adoption and weighted outbox selection

Selected. While the first prompt is already known to be dispatched, observe its
exact pane and apply the existing transactional runtime-observation policy. Only a
native session attached to the same Binding generation and pane may be adopted.
Then open the typed transcript at the pre-dispatch latest boundary and claim only
the fresh exact turn belonging to the prompt. For outbound delivery, select lane
heads from both an interactive class and the global oldest queue with a fixed
quota, maintaining FIFO inside each lane and guaranteed progress for both classes.

## First-turn transcript design

`TranscriptObserver.acquire` remains the pre-dispatch fast path. If it returns
`missing_session_identity` for a Binding with no completed turn, the executor
dispatches normally and starts an attached source-upgrade loop. The loop is bounded
by the existing first-turn grace period and observes the authoritative pane through
`HerdrPort.observeRuntime`.

Each observation is passed to a narrow store operation using:

- Binding ID;
- expected pane ID;
- expected Binding generation;
- observed terminal identity;
- observed native session identity.

The store reuses `applyRuntimeObservation`. Adoption succeeds only when the Binding
is active or draining, attached to the same pane and generation, and the observed
identity is native TraeX. Terminal or native-session mismatches fail closed. A
successful adoption returns the updated Binding.

The observer then opens the typed transcript at the boundary captured before
dispatch. The existing exact-turn ownership logic accepts only a fresh turn start
and persists its turn ID and canonical start time before projecting output. If the
identity never appears, observation fails, or a fence changes, the current
structured-output-unavailable behavior remains. The prompt is never submitted a
second time.

The source-upgrade loop must also run while the prompt waiter is active; reopening
only after the waiter completes would lose streaming updates and could race a later
external turn. Once upgraded, the normal attached observer owns reads and final
drain.

## Outbox fairness design

Lane ordering remains authoritative. Fairness changes only which independent lane
heads are selected for a delivery batch.

Interactive lane heads are:

- `answer:*` and `primary-answer:*`;
- independent `reply:*` intents created from current user interaction.

Each four-slot batch reserves up to two slots for the oldest eligible interactive
heads and fills the remaining slots from the globally oldest eligible heads.
Duplicates are removed, and unused reserved slots fall back to the global queue.
Because at least two slots remain global, historical work cannot starve. Because at
least two slots are available to interactive work, a new Answer cannot sit behind
hundreds of unrelated historical lanes.

The store exposes one lane-head query with an optional lane-class filter. Filtering
applies to `outbox_lane_heads`, never to later rows inside a lane. Backoff, active
quarantine, excluded lanes, forced scans, and `next_attempt_at` remain unchanged.

## Failure handling

- Runtime observation unavailable: retain unavailable transcript mode; do not
  modify Binding identity.
- Stale Binding or pane/generation mismatch: stop source upgrade and fail closed.
- Legacy or mismatched native session: preserve the current orphaning/reconciliation
  policy; never adopt it in the prompt path.
- Transcript absent after identity adoption: keep polling only within the bounded
  grace period, then use the existing unavailable notice.
- Lark delivery failure: existing retry and per-lane blocking behavior applies. A
  failed interactive lane cannot consume every global delivery slot.

## Tests

Add an integration regression where the Binding starts without session identity,
`runPrompt` creates a native session only after `onDispatched`, targeted runtime
observation reports that identity, and JSONL appears afterward. Assert that:

- the prompt is submitted exactly once;
- the Binding adopts the native identity under the original generation;
- the exact transcript turn is claimed;
- the Answer contains authoritative JSONL output, not terminal text or the
  unavailable notice.

Add outbox tests with more than one batch of old independent lane heads plus a new
Answer lane. Assert that the Answer is delivered in the first batch, old lanes also
advance, concurrency remains bounded, same-lane ordering is unchanged, and backed-
off or quarantined heads remain ineligible.

Run the focused prompt and outbox suites, TypeScript checking, build, and the full
Vitest suite before installation.
