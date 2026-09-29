# Rich-Text Answer Streaming Design

## Goal

Render Primary and Worker Answer output as ordinary Lark rich-text messages
instead of CardKit cards while preserving the existing typewriter experience,
durable delivery, pagination, recovery, and exact-turn fencing.

Main, status, model, pane, and interaction surfaces remain CardKit cards. New
Answer pages prefer Herdr's native pane token only where identity is already
shown by those surrounding cards; the rich-text Answer itself contains no card
header or runtime metadata.

## User experience

- Each Answer page is one ordinary Lark `post` message in the existing thread.
- The active page is edited in place. It is not replaced by a sequence of new
  messages.
- Updates occur only at Markdown-safe boundaries. Incomplete fenced code,
  inline code, links, tables, or other compound constructs are buffered.
- The active page ends in `▌`. Terminal completion, interruption, or failure
  removes the cursor immediately.
- Agent prose and tool activity retain timeline order. Tool calls and command
  results become compact rich-text quotes and code blocks rather than CardKit
  collapsible panels.
- A frozen page is immutable. Continuation content is written to a new rich-text
  message with a light `回答（续 N）` marker.
- Completed output has no redundant success footer. Interrupted and failed
  output retains delivered content and adds a short terminal-state note.

## Architecture and flow

The canonical answer timeline remains in SQLite and is never reconstructed from
Lark output:

```text
Herdr/TraeX events
  -> canonical answer timeline
  -> Answer Page planner
  -> safe Markdown page and platform-neutral rich-text document
  -> durable outbox
  -> Feishu reply/update of an ordinary post message
```

Projectors reserve delivery intent before invoking Lark. Observers never update
messages directly. Delivery retries therefore repeat only the message effect and
never the Agent prompt.

The gateway contract gains transport-neutral rich-text reply and update intents.
The Feishu gateway maps those documents to `msg_type: "post"`. The Lark adapter
uses `im.v1.message.reply` to create a threaded page and
`im.v1.message.update` to replace its content. Card updates continue to use the
existing card-specific path.

## Rendering and typewriter policy

The renderer produces a platform-neutral document from a safe prefix of the
canonical Markdown timeline. The Feishu renderer supports paragraphs, emphasis,
links, lists, quotes, and code blocks. Unsupported structures degrade to readable
text or closed code blocks rather than invalid post JSON.

An active page is eligible for refresh when any of the following is true:

- at least one second passed and about 48 new visible characters are available;
- a useful paragraph, list item, or complete table-row boundary is reached;
- the page must freeze; or
- the turn enters a terminal state.

The one-second floor keeps normal streaming well below Lark's shared 5 QPS group
limit. Multiple unclaimed updates for the same page use latest-snapshot-wins
coalescing. Claimed or uncertain effects remain durable and are followed by a
newer full snapshot when necessary.

Until the first safe fragment exists, the page displays `正在生成… ▌`. A long
open code fence leaves the last safe snapshot visible until it closes. If one
closed code block exceeds the page budget, the planner splits it on complete
code lines and emits independently closed code blocks.

## Pagination

The initial source budget remains 9,000 characters, with an additional bound on
the serialized rich-text payload. Splits occur only at safe Markdown and Unicode
boundaries. The planner records the exact source/timeline cursor represented by
each delivered snapshot.

When a page fills, one transaction reserves its final cursor-free update,
freezes the page, and reserves creation of the next page. The next page begins at
the first source position not confirmed on the frozen page. Frozen pages are
never patched by later projection, recovery, or late events.

## Persistence and outbox

`AnswerPageDeliveryMode` gains `rich_post`. Existing `streaming` and `static`
pages remain valid and continue through the legacy CardKit recovery path. A
schema migration rebuilds the `answer_pages` check constraint without rewriting
page identities or remote messages.

For a `rich_post` page:

- `messageId` is the remote message identity;
- `cardId` is null;
- the legacy non-null `elementId` stores a stable logical page slot and is never
  sent to Lark; and
- `sequence` identifies successive complete snapshots.

The new outbox operations are rich-text reply and rich-text update. Page creation
uses a stable `answer-post:<turn>:<page>` idempotency key. Updates share a stable
projection key and use increasing snapshot revisions. Delivery coverage and
timeline cursors advance only after a successful gateway checkpoint.

Both Primary and Worker Answer workflows use the same page planner and delivery
semantics. Existing in-flight CardKit pages retain their original delivery mode;
only newly created pages default to `rich_post`.

## Recovery and failure behavior

- A `creating` page retries its idempotent reply until a message ID is
  checkpointed.
- An `active` page is regenerated from the canonical timeline and last delivered
  cursor after restart.
- Retrying a rich-text update is semantically idempotent because it replaces the
  complete message body.
- Target validation checks the binding or Worker generation, exact turn, page,
  active state, and message ID before every update.
- If an active remote message is missing or permanently uneditable, recovery
  freezes that page and creates a replacement starting at the last confirmed
  cursor.
- A terminal turn with an undelivered final snapshot resumes only that message
  update. It never resubmits the Agent prompt.
- Frozen pages are not recovery targets; recovery can only create a continuation.

## Code boundaries

- `src/runtime/`: safe Markdown checkpoints, pagination, and rich-text document
  construction.
- `src/domain/`: delivery intents, `rich_post` page mode, and lifecycle rules.
- `src/gateways/feishu/`: conversion from the neutral document to Feishu post
  JSON.
- `src/adapters/lark-adapter.ts`: explicit rich-text reply and update methods.
- `src/store/`: atomic page reservations, snapshot coalescing, checkpoints, and
  recovery links.
- `src/events/`: shared Primary and Worker Answer convergence.
- `src/cards/`: unchanged current cards plus legacy Answer renderers for existing
  CardKit pages.

## Verification

Focused tests cover safe Markdown boundaries, Unicode, incomplete and oversized
code blocks, tables, rich-text conversion, adapter reply/update calls, schema
migration, snapshot coalescing, delivery checkpoints, frozen-page fencing,
replacement recovery, and Primary/Worker integration. Regression tests cover
existing cards, native pane-token display, and legacy CardKit Answer recovery.

Before handoff, run the affected Vitest files, the full test suite,
`npm run typecheck`, and `npm run build`.
