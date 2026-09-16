# Primary Main Card information hierarchy

## Goal

Align the canonical Primary Main Card with the approved task-centered hierarchy
already used by Worker Main. The card should let an operator scan the current
Primary task, its latest answer, owned Workers, and recent execution activity as
four distinct concepts.

## Scope

This change is presentation-only. It changes `renderProjectEntryCard()` and its
focused renderer tests. Existing `TopicViewState`, transcript observation,
SQLite projection, outbox, card identity, callbacks, Worker creation, and
recovery behavior remain unchanged.

## Layout

The canonical Primary Main Card uses this order:

1. `当前任务`
2. actionable notices
3. `最新消息`
4. `Workers`
5. `最新活动`
6. runtime footer

The blocked/error callout stays visually close to the task it affects and ahead
of mutable content and controls. Runtime identity remains the final evidence
section.

### 当前任务

When structured `liveStatus` exists, the section contains:

- the structured status title;
- elapsed time when available;
- token usage when available; and
- structured plan steps, including their completion summary.

The section heading is `🎯 当前任务`; a nested long-plan panel is named
`完整任务清单`. Missing elapsed or token values are omitted rather than shown
as zero. No task state is inferred from the free-form answer.

When `liveStatus` is absent, the existing durable work summary remains the
fallback, but its section label becomes `当前任务` so legacy and structured
paths have the same meaning.

### 最新消息

The existing bounded answer preview remains unchanged under `💬 最新消息`. It
does not include status text, plan steps, or tool activity.

### Workers

The existing bounded Worker summary, canonical Worker Main links, overflow
count, and inline Worker creation form remain unchanged. Workers appear after
the latest Primary message and before execution activity.

### 最新活动

Rename `最近活动` to `最新活动`. It contains only recent non-plan progress
events, including structured tool activity and legacy progress events that
cannot be proven to be plan steps. Structured plan keys already represented in
`当前任务` are excluded to avoid duplication. The existing five-item bound is
preserved.

## States and safety

- Blocked, error, degraded, orphaned, draining, and archived notices keep their
  current colors and recovery guidance.
- Primary tool availability warnings remain unchanged.
- Worker creation and navigation callbacks keep their exact durable identity.
- Pane Entry cards continue to reuse the Primary rendering passively, with
  callbacks removed by the existing projection.
- No new Lark messages or notification surfaces are introduced.

## Tests

Focused renderer tests will prove that:

- structured status, elapsed time, token usage, and plan steps appear under
  `当前任务`;
- `最新消息`, `Workers`, and `最新活动` occur in the approved order;
- plan steps do not repeat in `最新活动`;
- missing token usage is omitted;
- the fallback without `liveStatus` is labeled `当前任务`; and
- existing actions, notices, runtime footer, bounds, and passive Pane Entry
  behavior remain intact.

## Non-goals

- Changing Primary Answer Card layout.
- Changing Worker Main or Worker Task cards.
- Adding or deriving new workflow state.
- Changing persistence, recovery, pagination, outbox delivery, or thread routing.
