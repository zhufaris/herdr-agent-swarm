# Conversation Segment Requester Mentions

Status: Gate 1 design approved; Gate 2 specification approved.

## Problem Statement

Ordinary Feishu Agent Input is now represented by an immutable Submission
Intent and a canonical Conversation Segment rather than a legacy `PromptJob`.
The completion-choice eligibility check still requires an active legacy
Prompt, while Completion Interaction persists and renders choices only for
`primary-prompt` and `worker-turn` owners. A successful Segment therefore
renders its final Markdown but cannot render trusted Human Review buttons or a
trusted mention of the user who submitted that turn.

The production reproduction on 2026-10-09 created closed Segment
`segment:1d44...` and delivered card-update outbox `624a4f70-906...`. The
delivered payload contained no CardKit mention, Action Set, or button, and no
independent text-notification outbox existed. Its canonical Core final also
contained no `completion_choice`, because the pane-only choice hook rejected
the new Agent Input path before adding its choice-list context.

An existing unmerged branch adds `primary-segment` ownership but uses the
Binding's fixed `creator_open_id` as both callback actor and mention target. In
a multi-user thread this is not necessarily the actor for the completed
request, so those commits are evidence and reusable implementation material,
not a complete solution.

## Solution

Make a submission-backed Primary Conversation Segment the trusted owner of its
completion presentation. Its immutable Submission Intent supplies the request
actor. A successful terminal Segment owns one Completion Notice whether or not
it contains a choice; a valid Core `human_review` result additionally owns one
immutable Completion Choice Specification and one current Action Set.

The final Turn Card renders the trusted request actor as a CardKit mention and,
when an Action Set is available, renders the question and ordered buttons.
Only acknowledgement of that exact final card revision releases one
deterministic standalone Feishu mention. A later ordinary Turn invalidates the
older actionable choice but does not cancel the older successful Turn's
completion notification.

Raw Agent Markdown remains untrusted. The Markdown normalizer continues to
strip HTML-like tags; neither actor identity nor button behavior is inferred
from prose.

## User Stories

### SCN-1: A choice-bearing Feishu turn renders trusted controls

Given a current attached Primary Pane and an ordinary Submission Intent from a
valid Feishu human actor, when Core emits a successful final with a valid
`human_review` completion choice, the canonical Segment stores the immutable
choice and its final Turn Card displays the trusted actor mention, declared
question, ordered business buttons, and system-owned Ignore action.

### SCN-2: A successful turn without a choice still notifies its requester

Given the same trusted request identity, when Core completes normally without
a valid completion choice, the final Turn Card displays the trusted actor
mention but no choice buttons. After that revision is acknowledged, Swarm
queues one standalone completion mention for that request actor.

### SCN-3: Card acknowledgement gates the independent mention

No standalone notification is eligible before the final action/mention-bearing
card revision is durably delivered. After acknowledgement, one deterministic
notification outbox is reserved. Retry or restart cannot reserve a second
notification or replay Agent Input. Permanent provider failure dead-letters
the notification without rolling back the final card or Segment.

### SCN-4: A selected option becomes normal Agent Input once

The exact request actor may select one declared option. Swarm atomically
consumes the Action Set and admits the stored option message through the normal
Agent Input path. Duplicate delivery returns the prior result and creates no
second input. Ignore consumes the Action Set locally and creates no input.

### SCN-5: A newer turn invalidates action, not notification

If Turn B is admitted before completed Turn A is acted on, A's Action Set is
superseded and its card converges without actionable buttons. A's successful
Completion Notice remains eligible and is delivered once to A's request actor.

### SCN-6: Missing or invalid authority fails closed

A direct-Herdr turn without a Submission Intent actor, a non-Feishu actor, a
failed or cancelled Segment, an invalid choice, a mismatched Binding/session,
or a stale actor/card/generation cannot create an actionable choice or success
mention. The answer itself remains visible.

## Implementation Decisions

### Domain Model

The affected bounded contexts are Agent Input, Conversation Projection,
Completion Interaction, and Delivery and Operations.

- **Request Actor** is the immutable human Feishu identity stored in the exact
  Segment's Submission Intent. Binding creator is not a substitute.
