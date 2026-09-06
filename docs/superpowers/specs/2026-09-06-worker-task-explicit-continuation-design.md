# Worker Task Explicit Continuation

## Problem

In a Lark topic, a text message created by choosing "reply" on a Worker Task
Card does not retain that card's message ID. Both the receive event and the
message-detail API expose the Primary topic root as `parent_id`; the detail API
does not return `upper_message_id`. The bridge therefore cannot distinguish a
card reply from an ordinary Primary-topic message.

Guessing from the latest card, selected Worker, or topic history could send an
instruction to the wrong Worker and is not allowed.

## Design

The Worker Task Card's explicit action is the supported continuation surface:

- `补充当前任务` opens a form whose callback carries the exact Worker instance,
  Worker session generation, turn, and card identity. Submission steers only
  that active turn.
- `继续这个任务` opens the same fenced form for a terminal task. Submission
  creates a FIFO follow-up with the selected turn as its parent.
- Ordinary text in the Primary topic remains a Primary prompt. The bridge does
  not infer a Worker target from topic position or visual reply placement.
- An exact `parent_id` match to a Worker Task Card remains defensively handled
  if Lark supplies it, but the UI and documentation do not promise that path.

Task Card guidance must tell users to use the button and must not claim that
replying to the card is sufficient. Queued, preparing, and dispatch-uncertain
tasks continue to expose no continuation action.

## Safety and Testing

The existing callback fences and durable submission transitions remain the
source of truth; no prompt is replayed. A regression test models the observed
Lark shape where `parentMessageId === rootMessageId` while a Worker Task Card
exists and verifies that the message follows the Primary FIFO. Existing tests
continue to verify exact card callbacks route to the intended Worker and reject
stale generations.
