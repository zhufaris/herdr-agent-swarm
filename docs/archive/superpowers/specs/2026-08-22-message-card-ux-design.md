# Message Card UX Design

## Goal

Make Feishu cards easier to scan when several Herdr requests are active in one
group. Each card must have one stable responsibility and enough context to be
identified without opening adjacent cards.

## Card responsibilities

The project main card shows the current Pane state, queue pressure, structured
progress, and the newest bounded message preview. It remains the one-place
summary for a binding.

The request card shows the original request and its execution plan. The request
is placed in its own collapsed panel. The execution plan is a separate expanded
panel with a completed/total count and structured steps. When TraeX has not yet
provided steps, the plan panel shows the lifecycle fallback. The footer carries
timing information instead of repeating the same state already communicated by
the header.

The answer card shows live prose or the final answer only. Its header uses the
same `TraeX · <space> / <pane>` identity as the other cards, and its subtitle
includes a bounded request title. Native TraeX status frames and todo lists are
removed from answer prose when they can be recognized; structured steps remain
on the request card. If no prose remains while running, the answer card reports
plan completion such as `TraeX 正在执行 · 7/9`.

## Metadata and status

The three-column metadata row is phase-aware. Queue position is shown only while
queued. During execution it becomes `STATUS / 运行中`, while blocked and terminal
states use `等待处理`, `已完成`, or `失败`. Completed and failed request cards show
elapsed duration when both timestamps are known. Notification summaries include
a bounded request title so concurrent tasks can be distinguished.

Space and Pane remain visible in card headers. The compact metric row may
truncate long values for layout stability, but the request detail panel retains
the full request text and the header preserves as much identity as CardKit's
limit allows.

## Topic navigation language

Every `open_project_thread` action is labeled `发送话题入口`, because clicking it
causes the bridge to post Feishu's native forwarded-topic card rather than
navigating immediately. Selection and attach result cards add a short sentence
explaining that the user should open the subsequently posted topic card.

## Operations cards

Session rows use Chinese lifecycle, attachment, and agent-state labels; relative
time replaces raw timestamps. Internal IDs are shortened in the default view.
Failure rows add available Space/Pane context, identify the failure stage, use a
short visible ID, and keep the full opaque ID only in action payloads. Retry is
the primary action; dismiss is secondary/default. Pagination and existing
authorization behavior remain unchanged.

## Safety and compatibility

No persistence migration is required. Rendering derives duration, progress
counts, relative time, and display labels from existing state. Markdown safety,
credential filtering, answer length limits, cross-group action checks, queue
semantics, and final-answer persistence remain unchanged. Unrecognized TraeX
prose is preserved rather than dropped.

## Verification

Renderer tests assert card identity, separated request/plan panels, progress
counts, phase-aware metadata, duration, task-specific summaries, status-frame
removal, empty-live-output fallback, accurate topic-action wording, localized
operations rows, relative times, short visible IDs, and action payload integrity.
Existing integration tests continue to cover action routing, authorization,
pagination, delivery, and final answer projection.
