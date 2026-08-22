# Request Step Progress Design

## Goal

Replace request-card tool activity with the actual plan or todo list maintained
by TraeX. A card should answer which steps are pending, active, and completed,
instead of listing low-level reads, searches, edits, or shell commands.

The project entry card's newest-message preview also grows from 500 to 2,500
characters while continuing to retain the newest text.

## Progress protocol

Herdr exposes agent lifecycle state but not the expanded task list shown by the
TraeX TUI. The bridge therefore appends a control instruction only to the text
submitted to TraeX. The persisted prompt and request-card request text remain
exactly what the user sent.

The instruction asks TraeX to emit a machine-readable block whenever its plan
changes:

```text
<herdr_progress>
{"steps":[{"id":"inspect","text":"Inspect current behavior","status":"in_progress"}]}
</herdr_progress>
```

Step IDs must remain stable within a turn. Status is one of `pending`,
`in_progress`, or `completed`. The bridge accepts only bounded JSON: at most 20
steps, bounded IDs and labels, and no unknown status. It uses the newest valid
block in the current TraeX answer. Invalid or absent blocks produce no inferred
steps.

The bridge removes protocol blocks from both streaming and final visible
answers. A protocol block is control data, never user-facing answer content.
Changing a step status updates the existing step with the same ID rather than
adding a duplicate.

## Request-card rendering

The expanded region is renamed from `执行进度` to `任务步骤`. It contains only
protocol-derived steps, in protocol order:

- `☐` pending;
- `◌` in progress;
- `✓` completed.

Read, edit, search, and test command observations are no longer rendered as
steps. If TraeX has not emitted a valid plan, the region shows only a concise
lifecycle message such as `正在等待 TraeX 提供任务计划` or `任务已完成`. The
answer region and lifecycle footer remain unchanged.

Steering messages are submitted unchanged. They affect the active turn, whose
original protocol instruction already asks TraeX to publish an updated plan
when the plan changes.

## Failure and compatibility

- Malformed, oversized, or unknown-status protocol data is ignored and removed
  from visible answers.
- Existing persisted tool-activity events are filtered out by the renderer, so
  old cards do not continue presenting operations as steps.
- A model that ignores the protocol still completes normally; its card shows
  lifecycle and answer without fabricated steps.
- Prompt deduplication, queue semantics, steering, and terminal-only approval
  behavior do not change.

## Verification

Tests cover protocol injection without modifying persisted user text, streaming
step creation and status replacement, protocol removal from visible answers,
malformed-block fallback, suppression of legacy tool activity, and the 2,500
character project-card preview. Existing integration, typecheck, and build
checks must continue to pass.