- **Segment Completion Owner** is the canonical `(segmentId,
  ownerGeneration)` identity represented as `owner_kind = primary-segment`.
  It does not create or masquerade as a Prompt.
- **Completion Notice** records the obligation to notify the Request Actor for
  one successful Segment. Its lifecycle is independent of action availability.
- **Completion Choice Specification** remains an immutable validated value of
  one question, one to four ordered options, their messages, and one default.
- **Completion Action Set** remains the one-shot aggregate protecting actor,
  Segment owner, generation, final card, option identity, successor input, and
  Ignore.

The following invariants apply:

- **INV-1 — request identity:** Card mention, callback authorization, and
  standalone mention use the exact Submission Intent actor for that Segment.
- **INV-2 — untrusted prose:** Raw Markdown cannot create a mention, choice,
  button, actor, or callback identity.
- **INV-3 — successful notice:** Every successful submission-backed ordinary
  Primary Segment owns at most one completion notification, including when it
  has no choice and when a newer Turn exists.
- **INV-4 — current action:** An Action Set is renderable and consumable only
  while it is the current choice for the exact final page/card and Binding
  generation. A newer ordinary Turn may supersede it.
- **INV-5 — one-shot successor:** Choice consumption and successor Agent Input
  admission are one fenced SQLite transition with deterministic source
  identity.
- **INV-6 — delivery ordering:** The independent mention is reserved only
  after acknowledgement of the exact final card revision containing its
  trusted completion presentation.

Conversation Projection owns canonical Segment state and associates it with
the immutable input actor. Completion Interaction owns notice/action
lifecycle and callback rules. Delivery and Operations owns external effect
ordering, retry, and dead-letter state. These aggregates may be joined inside
one SQLite transaction without transferring their state ownership.

### Architecture

The completion-choice eligibility module will recognize an exact active,
attached Primary Pane/session without requiring a legacy active `PromptJob`.
It may add repository-owned choice-list context to a Primary turn, but that
context grants no actor or callback authority. Worker eligibility retains its
existing exact-turn rules. A direct terminal prompt may therefore produce
structured choice metadata, but later Segment projection discards the
optional interaction surface when no trusted Submission Intent actor exists.

The Conversation Segment store exposes a small completion interface rather
than table-shaped data. It accepts validated terminal choice evidence during
canonical projection, prepares the final-page render state once the card
target is concrete, invalidates stale action state on newer input, and
converges notification release after delivery acknowledgement. Its render DTO
contains a trusted mention target and an optional Action Set; CardKit remains a
pure renderer.

SQLite resolves the Request Actor through the Segment's `submission_id` and
immutable Submission Intent actor envelope, validates the Feishu Open ID, and
persists the normalized mention target on the Completion Notice/Action Set so
recovery does not reinterpret later mutable Binding state. The completion
tables accept `primary-segment`; the notification obligation stores its own
mention target and notice kind so it does not require an Action Set.

The outbox delivery acknowledgement calls the owner-aware completion
transition using durable delivery identity. The transition verifies Segment,
generation, final page/message, rendered revision, and notice state before
reserving a deterministic text reply. Choice-bearing and completion-only
notices differ only in trusted message text. Existing Primary Prompt and
Worker owner behavior remains compatible.

Card callbacks carry opaque owner/action/option identifiers. The application
workflow asks Completion Interaction to resolve and consume the action, then
uses the existing Agent Input interface to admit the stored option message.
Coordinator code does not parse SQLite rows or trust CardKit payload data as
workflow state. Concrete stores and adapters remain assembled at the
composition root.

### Behavior & Failure Modes

On a successful canonical terminal transition, the Segment completion state,
optional immutable choice, and Completion Notice are written atomically.
Repeated Core events converge on the same owner and do not create another
obligation. Invalid or absent choice data is treated as completion without
actions, not as a failed answer.

Final-page convergence prepares a render state only when the exact current
page and trusted actor are available. The card update persists before the
external effect. A delivery acknowledgement releases the notification using a
deterministic key based on Segment owner and generation. Retry is at-least-once
at the transport boundary with existing outbox deduplication; local
reservation is once-only.

