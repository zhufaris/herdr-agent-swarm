# Complete Folded Answer Timeline Design

## Goal

Make every safe, user-relevant piece of content visible in a Herdr pane
discoverable in the corresponding Primary or Worker Answer Card sequence, while
keeping the cards readable through emoji-labelled summaries and collapsed
detail panels. Long command output must continue across cards instead of being
discarded.

This design treats Herdr as the live runtime authority and SQLite as the durable
projection authority. It does not turn Lark into a byte-for-byte terminal
mirror. Terminal chrome, reasoning, approval protocol messages, control
sequences, and secrets remain excluded.

## User-visible contract

- Assistant progress messages and the final answer render as normal Markdown.
- Every safe tool command, stdout fragment, stderr fragment, and terminal state
  that contributes to the turn remains reachable from the Answer Card sequence.
- Tool rows keep category emoji and state markers.
- The currently running tool is expanded by default. Successful tools are
  collapsed by default. Failed tools are expanded by default with a concise
  error summary first.
- A collapsed summary does not mean discarded content. Expanding the item, or
  following its continuation cards, exposes all safe persisted detail.
- Large output continues in later Answer Cards at stable source offsets. It is
  not replaced by a permanent truncation notice.
- Answer pages retain the validated 9,000-character planning limit.

## Safety boundary

The completeness promise applies after the existing safe-output boundary. The
following content is never projected merely because it appeared in the pane:

- model reasoning or hidden protocol events;
- credentials, tokens, private keys, and known secret shapes;
- raw terminal control sequences and terminal status chrome;
- approval-system protocol text that would expose or imitate local approval
  controls;
- content rejected by the existing bounded parsing and redaction pipeline.

Redaction happens before durable projection. Pagination and presentation must
operate only on redacted canonical content so a continuation cannot reveal data
that the first page suppressed.

## Canonical data model

The durable timeline remains the lossless, ordered source for card rendering. A
tool item needs a stable identity, canonical sequence, category, label, state,
command, and complete safe result content. The existing `resultPreview` field is
not sufficient as the long-term contract because it implies and currently
performs truncation. Replace that presentation-oriented concept with canonical
tool detail that can be paged.

The timeline also records optional structural provenance for nested tool calls:

```text
tool item
  id
  sequence
  parentToolId?
  category
  label
  state
  command?
  result?        complete safe output
```

Parent-child metadata is additive. Stable IDs and canonical sequence remain the
upsert key and ordering authority. Existing stored items without parent metadata
remain valid top-level items. No migration rewrites already delivered cards.

## Projection and parent-child correlation

Transcript adapters continue to normalize external events before coordinators
see them. They must capture all bounded safe tool output instead of deriving a
card-sized preview. Bounds may still protect a single observation read, but the
observer must accumulate successive safe fragments into the canonical tool
result rather than permanently dropping the tail.

Wrapped tool execution is correlated at the transcript boundary. For example,
an outer Code Mode call may contain several nested command executions. The outer
item becomes a group parent and the nested operations become children.
Correlation must use explicit event relationships when present; it must not
guess parentage from similar command strings.

If explicit parentage is unavailable, both records remain visible. Completeness
is more important than heuristic deduplication. Exact duplicate result envelopes
may be suppressed only when byte-equivalent content and a shared event identity
prove that the parent contains no independent information.

## Card presentation

The renderer produces a presentation tree without changing the canonical
timeline rows.

### Assistant content

Assistant progress and final-answer items are direct Markdown elements. They are
never placed inside an activity summary and receive priority when planning the
current page. Chronological order is preserved; priority affects page packing,
not source order.

### Standalone tools

Each standalone tool uses a collapsible panel with the existing category emoji:

- `📖 Read`
- `🔍 Search`
- `✏️ Edit`
- `⚙️ Command`
- `🧪 Test`
- `🛠️ Step`

The header contains a bounded label, state marker, and a deterministic summary
such as matched-line count, files changed, test totals, exit code, or output
size. Summary extraction is presentation-only; the canonical result stays
unchanged.

### Tool groups

A parent with visible children renders as one collapsed group, for example:

```text
🛠️ Step · 3 operations · ✓
  🔍 Search · timeline projection · ✓
  ⚙️ Command · inspect SQLite view · ✓
  🧪 Test · focused tests · ✗
```

