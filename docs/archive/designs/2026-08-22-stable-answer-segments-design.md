# Historical: Stable Answer Segments Design

> Superseded by the current terminal-stream and continuation-page behavior. This
> record is retained for decision history and must not be treated as current.

## Goal

Keep intermediate TraeX messages visible in the Feishu Answer card without the
card oscillating between a short current fragment and the entire accumulated
answer. The card remains one in-place-updated Feishu message.

## State model

Each request projection separates visible answer state into two parts:

- `answerSegments`: completed intermediate messages in display order;
- `answerDraft`: the currently growing TraeX message.

The persisted `answer` field remains the rendered aggregate for backward
compatibility and existing rows. New reducer logic owns segment transitions and
derives the visible aggregate. No database schema migration is required.

Every new request starts with empty segments and an empty draft. State never
crosses a prompt boundary.

## Observation semantics

The output parser classifies an observation as one of three operations:

1. `replace-draft`: more characters arrived for the current `◆` message. The
   draft is replaced, while stable segments remain unchanged.
2. `commit-and-replace`: a new `◆` message appeared. The prior non-empty draft
   is committed once, then the new message becomes the draft.
3. `replace-status`: a recognized native TraeX task/status frame refreshed. It
   replaces the transient draft and is never committed into answer history.

The parser also returns the previous visible block so the reducer can safely
replace a draft after terminal wrapping or sampling changes. Identical
observations are no-ops. Unknown ordinary prose is preserved.

## Completion

On `TurnCompleted`, the reducer commits the current non-status draft, then adds
the final answer only if it is not already the last committed message. This
prevents the final message from appearing twice. A completion event never
imports text from a previous prompt.

Blocked state does not discard segments or the draft. If execution resumes, the
same turn continues updating its draft. Failed state keeps already observed safe
messages and displays the existing failure notice.

## Rendering and bounds

The Answer card renders stable segments followed by the current draft. Native
status and todo frames are excluded from prose. The existing 12,000-character
newest-tail limit applies to the assembled render copy: truncation removes the
oldest stable content first and never mutates persisted state.

The project main card derives its latest concise message from the newest visible
draft or, when there is no draft, the last stable segment. Request cards remain
limited to original request, structured plan, status, warnings, and duration.

## Ordering and delivery

Events for the same binding must be reduced in publication order. The concurrent
reliability work that serializes projector handlers per binding provides this
ordering boundary and is retained. Different bindings may continue projecting
concurrently. The existing two-second scheduler may coalesce visual refreshes,
but the latest projected card always contains every stable segment plus the
latest draft.

No new Feishu messages are created. Task and Answer cards keep their existing
message IDs and outbox idempotency behavior.

## Compatibility and safety

Existing rows that contain only aggregate `answer` text are treated as one
stable segment when first updated, so deployment does not erase an active card.
Unsafe output filtering remains before state reduction. Cross-group protection,
queue ordering, steering, Markdown normalization, and credential filtering are
unchanged.

The separate transparent-prompt change may replace synthetic progress injection
with native task parsing, but it is not required for stable answer segments and
must be committed independently.

## Verification

Tests at the parser, reducer, renderer, and event-projection seams verify:

1. growth of one message replaces only the draft;
2. a new message commits the prior draft exactly once;
3. native status refreshes never enter stable history;
4. completion preserves intermediate messages without duplicating the final one;
5. a new prompt starts with no prior-turn segments;
6. scheduler coalescing still renders all accumulated messages in one Answer card;
7. the 12,000-character newest-tail bound remains valid; and
8. the full suite, typecheck, build, and live readiness checks pass.
