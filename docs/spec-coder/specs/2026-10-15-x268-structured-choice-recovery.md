# Structured choice recovery across commentary and final events

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Pane `x268` produced one complete version-2 `herdr-choice-list` protocol in a
Core `commentary` message, followed by a `final` message containing the visible
answer and invocation marker but no protocol JSON. The projector removed the
protocol from visible Markdown as intended, but it also lost the choice
metadata: no `completion_choice_specification` or `completion_action_set` was
created, so Feishu had no structured buttons to render.

HTML or visible Markdown must not become the authority for actions. Both are
presentation formats and may be normalized or stripped before CardKit delivery.

## Solution

At the Core-event normalization boundary, inspect bounded terminal choice
protocol text once and convert a valid version-2 Human Review into the existing
`FinalMessageCompletionChoice` struct. `HerdrEventProjector` retains the latest
valid structured choice for the current turn. A later marker-only final message
may reuse that same-turn struct; downstream Segment, completion-action and
CardKit code continues to consume only structured metadata.

Core-native `payload.completionChoice` has highest priority. A valid protocol on
the current message is second. Previously captured same-turn metadata is only a
fallback. A valid `intent: "none"` explicitly clears any pending Human Review.
`turn_started` clears all prior-turn choice state.

## User Stories

### SCN-1: A marker-only final retains a same-turn structured choice

When commentary contains one valid fenced v2 Human Review and the following
final contains only the visible answer plus invocation marker, turn completion
exposes the choice as `turnLifecycle.completionChoice`. Visible Markdown contains
neither the JSON protocol nor the marker.

### SCN-2: Native structured metadata remains authoritative

When a final Core event already carries `payload.completionChoice`, that value
wins over any earlier commentary-derived choice in the turn.

### SCN-3: Intent none and new turns clear stale actions

A valid v2 `intent: "none"` clears an earlier same-turn Human Review, and a new
turn starts with no retained choice. Ordinary commentary without a valid
terminal protocol never creates action metadata.

## Implementation Decisions

### Domain Model

Reuse `FinalMessageCompletionChoice`; do not introduce a second action schema.
Add one pure conversion from a valid `TraceEndReviewDecision` to the final-message
struct. Version 1 compatibility choices are not promoted through this recovery
path. Invalid, incomplete, oversized or nonterminal protocol text remains
non-authoritative.

### Architecture

Protocol parsing remains in `domain/completion-choice.ts`. Turn-local precedence
and lifecycle state remain in `runtime/herdr-events/event-projector.ts`.
Persistence and CardKit renderers are unchanged because they already consume the
structured choice contract.

### Behavior & Failure Modes

The protocol is still stripped from visible content. Recovery is bounded by the
existing 8 KiB protocol parser and current turn snapshot. Invalid protocol fails
closed without buttons. No HTML, Markdown node or renderer-side JSON parsing is
added.

### Compatibility & Migration

No schema migration is required. Core events already carrying structured choice
metadata preserve their behavior. Existing intent-none and malformed-protocol
semantics remain unchanged.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3

Add an exact x268 event sequence to `tests/herdr-event-projector.test.ts`:
commentary with complete fenced protocol, final with marker only, then
`turn_completed`. Assert visible text is clean and structured metadata survives.
Add precedence, intent-none clearing, new-turn reset and ordinary-commentary
negative tests. Run choice protocol/projector suites, typecheck, build,
architecture check and the full Vitest suite.

## Out of Scope

Do not change Feishu CardKit button rendering, completion-action persistence,
the plugin installation lifecycle, mention authorization, visible Markdown or
HTML rendering, production database rows, or historical x268 messages.

## Further Notes

Workspace: `<repo-root>/.trae/worktrees/fix/stop-active-turn-deploy`.
Starting revision: `05626232ed5d53346e9d9d92f6a088d43211aaf4`.
Baseline records captured in this request: focused tests
`15b1bf2320ed4ef3996108c0d18b7ca8`, typecheck
`dd5edc4923ab4c35bfa8cd4b165c11c2`, build
`c3dbaee0881049efb25654efcdf88eb4`.

Gate 1 design choice: parse once at the Core-event boundary and carry the
existing struct downstream; never make HTML or visible Markdown authoritative.
