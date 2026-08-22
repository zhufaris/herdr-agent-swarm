# Request-scoped live Lark cards

## Goal

Represent every accepted user prompt with one independent CardKit 2.0 message.
The bridge creates the card when it accepts the prompt, then updates the same
Lark message from queued through running to completion or failure. The card
shows filtered user-facing answer text and a separate, expanded execution
progress trail.

This replaces the current topic-scoped status-card behavior and the separate
acknowledgement and final-answer text replies. Topic bindings continue to map a
Lark thread to one TraeX process in a Herdr pane.

## User experience

Each valid non-command message produces exactly one run card. Multiple prompts
in the same topic have separate cards, so queued and completed turns remain
visible without overwriting one another.

The card contains four regions:

1. A header with a short request title and the current phase.
2. Compact workspace, pane, queue-position, and elapsed-time metadata.
3. An expanded execution-progress region containing safe, normalized activity.
4. An answer region containing only user-facing TraeX output.

The card phases are `queued`, `running`, `blocked`, `completed`, and `failed`.
The header color and footer status follow the phase. A completed card stays
green and retains both the complete simplified progress trail and final answer.
A blocked card directs the user to the corresponding Herdr pane because Lark
cannot approve high-risk actions.

The bridge does not send separate text messages for receipt, progress, or the
final answer. `/herdr help` and `/herdr status` remain standalone command cards
and are outside the request-run model.

## Lifecycle and data flow

1. Lark ingress deduplicates and durably records the incoming event.
2. Prompt acceptance resolves the topic binding and, in one SQLite transaction,
   creates the FIFO prompt job, its initial run-card snapshot, and the durable
   card-create outbox item.
3. The card publisher creates the Lark card and records its `message_id`. The
   worker does not start this prompt until the initial card exists.
4. When the worker claims the prompt, the projector changes the phase to
   `running` and records the start time.
5. While TraeX works, the Herdr output poller reads terminal changes. The output
   parser converts safe changes into answer deltas and normalized progress
   events. The projector merges them into the request snapshot.
6. The update scheduler coalesces ordinary changes and patches the same Lark
   message no more than once per 800 milliseconds.
7. `blocked`, `completed`, and `failed` changes bypass the ordinary delay and
   request an immediate update.
8. Completion replaces any partial answer representation with the filtered final
   answer while retaining the expanded progress trail.

FIFO execution remains binding-scoped. Queue positions in all affected queued
cards are recalculated when a prompt is enqueued, claimed, completed, or failed.
Queue-position refreshes use the same coalescing scheduler.

## Components and responsibilities

### Prompt acceptance

Prompt acceptance owns ingress validation, binding lookup, prompt creation, and
the initial run-card snapshot. A stable `prompt_id` is the run-card projection
key. It creates no user-visible text reply and does not render cards itself.

### TraeX output parser

The parser accepts the delta between two Herdr terminal snapshots and returns:

- `answerDelta`: filtered user-facing text, if confidently identified;
- `progressEvents`: zero or more normalized activity events; and
- `agentState`: a confidently detected lifecycle change, if present.

Progress events use a bounded vocabulary such as analyzing the request, finding
code, reading files, editing files, running tests, tests passed, and tests
failed. Each event has a stable deduplication key, display text, state, and
timestamp. Unrecognized terminal content produces no progress event.

### Run-card projector

The projector owns the pure transition from the current request snapshot plus a
lifecycle or output event to the next snapshot. It accumulates answer text,
deduplicates progress events, calculates elapsed time and queue position, and
increments `view_version` only when rendered state changes. It never invokes
the Lark SDK.

### Card update scheduler

The scheduler maintains independent state per prompt. Ordinary changes are
coalesced into an update at most once every 800 milliseconds. Terminal and
blocked phases request immediate dispatch. Each card permits only one in-flight
patch. Changes that arrive while a patch is in flight become the next desired
version, preventing an older response from overwriting newer state.

A bounded global patch concurrency protects the app from an update storm across
multiple panes. Lark rate-limit responses honor the SDK retry delay or
`Retry-After` value when available.

### Durable card outbox

Card creation and patching pass through the existing durable Lark outbox. A
create item has a stable key derived from the prompt and delivery purpose. An
update item targets a prompt and `view_version`. Pending intermediate updates
may be superseded by a newer snapshot; recovery sends the newest desired view
rather than replaying obsolete frames.

The publisher records a create item as delivered only after Lark returns a
message ID. It records a patch as delivered only after Lark confirms the update,
then advances `delivered_version`.

## Persistence model

SQLite stores one request-level snapshot per prompt. The conceptual record is:

```text
run_card
  prompt_id             primary key
  binding_id
  lark_message_id       nullable until card creation succeeds
  phase
  title
  answer
  progress_events_json
  queue_position
  started_at
  finished_at
  view_version
  delivered_version
  created_at
  updated_at
```

