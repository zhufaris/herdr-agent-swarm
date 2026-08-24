# Conversational Request and Answer Cards

## Goal

Make the per-prompt Request and Answer cards read as a natural conversation in
Lark while retaining the operational context needed to understand a running
TraeX turn. This redesign is visual only: it must not change prompt dispatch,
answer streaming, pagination, card identity, or lifecycle semantics.

## Scope

The change covers only `renderRequestRunCard` and `renderRequestAnswerCard`.
Project entry, directory, help, model, operations, disconnected-topic, and pane
close cards keep their current presentation.

## Visual hierarchy

### Request card

The request card represents the user side of the exchange. Its header is
`💬 你的请求`, with a compact subtitle containing the bounded task title. The
request text is expanded and immediately readable rather than hidden inside a
collapsed panel. A quiet metadata line follows the content:

```text
<status icon> <status>  ·  Pane <pane id>  ·  <queue position or elapsed time>
```

Queued requests show their queue position. Completed requests show elapsed
duration when available. Other phases omit a missing value rather than showing a
placeholder. Blocked and failed notices remain visually prominent callouts.

### Answer card

The answer card represents the agent side. Its header is `✨ TraeX 回复`; pages
after the first use `✨ TraeX 继续回复 · N`. Page numbering is open-ended and does
not show a total because the final number of cards is unknown while streaming.
The bounded task title remains in the subtitle so adjacent conversations are easy
to distinguish.

The answer body starts with one compact metadata line:

```text
<status icon> <status>  ·  Pane <pane id>  ·  <elapsed time when available>
```

The response content follows after a divider and remains the visual focus. The
first answer card and every continuation card contain only their own answer
segment. No card copies prior pages or earlier prompts.

## State treatment

Existing phase colors remain semantic and consistent across the pair:

- queued and running: blue;
- blocked: orange;
- completed: green;
- failed: red.

Existing phase labels and icons remain the source of truth. The redesign removes
the all-caps `HERDR REQUEST` and `HERDR ANSWER` treatment from these two cards,
but does not change summary text used by Lark notifications.

## Streaming and pagination invariants

- The answer markdown element keeps its existing stable CardKit element ID.
- `streaming_mode` and `update_multi` remain enabled exactly as required by the
  current publisher.
- Active-card updates continue to replace only the current draft.
- Completed pages remain immutable; a new page uses the next positive page
  number with no fixed upper bound.
- Empty running and queued answers retain a concise waiting placeholder.
- Blocked and failed notices remain attached to the active answer content.
- Markdown normalization, secret redaction, native-task-frame removal, and length
  limits remain unchanged.

## Implementation boundary

The renderer owns presentation. Small shared helpers may format the metadata line
and page-aware title, but no new persisted fields or coordinator events are
required. Existing `RunCardView` values supply phase, pane ID, queue position,
start time, finish time, title, and answer content.

## Verification

Automated tests must demonstrate that:

1. Request content is visible without a collapsible panel.
2. Request and Answer cards use the conversational titles.
3. Both cards show a single compact phase-and-pane metadata line.
4. Queued Request cards show queue position and completed cards show duration.
5. Continuation Answer cards use `继续回复 · N` for arbitrary `N`.
6. Answer cards preserve the stable answer element ID and contain no request text.
7. Blocked and failed states retain their notices and semantic colors.
8. Existing answer segmentation, truncation, and streaming tests remain green.

Live verification should send two consecutive prompts in one bound topic and one
answer large enough to create continuation cards. The cards should read as a
user/TraeX exchange, and no continuation or later prompt may repeat earlier
answer content.
