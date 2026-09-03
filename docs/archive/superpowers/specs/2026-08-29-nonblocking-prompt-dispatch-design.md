# Non-blocking prompt dispatch design

## Goal

Remove Lark Answer Card creation from the critical path between durable prompt
acceptance and TraeX dispatch. A newly accepted prompt should become eligible
for execution immediately after its prompt, run-card projection, and outbound
card intent commit atomically to SQLite.

## Current bottleneck

`acceptClassifiedPrompt` persists the prompt and `stream_card_create` intent in
one transaction. The inbound workflow then wakes outbound delivery, publishes
`PromptQueued`, and only afterward wakes the prompt scheduler. Bridge event
publication waits for subscribers, and the card projection/outbox path can wait
for the Lark CardKit create request. Production evidence for prompt
`ca7c5b11-6d0e-48ec-87bf-489e2d116fc9` shows that card creation consumed
2.028 seconds and TraeX started five milliseconds later.

## Dispatch rule

After `acceptClassifiedPrompt` returns an inserted durable prompt, the inbound
workflow must wake the appropriate prompt or steering worker before awaiting
user-visible lifecycle projection. The existing SQLite transaction remains the
durability boundary: it persists the prompt, initial run-card state, and Answer
Card creation intent before either worker can act.

`PromptQueued` and `SteeringQueued` events remain durable view/audit signals,
but their subscriber latency must not gate prompt execution. Event publication
continues normally and errors continue through the inbound retry path; moving
the scheduler wake earlier does not make the message accepted before durable
state exists. Duplicate inbound delivery remains idempotent because the prompt
and outbox intent already exist before the wake.

## Ordering and recovery

Answer Card creation and later stream updates retain the existing per-answer
outbox lane. If TraeX emits output before CardKit creation finishes, the stream
updates remain pending behind `stream_card_create`; they are not sent early or
dropped. Restart recovery continues to discover both durable prompt work and
durable outbound work independently.

The change does not parallelize ordinary turns within one binding, relax FIFO,
or replay a possibly delivered prompt. Automatic steering continues to use its
own existing dispatch path and parent-turn fencing.

## Observability

Keep the existing `prompt-dispatch-decided`, `turn-started`, and outbox delivery
records. Their persisted timestamps provide the acceptance-to-start and
acceptance-to-first-content measurements. No per-message debug logging or new
high-cardinality metric is required for this scheduling change.

## Verification

- An integration test blocks the `PromptQueued` subscriber that represents the
  Lark projection path and proves the prompt scheduler is woken before that
  subscriber resolves.
- The test verifies the prompt and initial `stream_card_create` intent are
  already durable when the scheduler wake occurs.
- Existing FIFO, steering, event-card, outbox-lane, inbound idempotency, and
  recovery tests continue to pass.
- Typecheck, build, and the full Vitest suite pass.
- After deployment, a new real Lark prompt is measured from `created_at` to
  `started_at` and first delivered `stream_content`; the result is compared with
  the 2.033-second queue and 3.559-second first-content baseline.
