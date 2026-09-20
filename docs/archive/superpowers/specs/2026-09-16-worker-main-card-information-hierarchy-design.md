# Worker Main Card Information Hierarchy Design

## Goal

Align the canonical Worker Main Card with the Primary Main Card's information
semantics while keeping Worker-specific identity and actions. The card must make
four questions easy to answer: what task is being pursued, what the Worker most
recently said, what tools it most recently used, and what runtime owns the work.

## Information hierarchy

The canonical Worker Main Card uses this order:

1. compact Worker runtime metadata;
2. actionable blocked notice, when present;
3. current task;
4. latest message;
5. recent activity;
6. task actions;
7. queue and recent-task history; and
8. detailed runtime identity.

The Worker card does not render a Workers list. That list belongs to the Primary
Main Card. Worker identity, pane, queue depth, model, parent Primary, session,
runtime generation, workspace, and branch remain available in the existing
metadata and runtime sections.

## Current task

Rename the current progress presentation to `当前任务`. It contains:

- the current task title and lifecycle state;
- elapsed time;
- token consumption when the structured Worker observation provides it; and
- explicit task-plan steps from `plan:*` progress events.

Tool calls must not appear in this section. If the Worker has no explicit plan,
the section still shows the task title, state, elapsed time, and available token
count without inventing plan steps. The existing request text remains part of
the task context. The task list stays bounded to five visible plan steps.

The Worker projection must carry token count as structured task data. The value
comes from the same structured TraeX transcript observation used for Primary
status and must never be parsed from free-form answer text or terminal
scrollback. A missing value is rendered by omission rather than as zero.

## Latest message

Rename `当前输出` to `最新消息`. It shows the current Worker's latest safe
answer snapshot while running and its final result after completion. Existing
redaction, Markdown normalization, and content bounds remain in force. Empty
output omits the section.

This section is a message preview, not task progress. It does not contain plan
steps, tool arguments, reasoning, approval transcripts, or hidden protocol
content.

## Recent activity

Rename and preserve `最近活动` as the bounded tool-activity section. It contains
all non-plan progress events, including reads, searches, edits, commands, tests,
skills, agents, waits, and unknown legacy activity. Unknown keys remain activity
so legacy data cannot be misrepresented as an explicit task plan.

The section shows at most five recent items using the existing progress timeline
style and lifecycle markers. It is omitted when there is no activity.

## Blocked state and actions

The expanded orange `需要处理` notice remains ahead of task, message, and
activity content. The CardKit summary remains `等待用户处理` while the current
task is blocked. Approval and local questions remain actionable only in the
matching Herdr Pane.

Existing task controls keep their exact semantics and identity fences:

- `补充当前任务` steers one exact active turn;
- `继续这个任务` creates a FIFO follow-up whose parent is the selected terminal
  turn;
- `停止当前任务` interrupts only the exact eligible running turn; and
- `发起新任务` creates an independent FIFO task.

This visual reorganization must not loosen instance generation, Worker session,
current-turn, parent binding, parent pane, chat, or canonical card-message
checks.

## Data flow and boundaries

The flow remains:

```text
structured TraeX observation
  -> Worker turn projection
  -> Worker Main projection source
  -> WorkerMainView current task
  -> pure Worker Main Card renderer
  -> durable outbox
  -> Feishu CardKit update
```

Only the structured token count requires a data-contract addition if it is not
already preserved by the Worker turn and Worker Main projections. Schema changes
must follow the existing additive SQLite migration path. Card rendering remains
pure and performs no SQLite, Herdr, or Feishu queries.

Canonical Worker Main Cards receive live updates. One-time Worker snapshots and
legacy entry cards reuse the same information hierarchy but remain read-only at
the application layer. No extra chat message or notification record is created.

## Verification

Focused tests must verify that:

- `当前任务` contains title, state, elapsed time, token count, and plan steps;
- tool and legacy activity never appears under `当前任务`;
- `最新消息` contains the latest safe answer and is absent when empty;
- `最近活动` contains only non-plan activity and remains bounded;
- missing token data is omitted;
- blocked notice ordering and notification summary remain unchanged;
- Worker Main task actions retain their exact callback identities;
- snapshots reuse the hierarchy without live controls; and
- projection persistence and reopen preserve token count when supplied.

After focused tests, run `npm run typecheck`, `npm run build`, and the full
`npm test` suite because the Worker Main projection, SQLite representation, and
shared renderer affect canonical cards, snapshots, and startup convergence.

## Non-goals

- Adding a Workers list to a Worker card.
- Inferring task plans, token counts, or human-review state from free-form text.
- Exposing reasoning, tool arguments, or approval transcripts.
- Adding remote approval or arbitrary terminal input.
- Sending additional chat reminders for card updates.
- Changing Primary Main Card layout in this implementation slice.
