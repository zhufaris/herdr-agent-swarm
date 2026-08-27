# Main Card Visual Hierarchy Design

## Goal

Make the Main Card read like a compact live status panel. A reader should see, in order, what TraeX is doing, which plan step is active, and whether new output is available. Runtime identity remains available without competing with task progress.

## Selected direction

Use the status-focused layout (option A). This is a presentation-only refinement of the existing `TopicViewState`; it does not change transcript capture, persistence, reconciliation, or the separation between Main Card and Answer Card projections.

The card renders these sections from top to bottom:

1. Header: task title, card lifecycle color, and concise current phase.
2. Live work panel: dynamic status title, elapsed time, token count, and the complete plan.
3. Recent activity: tool and progress events as secondary operational detail.
4. Latest message: a two-to-four-line Answer preview when useful.
5. Runtime footer: space, tab, pane, model, context, queue depth, worktree, and last-update time.

## Live work panel

Status and plan form one visual unit instead of two adjacent bordered panels. The panel stays expanded while a turn is running. Its border follows the card phase: blue while running, orange when blocked or failed, and green when done.

The status row contains only the captured reasoning heading plus reliable metrics. Reasoning body text is never rendered. If there is no heading, use `TraeX 正在处理` while active. Omit unavailable elapsed or token values instead of displaying placeholders.

Plan markers remain:

- `✔` completed
- `■` in progress
- `◻` pending
- `✕` failed

The in-progress step is visually strongest by position and marker. Completed and pending steps remain readable but secondary. The complete plan remains in the card payload. Plans with more than six steps may use a nested collapsed panel to control height.

## Information density

Remove the separate `当前工作 / TraeX 正在处理当前请求` block when live status exists because it repeats the header and status panel. Keep the existing fallback summary only when no live observation is available.

Rename the existing progress timeline presentation to `最近活动` and keep it visually secondary to the plan. Do not duplicate `update_plan` steps in this timeline.

Limit `最新消息` to a compact tail preview of two to four meaningful lines. It remains an Answer-derived preview and must not become a source for Main Card state.

Move runtime identity to the bottom. Render it as compact, muted rows:

```text
datasage · w5:t2 · w5:p4E
GPT-5.4 · context 36% · queue 0
worktree: feat/query-log · 刚刚更新
```

Missing values are omitted where possible, avoiding rows dominated by em dashes.

## State behavior

- Running: blue card and expanded live work panel.
- Blocked or failed: orange/red lifecycle treatment and existing recovery callout; live work remains visible.
- Done: green card, final status and plan retained, with runtime details still secondary.
- No live observation: preserve the existing summary/progress fallback so older or passive bindings remain understandable.

## Safety and compatibility

- Consume only `TopicViewState.liveStatus`, existing progress events, answer preview, and runtime metadata.
- Do not parse status or plans from Answer text.
- Do not render reasoning body, tool arguments, approval transcript, or hidden protocol content.
- Do not change durable source offsets or Answer Card pagination.
- Keep legacy persisted `TopicViewState` values without `liveStatus` renderable.

## Verification

Update focused card tests for ordering, de-duplication, compact runtime footer, status/plan markers, fallback behavior, and completed-state retention. Then run the complete test suite, typecheck, build, and `git diff --check` before deployment or the final feature commit.
