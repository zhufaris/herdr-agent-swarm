# Complete Commentary Preview Design

## Goal

Keep every public Assistant commentary message visible in Answer cards so the
card timeline does not silently diverge from the Herdr pane. Preserve the
existing compact presentation and exclude private reasoning.

## Display policy

- Render every canonical `agent_message` in sequence. Do not apply a global
  latest-message count limit.
- Compact each `agent_message` independently to its first 3 logical lines. If
  more lines exist, append the exact `… +N lines omitted` marker.
- Keep the existing emoji and quoted preview formatting in this change. The
  separate Assistant-versus-thinking label correction is outside this scope.
- Keep `final_answer` content complete and subject to normal Answer pagination.
- Preserve Tool emoji, nesting, result compaction, and collapsed-panel behavior.

## Data and delivery boundaries

This is a presentation-only change in the shared Answer timeline transform. It
does not alter TraeX or Herdr event parsing, canonical SQLite timeline rows,
message IDs, ordering, idempotency, page cursors, or outbox delivery. Both
Primary and Worker Answer surfaces inherit the behavior through the shared
renderer.

Only existing public `agent_message` items are eligible.
`agent_reasoning_raw_content`, protocol records, approval UI, terminal chrome,
and other private channels remain excluded upstream.

## Verification

- A timeline containing more than 3 `agent_message` items renders every one.
- Each multi-line commentary preview contains only its first 3 lines plus the
  exact omitted-line count.
- The final answer remains complete.
- CardKit and rich-text paths produce the same complete commentary set.
- Focused Answer timeline and rich-text tests, TypeScript typecheck, and the
  production build pass.