`answer` contains only filtered, accumulated user-visible content.
`progress_events_json` contains structured simplified events, never raw terminal
lines. `view_version` advances for meaningful view changes;
`delivered_version` identifies the newest version confirmed by Lark.

The existing binding continues to own the Lark topic, root message, Herdr pane,
and FIFO queue. Its topic-scoped `statusMessageId` no longer represents prompt
execution state and is not used for new request cards.

## Card rendering and size limits

The renderer always produces a complete CardKit 2.0 document from the snapshot.
It enables multi-client updates and streaming presentation while a prompt is
running. It does not append raw card fragments.

Card size enforcement is deterministic. The renderer first preserves the phase,
error or approval guidance, metadata, and final answer. If content still exceeds
the configured safe CardKit budget, it removes the oldest progress entries and
adds `已省略 N 条较早记录`. Only after progress compaction may it truncate the
answer, adding an explicit truncation marker. Completion uses the final filtered
answer as the authoritative answer content.

## Safety and filtering

Only confidently recognized content is eligible for display. The answer region
accepts TraeX user-facing answer output. The progress region accepts only the
bounded structured event vocabulary; it never displays an arbitrary terminal
line.

The parser and renderer exclude:

- model thinking or reasoning text;
- raw tool-call JSON, arguments, and results;
- full shell commands and terminal UI;
- ANSI sequences and cursor-control data;
- environment variables, authorization headers, tokens, cookies, and private-key
  shaped values;
- URLs containing credentials or sensitive query parameters; and
- absolute paths when a repository-relative path can be shown.

Uncertain content is omitted. File activity uses repository-relative paths.
Structured logs record event types, prompt IDs, versions, phases, and content
lengths but not full prompts, answers, raw output, or rejected content.

## Failure and recovery behavior

### Card creation failure

The prompt and create outbox item remain durable and retryable. The corresponding
TraeX job does not start until its card is created, preventing an invisible run.
Other prompts may continue according to FIFO eligibility; a prompt whose card is
not yet created cannot be bypassed within the same binding.

### Card update failure

An update failure does not interrupt TraeX. The newest desired snapshot remains
pending and retryable. Intermediate versions are coalesced. Terminal and blocked
states remain pending until delivered or classified as a permanent Lark failure.
Permanent failures are logged with prompt and delivery identifiers without card
content.

### Process restart

On startup, the bridge restores run-card snapshots and drains pending outbox
items. A card with a known Lark message ID is patched in place and never recreated.
Pending obsolete patches collapse to the latest snapshot.

Prompts that had not started remain queued and may execute normally. A prompt
that was running when the bridge stopped is not replayed into TraeX; it becomes
`failed`, and its existing card is updated with `Bridge 重启导致本次执行中断`.

If Lark created a card but its response was lost before the bridge recorded the
message ID, the Lark message API provides no end-to-end idempotency key that the
bridge can use to recover that ID. A retry can therefore create a duplicate in
this narrow uncertain-delivery case. Stable outbox keys prevent all logical and
process-local duplicates under bridge control.

### Pane loss and approval

If the bound Herdr pane disappears, the running card becomes `failed`. Subsequent
queued cards become `blocked` with binding-recovery guidance; the bridge never
silently moves a prompt to another pane. High-risk approval remains terminal-only.

## Verification

Automated tests must demonstrate:

1. Each accepted ordinary message creates one prompt and one independent card.
2. One prompt uses the same Lark message ID through queued, running, and completed
   phases.
3. Receipt and completion produce no additional text replies.
4. Multiple FIFO prompts have separate cards and correct queue positions.
5. Answer deltas and normalized progress appear in separate card regions.
6. Frequent ordinary changes are coalesced to at most one patch per 800 ms.
7. Blocked, completed, and failed transitions request immediate updates.
8. A newer view arriving during an in-flight patch is sent afterward and cannot
   be overwritten by the older version.
9. Duplicate Lark events create neither a second prompt nor a second card-create
   outbox item.
10. Temporary Lark failures recover by delivering only the newest desired view.
11. Restart recovery updates known cards in place and never replays interrupted
    running prompts.
12. Thinking, tool parameters, ANSI data, raw commands, and credential-shaped
    content do not reach cards or structured logs.
13. A completed card retains its expanded simplified progress trail and final
    answer.
14. Oversized content is compacted in the documented order and reports omissions.
15. Help, status, topic binding, FIFO execution, and terminal-only approval do not
    regress.
16. The full test suite, TypeScript typecheck, build, and readiness probe pass.

## Non-goals

- Remote stop, retry, or approval buttons in Lark.
- Displaying raw TraeX terminal output or model reasoning.
- Persisting a complete event-sourced history of every terminal delta.
- Automatically replaying a prompt interrupted after TraeX execution began.
- Providing exactly-once creation after an ambiguous Lark API response.
