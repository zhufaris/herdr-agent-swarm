# Transcript Projector Turn-State Optimization

## Scope

Bound transcript projector deduplication memory to the current TraeX turn without changing transcript identity, output filtering, or lifecycle behavior.

## Design

`TraexTranscriptProjector` treats `emittedItemIds`, `emittedUserMessageIds`, and `callsById` as per-turn state. On a validated `task_started` event, all three collections reset together before subsequent events are projected. Duplicate item IDs remain suppressed within one turn, while a later turn can safely reuse an ID without being hidden by stale state.

The reset is attached only to the existing validated `task_started` boundary. Completion and abort behavior remain unchanged, and no persistent or cross-cursor state is introduced.

## Verification

- Prove duplicate assistant items in one turn remain suppressed.
- Prove an item ID reused after a new `task_started` boundary is emitted for the new turn.
- Run focused transcript tests, typecheck, build, `git diff --check`, and the full suite.
