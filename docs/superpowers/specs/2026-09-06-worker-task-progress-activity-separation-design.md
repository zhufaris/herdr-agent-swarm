# Worker Task Progress and Current Activity Separation

## Goal

Make an active Worker Task Card distinguish durable task progress from the
Worker's current tool call. A reader should understand the task stage without
mistaking a transient command, read, search, edit, or test operation for a
completed plan step.

## Current behavior

`WorkerTurnCardView.progressEvents` contains both plan steps and structured tool
activities. `workerTurnProgressContent()` renders every event directly below the
`statusTitle` in one Markdown element. The resulting block visually merges:

- the current phase description;
- durable plan progress; and
- current and completed tool calls.

The card therefore cannot communicate which information is a stable progress
summary and which operation is happening at this moment.

## Chosen design

The Worker Task Card has two independently rendered concepts.

### Task progress

The `📈 任务进度` section contains:

- `statusTitle`, when present, as the current task-stage description; and
- only `progressEvents` whose `kind` is `step`.

Step state markers remain visible, including completed, active, pending, and
failed states. The existing bounded progress summary remains the source for
counts and omitted-history behavior. Tool activities never appear in this
section. When there are no plan steps, the section shows the `statusTitle` or
the existing waiting fallback.

### Current activity

The `⚡ 当前活动` section contains only the newest non-`step` progress event
whose state is `active`. It is a separate CardKit element below task progress.

Rules:

- show at most one activity;
- prefer the latest active event in projection order;
- preserve its structured kind decoration and sanitized label;
- hide the entire section when no active tool activity exists;
- remove an activity as soon as its state becomes `done` or `failed`; and
- never retain a completed tool call as a placeholder while waiting for the next
  activity.

Completed and failed tool-call history remains available in the Herdr pane and
durable transcript projection, but is not rendered on the Worker Task Card.

## Data and delivery boundaries

This is a presentation change. The transcript projector continues emitting
structured tool activities and the Worker turn reducer continues retaining the
bounded progress snapshot. The renderer derives the two visible sections from
that existing state. No SQLite schema migration or new source of truth is
required.

The existing `worker-progress` stream element remains the ordered delivery lane.
Its rendered Markdown payload contains task progress followed by the optional
current-activity section. This preserves CardKit stream sequencing and avoids a
second mutable delivery lane. “Separate” means visually and semantically
separate sections, not independently delivered outbox records.

Final output behavior does not change: active cards omit output, and completed
cards expose the final output only after the turn finishes.

## Terminal phases

On `completed`, `failed`, `cancelled`, or `dispatch-uncertain`, there is no
current activity section. Plan progress may remain visible as a task summary.
The existing notice and final-output rules remain authoritative for each terminal
phase.

## Error handling and safety

- Labels still pass through secret redaction and Lark preview normalization.
- Empty-target Command activities remain suppressed by the transcript projector.
- Missing or malformed activity data falls back to the progress section without
  producing a synthetic tool label.
- The change does not affect prompt dispatch, replay behavior, Worker routing,
  or interaction buttons.

## Tests

Add focused renderer coverage for:

1. `statusTitle` and plan steps appearing under `📈 任务进度`.
2. The newest active non-step event appearing under `⚡ 当前活动`.
3. Older active activities being hidden when a newer active activity exists.
4. Done and failed tool activities being absent from the card.
5. The entire current-activity section being absent when no active activity
   exists.
6. Terminal cards never rendering current activity.
7. Progress stream updates retaining the existing `worker-progress` element and
   ordered outbox lane.
8. Active cards continuing to omit partial output and completed cards continuing
   to publish final output once.

Before handoff, run the focused Worker card and workflow tests, TypeScript
typecheck, build, and the full test suite because the renderer is used by durable
card convergence and recovery.
