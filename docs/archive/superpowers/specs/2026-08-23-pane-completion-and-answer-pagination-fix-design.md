# Pane Completion and Answer Pagination Fix Design

## Goal

Prevent Feishu requests from appearing unresponsive when Herdr reports a TraeX
pane as `unknown`, and preserve the newest output by rolling long Answer streams
into continuation cards instead of truncating cumulative content. This document
narrows and amends the terminal streaming Answer-card design.

## Unknown-state completion

After prompt text is visibly confirmed and Enter is delivered, the turn is known
to have been submitted. Structured Herdr states remain authoritative when they
are available: `working` and `blocked` keep the turn open, while an observed
transition to `idle` or `done` completes it.

Herdr can report `agent_status: unknown` for an entire successful turn. In that
case the bridge must not require observing a short-lived `working` marker. It
completes only when all of these fallback signals agree:

- terminal output changed after submission;
- the TraeX idle composer is visible again;
- multiple consecutive polls show the same completed screen; and
- process metadata shows no active turn helper beneath TraeX.

A visible approval or blocked prompt keeps the turn open. A transient redraw,
unchanged pre-submit screen, or active helper also keeps it open. If neither the
structured state nor the fallback proves completion, the existing turn timeout
fails the prompt explicitly. This releases the binding worker so queued messages
can continue in FIFO order.

## Frozen-page Answer chain

Each prompt initially creates one Answer card and no duplicate Request card. Its
delivery state is an ordered chain of Answer pages. Exactly one page is active;
earlier pages are frozen. Each page persists:

- page index and lifecycle (`active`, `freezing`, or `frozen`);
- CardKit card ID, Feishu message ID, and fixed Markdown element ID;
- monotonically increasing CardKit sequence; and
- canonical Answer-stream start and delivered offsets.

The active page is updated with its full current page snapshot. Before it reaches
the configured safe CardKit element limit, the bridge splits at a Markdown-safe
newline boundary, flushes and finishes the current page, marks it frozen, creates
the next continuation card, and streams the unsent remainder there. All newly
arriving output goes to the newest page. Frozen pages are never rebalanced or
patched again, so the newest message cannot disappear through tail truncation or
an older retry.

If a code fence crosses a page boundary, rendering adds a closing fence to the
old page and the matching opening fence to the new page. These synthetic markers
do not advance canonical source offsets. The cumulative sanitized Answer remains
the source of truth and is never sliced merely to satisfy a single-card limit.

## Durable rollover

Continuation creation uses a stable idempotency key derived from prompt ID and
page index. A page does not become frozen and its delivered offset does not
advance until its final content is acknowledged. If the next card cannot be
created, the remainder stays pending in the durable outbox. Retry reuses the same
page index and cannot create duplicates or overwrite a newer page.

On completion or failure, pending content is flushed before streaming is turned
off on the active page. Restart restores page, sequence, and offset state without
re-appending acknowledged content. A retrying page must not block unrelated
bindings. Existing legacy cards finish through their current path and are not
converted in place.

## Verification

Tests must prove:

1. An `unknown` pane completes after a submitted turn changes output, returns to
   a stable idle composer, and has no active helper, even if `working` was missed.
2. Redraws, unchanged output, approvals, and active helpers cannot trigger the
   fallback completion path.
3. Completing the active turn releases its binding worker and drains queued turns
   in FIFO order.
4. A new prompt initially creates one Answer card and no Request card.
5. Content beyond one page freezes the old card and sends the exact unsent
   remainder plus all latest output to a continuation card without truncation.
6. Markdown fences remain renderable across page boundaries without corrupting
   canonical offsets.
7. Continuation creation, retries, and restart are idempotent and preserve page
   and sequence order.
8. Completion flushes the newest page before finishing streaming.
9. Focused tests, the full suite, typecheck, and build pass.