Each child retains its own collapsible detail and complete paged output. Parent
output is omitted from display only when it is proven to be a duplicate wrapper
of child output. Independent parent output and parent errors remain visible.

### Expansion defaults

- running standalone tool or group: expanded;
- successful tool or fully successful group: collapsed;
- failed tool or group containing a failure: expanded;
- historical continuation fragments: collapsed unless they contain the first
  visible failure detail.

These defaults affect only the card view. They do not alter delivery ordering or
durable state.

## Item-aware continuation

Extend the Answer timeline cursor so tool content, like assistant Markdown, has
a stable intra-item offset. The cursor must distinguish the item and its section
without relying on rendered JSON length alone. A conceptual cursor is:

```text
{ itemIndex, section: "message" | "command" | "result", offset }
```

Compatibility decoding accepts existing `{ itemIndex, markdownOffset }` cursors
and maps them to the message section. New checkpoints use the richer form. This
allows deployment while old active or recovered pages still exist.

The page planner treats panel headers as repeatable context and tool detail as
splittable canonical text:

1. Render as much of the current section as fits under the 9,000-character
   payload limit.
2. Freeze the page only after its durable update is delivered.
3. Persist the exact next section and source offset in the page checkpoint.
4. Start the next card with the same emoji and title plus a `续` marker.
5. Continue until every safe character has been delivered.

Frozen pages remain immutable. A late transition from running to completed is
rendered through the existing late-result mechanism on a later page and links
back to the earlier item rather than patching a frozen card.

## Delivery and recovery invariants

This feature does not change prompt execution or external-effect semantics:

- Persist timeline changes before creating Lark delivery intent.
- Never replay a TraeX prompt to repair a card.
- Preserve strict per-card sequence and outbox idempotency.
- Preserve exact binding, generation, pane, session, and turn fences.
- Keep frozen Answer pages immutable.
- Resume from the durable item section and offset after restart.
- A retry may repeat only the same Lark delivery effect.
- Existing `230072` recovery and replacement-card behavior remain unchanged.

Primary and Worker workflows use the same timeline grouping, rendering, cursor,
and continuation implementation so their behavior cannot drift.

## Failure behavior

- If parent-child correlation is missing, render both items rather than hiding
  potentially unique content.
- If summary extraction fails, show a generic state and byte/line count; retain
  the complete detail.
- If one tool section cannot fit an empty page, split it at a safe Markdown or
  text boundary and continue it.
- If a result arrives after its original page is frozen, append a linked late
  result on the active page.
- If Lark rejects an update, retain the durable cursor and use the established
  recovery path; do not advance delivery coverage optimistically.
- If redaction removes content, the card may state that protected content was
  removed, but must not persist the removed value for later pagination.

## Verification

Focused tests must cover:

- complete safe stdout and stderr survive projector, SQLite reopen, pagination,
  and final card rendering;
- reasoning, secrets, ANSI controls, approval protocol, and terminal chrome do
  not enter the durable timeline;
- explicit parent and child events render once as a group while unique parent
  output remains visible;
- ambiguous nesting preserves both records;
- running, successful, and failed panels use the required emoji and expansion
  defaults;
- a tool result larger than several pages round-trips without character loss or
  duplication;
- legacy timeline cursors recover correctly and new cursors resume at the exact
  tool section offset;
- frozen pages are not patched when late tool output arrives;
- Primary and Worker workflows produce equivalent timeline pages;
- outbox retries and `230072` recovery do not advance or duplicate tool output;
- the previously observed nested Code Mode transcript no longer renders both a
  duplicate wrapper and the same child output.

Before release, run the focused projector, timeline renderer, pagination,
Primary/Worker workflow, SQLite, and recovery tests, followed by typecheck,
build, architecture checks, and the full Vitest suite. A real-user smoke check
must confirm that a long tool-heavy turn exposes all safe pane content while the
initial Answer view remains dominated by assistant prose rather than logs.

## Out of scope

- Rewriting or deleting already delivered cards.
- Mirroring raw terminal bytes or alternate-screen UI.
- Exposing reasoning or remote approval controls.
- Changing the 9,000-character Answer page limit.
- Changing prompt FIFO, steering, replay, lease, or outbox ordering semantics.
- Installing, restarting, or deploying the service as part of implementation.
