# Human Message Answer Segmentation Design

> **Superseded (2026-10-04):** The unified Human Turn Card design is the
> current behavioral authority. This historical document is retained for
> migration and rationale only.

## Status

Approved approach: every subsequent Human Message in an exact owned Agent turn
starts a new durable Answer segment. This rule is source-neutral: Feishu and
local Herdr input produce the same projection semantics.

## Problem

The current transcript projection retains a subsequent `human_message` as a
canonical timeline fact but consumes it without rendering it. The active Answer
Card therefore continues to show `Reply to` the turn's initial request even
after the Agent accepted a later Human Message. Agent output progresses, but the
Feishu view does not prove which Human Message that output answers.

Rendering the Human Message inline would leave the stale reply header in place
and can hide acceptance behind an already long or frozen page. Promoting the
message to a new Prompt would incorrectly change FIFO, turn ownership, and
no-replay semantics.

## Decision

A subsequent canonical `human_message` is a presentation boundary inside the
same Prompt and exact native turn:

1. The current Answer segment ends at the canonical cursor immediately before
   the Human Message. Its active page is finished and becomes immutable.
2. A new Answer segment and first Answer Card are reserved immediately. The new
   card repeats the normal Space/Pane identity and uses
   `Reply to 👤 <current-human-message-summary>`.
3. Until later Agent content arrives, the new card shows a bounded accepted /
   continuing status so Feishu visibly confirms that the Agent received the
   message.
4. Agent, Tool, lifecycle, Goal, and Task List facts after the boundary project
   only into the new segment. The Human Message remains canonical but is not
   duplicated in the card body.
5. The Prompt ID, native submission ID, Core turn ID, FIFO position, and
   observer remain unchanged. No Agent input is submitted or replayed by this
   presentation transition.

Every subsequent Human Message creates its own segment, even when several are
accepted before the Agent emits more output. Separate Human Messages must not be
coalesced into one visible request record.

## Durable model

Answer segment identity is owned by the Prompt and the canonical Human Message:

- segment zero is the Prompt's initial request;
- later segments use the stable Human Message event identity as their source;
- each Answer page belongs to exactly one segment;
- the segment stores the request summary source, start cursor, terminal cursor,
  and lifecycle state needed to reproduce the same cards after restart.

Processing a new Human Message is one SQLite transaction: persist the timeline
fact, close the previous segment, create the next segment/page projection, and
reserve the outbox intent. Duplicate delivery of the same event reuses the
existing segment and creates no additional page or CardKit effect.

The card-create/update effect remains in the durable outbox. A delivery failure
must not reopen the old segment or resubmit Agent work. Projection-gap evidence
remains visible on the newest mutable card until the exact new-segment snapshot
is checkpointed.

## Cursor and rendering rules

- The initial Human Message continues to provide segment zero's header and is
  not treated as a boundary.
- A later Human Message advances the canonical timeline cursor but renders no
  body element.
- Content before the boundary never moves to the new card. Content after the
  boundary never patches the frozen old card.
- A Tool started before the boundary but completed after it follows canonical
  event order; its completion is rendered on the new active segment using the
  existing late-result presentation when required.
- Goal and Task List remain current projections. The old segment retains the
  snapshot present when it was frozen; the new segment receives subsequent
  snapshots.
- Redaction and bounded one-line request-summary rules are identical to the
  initial Answer header.

## Compatibility and recovery

Existing historical Answer pages are not repartitioned or rewritten during
migration. The feature becomes active from a durable schema/projection revision;
Human Messages already consumed by an older revision remain historical facts.
New events after that revision create segments normally.

Startup recovery reconstructs the active segment from SQLite, not from current
terminal text or card contents. If the boundary transaction committed but the
CardKit effect did not, startup retries only that outbox effect. If the
transaction did not commit, replaying the same Core event creates the boundary
once.

## Boundaries

- Applies to subsequent Human Messages inside an exact owned Primary or Worker
  turn when that surface has an Answer projection.
- Applies identically to Feishu-originated and Herdr-local input once Core emits
  the canonical Human Message event.
- Does not change Prompt admission, CommandIntent routing, steering capability,
  approvals, or the rule forbidding automatic Prompt replay.
- Does not infer boundaries from text, timestamps, terminal output, or message
  order outside the canonical event stream.

## Verification

Tests must cover:

- one later Human Message freezes the old card and immediately creates a new
  accepted-state Answer Card with the new `Reply to` summary;
- multiple later Human Messages create distinct ordered segments, including
  messages received before intervening Agent output;
- Feishu and local Herdr origins converge to identical persisted segments;
- duplicate Core events are idempotent;
- Agent/Tool/Goal/Task List facts remain on the correct side of the boundary;
- frozen pages are never patched;
- restart at each transaction/outbox boundary converges without Agent replay;
- delivery failure retains durable recovery evidence and does not lose the
  Human Message or reopen the prior segment;
- historical pre-feature rows remain unchanged.

The implementation gate is the affected focused suites, the full Vitest suite,
`npm run typecheck`, `npm run architecture:check`, `npm run build`, and
`git diff --check`.
