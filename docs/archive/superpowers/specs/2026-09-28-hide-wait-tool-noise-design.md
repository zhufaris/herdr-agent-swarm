# Hide Wait Tool Noise from Answer Timelines

## Problem

TraeX and native Herdr event sources classify polling calls such as `write_stdin`, `wait`, and `wait_agent` as `Wait`. The downstream activity projection currently falls back to the generic `step` kind, so Answer cards render internal orchestration checkpoints such as `Step · write_stdin · ✓`. These rows provide no user-visible work result, consume timeline and pagination space, and may appear twice as running and completed states.

## Decision

Filter the complete `Wait` category at the transcript/event projection boundary. A `Wait` call and every paired result remain usable only as source-protocol bookkeeping; neither produces `toolActivities` nor `timelineDeltas`. The canonical SQLite Answer timeline therefore never stores these internal polling rows.

The rule applies consistently to both structured TraeX transcripts and native Herdr agent events. It covers `write_stdin`, `wait`, and names containing `wait_agent`, which are already classified as `Wait` by `tool-activity-projector`.

## Preserved behavior

- Commands, tests, reads, searches, edits, skills, agent operations, and unknown tools remain visible under their existing rules.
- Waiting does not suppress public Assistant commentary emitted before or after the wait.
- The paired-call descriptor is retained long enough to recognize and ignore later Wait results safely.
- Historical timeline rows already persisted as `step` are not rewritten. The change affects new observations and replay from canonical transcripts/events.

## Implementation boundary

Expose one shared predicate from `tool-activity-projector` that answers whether a descriptor is user-visible. Both TraeX and native Herdr projectors use it before producing activity or timeline output. Keeping the policy beside classification prevents the two sources from drifting and avoids presentation-only filtering.

## Verification

Regression tests will feed a `write_stdin` call plus active and completed results through both projectors and assert that no Tool activity or Answer timeline item is emitted. Existing classification tests continue to prove that the call is recognized as `Wait`, and existing visible Tool tests protect the retained categories.