A newer ordinary Segment transaction supersedes prior available Action Sets
and schedules their cards to remove stale buttons. It does not suppress or
dismiss Completion Notices. Callback races are resolved by the Action Set's
conditional consume: one caller wins, while duplicates or stale callbacks
observe the existing result or a stable unavailable outcome.

Missing/malformed actor data, owner or session mismatch, stale generation,
wrong card/page, and invalid option fail closed. Permanent mention delivery
failure remains visible as a dead letter. No failure path rolls back the
canonical answer or resubmits a Core turn.

### Compatibility & Migration

Migration expands completion owner constraints to `primary-segment` and adds
the minimum notice fields needed for an actor-owned completion without an
Action Set. Existing `primary-prompt` and `worker-turn` rows, indexes, foreign
keys, notification wording, and callback behavior remain valid.

There is no broad historical backfill and no deployment-time notification of
old completed Turns. Only terminal transitions observed after the migration
create the new success obligation. Existing unmerged commits `acd6d20e` and
`b8a98ba0` may be used as reviewed implementation references, but are not
cherry-picked because their fixed Binding-creator identity and action-dependent
notification semantics conflict with this design.

## Testing Decisions

- At the completion-choice eligibility seam, prove a current exact Primary
  Pane/session is eligible without a PromptJob; reject detached, stale,
  ambiguous, non-TraeX, or mismatched runtime identities and preserve Worker
  checks.
- At the real SQLite Conversation Segment seam, save a submission-backed
  Segment, project terminal success, reopen the database, and verify restored
  actor, notice, optional choice, and post-load behavior.
- In Turn Card workflow tests, prove choice-bearing cards contain a trusted
  CardKit mention, question, ordered buttons, and owner metadata; choice-free
  success contains the trusted mention and no buttons; raw Markdown `<at>` is
  still removed.
- At the delivery seam, prove no text notification exists before final-card
  acknowledgement and exactly one deterministic notification exists after it.
  Verify choice-required and completion-only text, retry/restart idempotency,
  and permanent-failure isolation.
- At the interaction seam, test selected option, duplicate callback, Ignore,
  wrong actor, stale generation, wrong card/page, and supersession by a newer
  ordinary Turn.
- Prove the supersession interleaving separately: Turn B invalidates Turn A's
  buttons while Turn A's notification remains deliverable exactly once.
- Verify owner-less direct-Herdr, invalid choice, failed, and cancelled paths
  preserve answers without mention/action effects.
- Run affected eligibility, hook, Segment store/workflow, CardKit, interaction,
  migration, and outbox tests; `npm run architecture:check`; `npm run
  typecheck`; `npm run build`; `git diff --check`; and the full test suite.

## Out of Scope

- Allowing Agent-generated raw `<at>` or HTML passthrough.
- Inferring interactive choices from Markdown lists or natural-language
  option formatting.
- Synthetic Prompt creation for Conversation Segments.
- Anonymous, group-wide, Binding-creator, or first-click-wins authorization.
- Remote approval of native tools or direct terminal input.
- Historical completion-notification backfill, production SQLite mutation,
  installation, service restart, deployment, push, or pull-request creation.
- Changing Worker completion behavior except for preserving compatibility.

## Further Notes

- Gate 1 selected the unified Segment/Submission Intent design and was approved
  on 2026-10-09.
- Workspace mode: isolated Git worktree at
  `/tmp/herdr-agent-swarm-segment-requester-mention`.
- Branch and starting revision:
  `fix/conversation-segment-requester-mention` at
  `146c6077ffbf7196f2b9c2da8a5c52698916df47`.
- Isolation reason: the original main checkout contains unrelated modified and
  untracked user files. The first native worktree was preserved but could not
  run TypeScript because repository `.trae/` is read-only in the sandbox; the
  `/tmp` fallback is task-owned and writable.
- Dependencies: `npm ci` completed from the lockfile. It reported seven known
  high-severity audit findings; dependency remediation is outside this task.
- Fresh baseline at the starting revision: `npm test` passed 287 files and
  4,137 tests; `npm run typecheck`, `npm run architecture:check`, and `npm run
  build` passed. The baseline full suite ran in the original checkout at the
  same commit before the writable fallback was created.
- No unresolved load-bearing product decision remains. Gate 2 was approved on
  2026-10-09.
