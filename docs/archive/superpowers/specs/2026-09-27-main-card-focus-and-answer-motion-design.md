# Main Card Focus and Answer Motion Design

## Goal

Make the Primary Main Card easier to scan by separating task state, plan, and
conversation history without repeating the same activity. Make active Primary
and Worker Answers visibly progress while text is streaming, without generating
timer-only Gateway traffic.

## Main Card information hierarchy

The normal-state Primary Main Card uses this order:

1. **Current task summary**: one compact line for the current status, elapsed
   time, and token count.
2. **Execution plan**: plan steps with an explicit completed, active, pending,
   or failed marker. Up to five relevant steps are expanded; longer plans use a
   collapsed full-plan panel and keep the active step visible in the summary.
3. **Recent conversation**: the newest five durable user or Agent messages in
   chronological order.
4. **Current operation**: at most one non-plan tool activity, only when it adds
   information not already represented by the current status or active plan
   step.
5. Worker controls and runtime identity retain their existing behavior.

Actionable states continue to put the recovery notice ahead of passive history.
The Main Card remains a bounded summary; the Answer remains the full ordered
Agent/tool timeline.

## Duplicate suppression

Plan events are never repeated in the current-operation section. The renderer
also normalizes the current status title, active plan-step label, and selected
tool label before comparison. It suppresses a current operation when its label
equals, contains, or is contained by either of the other two labels after
case-folding and whitespace/punctuation normalization.

This rule is deliberately presentation-only. It does not discard progress
events from the Topic View or Answer timeline. When no structured live status
exists, the existing fallback task summary and latest non-plan activity remain
available.

The recent-conversation projection continues to hold five messages. During an
active turn, the current user's request may appear there, but the mutable Agent
draft stays in the Answer and is omitted from Main Card history until the turn
is terminal. This prevents a streaming Answer paragraph from duplicating the
current task/activity area. Completed Agent replies are backfilled and retained
normally across restart.

## Answer motion

Feishu rich-text posts do not provide a native animated text cursor. Active
Answers therefore use four deterministic frames:

```text
💭
💭·
💭··
💭···
```

The frame advances only when a real Answer projection is emitted. Primary and
Worker workflows pass their durable view version to the shared rich-text page
planner, which derives the frame without introducing a separate mutable timer
or animation record. Frozen, completed, failed, cancelled, and
dispatch-uncertain pages contain no marker.

To make short streamed fragments visible, the rich-text update guard changes
from a 1,000 ms and 48-character threshold to a 750 ms and 16-character
threshold, while newline-terminated progress remains immediately eligible after
the time gate. Existing per-card scheduling, outbox coalescing, lane ordering,
and one-pending-update rules continue to bound traffic.

No heartbeat-only updates are generated. If an Agent produces no new content,
the marker pauses; this avoids durable outbox growth and Lark rate-limit pressure
for an animation with no new information.

## Data and recovery

No schema migration is required. `recentConversation`, Run Card view versions,
Answer timeline items, and page checkpoints remain canonical. Main Card
deduplication and cursor-frame selection are rendering transforms. Startup
backfill continues to rebuild recent conversation from durable Run Cards, while
frozen Answer pages remain immutable.

## Verification

Focused tests must prove:

1. A live Main Card presents task status and plan before recent conversation.
2. A plan-equivalent or status-equivalent activity is omitted.
3. A distinct Read, Search, Edit, Command, or Test activity remains visible.
4. The active Agent draft is absent from recent conversation, then appears once
   the turn is terminal.
5. Plans of five or fewer steps are readable inline; longer plans retain a
   compact active-step summary and a collapsed complete list.
6. Successive Primary and Worker Answer versions select successive motion
   frames, while terminal pages have no frame.
7. Short real output deltas become eligible at the new bounded cadence, and
   unchanged content never creates an update.
8. Existing single-title, Bash code-block, pagination, recovery, and outbox
   ordering tests remain green.

## Non-goals

- Timer-driven animation while an Agent is silent.
- Rewriting frozen Answer pages.
- Increasing the five-message Main Card history window.
- Changing Worker Main Card layout, execution semantics, or remote approval
  boundaries.
