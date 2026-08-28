# Main Card Visual Hierarchy Design

## Goal

Make the Main Card read like a compact live status panel. A reader should see, in order, what TraeX is doing, which plan step is active, and whether new output is available. Runtime identity remains available without competing with task progress.

## Selected direction

Use the status-focused layout (option A). The Main Card continues to use a bounded, Answer-derived tail stored in `TopicViewState`; it does not become canonical transcript storage and does not change reconciliation or the separation between Main Card and Answer Card projections.

The card renders these sections from top to bottom:

1. Header: task title, card lifecycle color, and concise current phase.
2. Live work panel: dynamic status title, elapsed time, token count, and the complete plan.
3. Recent activity: tool and progress events as secondary operational detail.
4. Latest message: up to the latest 12 meaningful Answer lines when useful, bounded to 6,000 rendered characters.
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

Render `最新消息` from the latest 12 meaningful Answer lines, with an independent 6,000-character CardKit field budget. This gives the group-level card enough context for multi-step status and short code/log excerpts without turning it into the full Answer surface. If the selected lines exceed the character budget, retain useful content from both ends with the existing deterministic middle-omission marker.

Retain the latest 9,000 Answer characters in the durable `TopicViewState` projection so the renderer has enough source text to populate the larger preview. This rolling tail is still a bounded display projection: it is not canonical Answer storage, must not drive answer-page offsets or recovery, and resets at the existing turn boundary. The separate remote-panel `最近输出` preview keeps its existing 2,000-character budget.

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
- Bound the durable TopicView Answer tail at 9,000 characters and the project-entry `最新消息` field at 12 lines / 6,000 characters.
- Do not parse status or plans from Answer text.
- Do not render reasoning body, tool arguments, approval transcript, or hidden protocol content.
- Do not change durable source offsets or Answer Card pagination.
- Keep legacy persisted `TopicViewState` values without `liveStatus` renderable.

## Verification

Update focused card tests for ordering, de-duplication, compact runtime footer, status/plan markers, fallback behavior, completed-state retention, and the 12-line / 6,000-character latest-message bounds. Update TopicView reducer tests to prove that it retains exactly the latest 9,000 characters without affecting current-turn progress. Then run the complete test suite, typecheck, build, and `git diff --check` before deployment or the final feature commit.
