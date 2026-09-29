# Main Card Density and Answer State Design

## Goal

Reduce the Primary Main Card's passive chrome while making its next useful
action obvious. Improve rich-text Answers so task progress, tool results, and
terminal state can be understood without reading a full transcript.

## Main Card hierarchy

The existing task-first hierarchy remains authoritative. When a current Answer
target exists, its navigation button moves immediately after the task and any
recovery notice, before recent conversation. Its label is phase-aware:
`打开实时 Answer` while work is active and `查看最终 Answer` after completion.

Recent conversation remains capped at five durable messages. Each message is
bounded independently to four visible lines so one multiline message cannot
consume the card. The newest message receives the largest character budget;
older messages retain a readable tail and remain chronological.

Workers become one collapsible section. The section is expanded when Worker
instances exist and collapsed when empty. Worker summaries, navigation actions,
and the create form stay inside the section, preserving all capabilities while
removing the always-open empty form from the normal reading path.

Runtime becomes one collapsed diagnostic section. Its header retains the Pane
identity, Agent, model, context, and queue depth. Workspace, tab, worktree, and
last-update details remain available inside the panel. This is presentation
only and does not change runtime identity or control behavior.

## Rich-text Answer hierarchy

Rich-text Answers keep the canonical ordered timeline and Bash fenced command
blocks. Tool summaries become state-aware:

- running tools show the newest meaningful result line;
- successful tools show the final meaningful result line;
- failed tools show the first and final meaningful lines when they differ;
- omitted line counts remain explicit and all snippets pass through existing
  ANSI removal, redaction, and length bounds.

For plans of five or fewer steps, all steps remain visible. Longer plans show a
compact completion count plus only the active and failed steps, or the newest
step when neither exists. The full plan remains durable in the underlying Run
Card and progress projection.

The active `💭` motion stays content-driven. On a terminal update, the marker is
removed and a compact terminal line is appended with the final state and
duration when both timestamps are valid. Frozen continuation pages do not gain
a terminal line. Continuation titles use `第 N 页` rather than the ambiguous
`续 N` wording; total page count is intentionally omitted because earlier
frozen pages are immutable and the total is not known while streaming.

## Safety and durability

No schema or canonical-state changes are required. All changes are renderer
transforms except for passing existing phase and timestamps into the shared
rich-text planner. Existing outbox ordering, redaction, page checkpoints,
frozen-page immutability, remote-action restrictions, and five-message durable
conversation bound remain unchanged.

## Verification

Tests must prove that:

1. Answer navigation precedes recent conversation.
2. Empty Workers and Runtime are collapsed without losing controls or identity.
3. Recent conversation keeps five messages, bounds each to four lines, and
   gives the newest message the largest budget.
4. Running, successful, and failed tool previews select the intended lines and
   preserve redaction and Bash fences.
5. Long Answer plans show active/failed steps rather than an arbitrary tail.
6. Primary and Worker terminal pages show state and duration, while frozen pages
   do not.
7. Continuation titles use explicit page numbering.
8. Existing pagination, recovery, outbox, and CardKit tests remain green.

## Non-goals

- Timer-only animation or heartbeat updates.
- Expanding the five-message durable history.
- Remote approval or arbitrary terminal controls.
- Persisting presentation-only collapsed state.
- Rewriting previously frozen Answer pages.
