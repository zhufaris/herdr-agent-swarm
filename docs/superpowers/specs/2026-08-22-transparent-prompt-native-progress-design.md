# Transparent Prompt and Native Progress Design

## Goal

Text sent from a Feishu thread must reach the Herdr Pane unchanged. If the user
sends `继续`, the visible TraeX input must be exactly `继续`, without bridge
control markup or hidden prompt suffixes.

## Prompt delivery

The coordinator passes the persisted prompt body directly to
`HerdrPort.runPrompt`. The bridge no longer appends `<herdr_control>` or asks the
model to emit `<herdr_progress>` blocks. Persisted prompt text, Request-card text,
and Pane input therefore share one user-authored source of truth. Steering
continues to use the same unchanged-text rule.

## Native progress extraction

The output parser derives optional structured steps from TraeX's native task
frame. A recognized frame contains a bounded task summary such as
`9 tasks (7 done, 1 in progress, 1 open)` followed by rows prefixed with native
status glyphs. Completed, active, pending, and failed glyphs map to the existing
RunCard step states. Labels are bounded, empty rows are ignored, and at most 20
steps are accepted.

Native progress is observational, not required. When the frame is absent or
cannot be parsed, the Request card displays its existing lifecycle fallback. A
malformed frame never changes prompt delivery or prevents the answer from
completing.

## Answer and project cards

Recognized native task frames stay out of Answer prose and project-card latest
message previews. Their steps appear only on the Request card. Ordinary
intermediate messages continue to accumulate within the current turn, while a
refresh of the same native status frame replaces the previous snapshot.

## Compatibility and safety

The parser temporarily continues to understand historical `<herdr_progress>`
blocks that may already exist in a running Pane or persisted output, but the
bridge no longer generates them. This compatibility is read-only and can be
removed after old terminal buffers have aged out.

No persistence migration is required. Queueing, steering, answer-card in-place
updates, credential filtering, cross-group checks, and final-answer persistence
remain unchanged.

## Verification

Tests verify that the exact user text reaches `runPrompt`, no control markup is
added, native task rows become structured steps, native frame refreshes replace
rather than append, ordinary intermediate messages still accumulate, malformed
or absent frames fall back safely, and the complete suite, typecheck, and build
remain green.
