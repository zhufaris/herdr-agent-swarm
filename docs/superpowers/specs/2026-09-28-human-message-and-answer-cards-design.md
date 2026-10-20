# Human Message and Answer Cards Design

> **Superseded (2026-10-04):** The unified Human Turn Card design is the
> current behavioral authority. This historical document is retained for
> migration and rationale only.

> Updated on 2026-09-29. The standalone `👤 Human message` card described by
> the original proposal is not part of the active design. The original Feishu
> message remains the visible request record. Direct Herdr messages remain
> canonical timeline facts but are represented visually by the Answer's compact
> `Reply to 👤` header subtitle rather than a repeated body element.

## Goal

For every human message accepted for execution in Herdr, show the input as its
own Lark CardKit card and show all resulting Answer cards as an explicit reply
to that input. Long answers may continue onto further cards without losing the
human-message context.

## Scope and non-goals

This applies to every accepted Prompt, including normal FIFO work, priority
work, and an externally observed Herdr turn that is adopted into a Prompt. It
does not change prompt admission, FIFO ordering, turn ownership, transcript
selection, remote-control permissions, or the content of the prompt submitted
to Herdr.

The new input card is not a transcript timeline item and is not a replacement
for the Answer card. It is a durable presentation of the Prompt's original
human text.

## Card model

One accepted Prompt produces one independently durable Answer sequence:

1. The **Answer Card** title is
   `<space-name> / <native-pane-token>`. It never substitutes
   the internal Pane ID for a missing token; the placeholder is `—` until
   runtime convergence backfills the native token.
2. The header subtitle is `Reply to 👤 <human-message summary>`.
3. Every continuation Answer Card repeats the same identity and reply summary,
   and appends its page number to the title.

The summary is a single-line, redacted, whitespace-normalized prefix of the
original Prompt. It is bounded conservatively for a CardKit header and ends in
an ellipsis when truncated. The original Feishu message is the authoritative
visible copy of a Feishu request; the Answer subtitle is the stable orientation
cue for either origin. A direct Herdr request is additionally retained as a
canonical `human_message` timeline fact, but is not rendered again in the body.

## Durable delivery and recovery

Prompt acceptance persists the original request in the Run Card projection and
reserves the ordinary Answer Card intent. Direct Herdr turns use the same
projection and outbox path after exact-turn adoption. Retries replay only the
unacknowledged Lark delivery effect and never resubmit a prompt to Herdr.

Answer pages retain their existing per-page identities, streaming state,
frozen-page rules, and canonical source cursors. Header and subtitle changes are
presentation-only and do not alter recovery evidence or page checkpoints.

## Rendering and limits

The reply summary is flattened to one line, redacted, and bounded to the Header
limit. `human_message` events remain persisted but do not produce Answer body
elements. The page cursor consumes them in canonical order, so they cannot
create empty continuation cards or shift frozen-page checkpoints. Agent
messages, final answers, and Tool panels keep their current ordering and
rendering. No reasoning, protocol text, or sensitive value bypasses existing
sanitization.

## Implementation seams

- Build the Answer title from the projected Space name and native Pane token;
  retain Pane ID only in internal ownership/fencing fields and body diagnostics.
- Render the request summary through one redacted, bounded helper for initial,
  streaming, static, recovered, and continuation pages.
- Resolve the configured Space name when adopting direct Herdr turns so their
  initial Answer Card never begins with `unknown`.
- Keep startup convergence responsible for backfilling a later-observed native
  Pane token into actionable Run Card projections.

## Verification

Focused tests will establish that:

- Answer titles prefer the native token, omit the duplicate Prompt title, and
  never expose the internal Pane ID;
- a missing token displays `—` until runtime convergence backfills it;
- Answer headers on running, completed, static-recovery, and continuation
  pages retain the same `Reply to 👤` summary;
- multiline, oversized, and redactable human text is safe in the summary, with
  no raw secret-like value leaked;
- direct Herdr turns persist the configured Space name and native token;
- canonical Human items remain stored but do not render or force a page break;
- restart/outbox recovery preserves ordering, page immutability, and existing
  Answer delivery semantics.

Validation will run the affected Vitest files, `npm run typecheck`, and
`npm run build`; the full Vitest suite is required because this changes the
shared Prompt projection and outbox contract.
