# Turn Card Unique Element ID

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

A Primary Turn Card can render the same content twice inside one Feishu card.
The durable inbound, Conversation Segment, and outbox evidence is not duplicated:
each input has one Segment, one `card_reply`, one Feishu message identity, and
one copy of each canonical timeline item. The duplication is introduced while
rendering one card.

`attachElementId` descends into a nested panel, assigns the page element ID to
its first markdown node, then continues the outer loop and assigns the same ID
to the next top-level markdown node. The resulting Gateway view and CardKit
payload contain two distinct elements with the same `element_id`. CardKit
streaming or replacement therefore has an ambiguous update target and can show
duplicated content inside the card.

## Solution

Make Turn Card element-ID attachment stop after the first markdown node found
across the entire recursive tree. The traversal returns whether a nested node
was updated, and every caller stops immediately after that success. This aligns
Primary Turn Card behavior with the already-correct Worker Turn Card traversal.

The change preserves the existing Conversation Segment, projection, outbox,
Gateway view, CardKit delivery, pagination, and streaming contracts. It does
not deduplicate canonical items or suppress legitimate panels; it only enforces
unique ownership of the page's streaming element ID.

## User Stories

### SCN-1: Nested thinking followed by assistant content

When a Turn Card timeline contains a thinking panel whose nested markdown is
followed by a top-level assistant markdown item, exactly one rendered markdown
element carries the page `element_id`. Both pieces of visible content remain in
their original order.

### SCN-2: CardKit update materialization

When the provider-neutral Gateway view is converted to CardKit, the page
`element_id` occurs exactly once, so a `surface.replace` update has one
unambiguous target and does not repeat content inside the card.

### SCN-3: Timeline without nested markdown

When the first eligible markdown is top-level, it continues to receive the
page `element_id`; cards without any markdown remain unchanged.

## Implementation Decisions

### INV-1: A Turn Card page owns one streaming element ID

For one rendered Turn Card page, the page-level `element_id` appears zero times
when no markdown exists and exactly once when at least one markdown exists.
Nested containers do not create another owner.

### INV-2: Canonical timeline content is not deduplicated

The renderer must retain every canonical timeline item and its ordering. It may
not hide repeated-looking tool titles or collapse separate human/agent items to
work around the CardKit identity defect.

### ARCH-1: The rendering module owns identity attachment

`src/cards/turn-card.ts` owns recursive attachment while constructing the
provider-neutral view. Gateway and Feishu adapters continue to translate
`slot` to CardKit `element_id` without compensating for malformed input.
Dependencies remain inward: card rendering does not acquire SQLite, Lark SDK,
or coordinator dependencies.

### ARCH-2: Reuse the proven recursive contract

The traversal uses the same boolean success contract already present in
`src/cards/worker-turn-card.ts`: direct success returns `true`; nested success
is propagated; exhaustion returns `false`. No new abstraction or shared helper
is introduced for this single-call-site repair.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, INV-1, INV-2, ARCH-1, ARCH-2

Extend the public `renderTurnCard` seam in `tests/turn-card.test.ts` with a
timeline containing nested thinking markdown followed by top-level assistant
markdown. Before the fix, assert the regression test fails because two nodes
carry the same page `element_id`; after the fix, assert exactly one occurrence
while both content nodes remain visible and ordered.

Use the existing Gateway view/CardKit conversion test seam to assert the
materialized CardKit payload also contains the page `element_id` exactly once.
Run the focused Turn Card and Gateway view suites, TypeScript typecheck, build,
architecture checks, and the full Vitest suite before delivery.

## Out of Scope

- Coalescing separate user inputs or Conversation Segments.
- Removing repeated-looking but distinct tool panels.
- Changing CardKit streaming, pagination, or outbox retry semantics.
- Choice-list, mention, latency, backlog, or historical recovery optimization.
- Modifying TraeX or Herdr Core.

## Further Notes

Prepared workspace: `/tmp/herdr-agent-swarm-main-merge-20261012`, in-place on
branch `fix/turn-card-duplicate-element-id` from
`3c342d930e4ff817746b17d759bffa7ababfc23c`. The workspace was clean before
planning and contains no unrelated changes.

Fresh baseline evidence observed in this request:

- `npx vitest run tests/turn-card.test.ts tests/gateway-view.test.ts` passed
  2 files and 37 tests.
- `npm run typecheck` passed.

Gate 1 design was approved by the user's urgent `continue` instruction after
the bounded repair design was presented. No implementation, merge, install,
restart, push, or deployment is authorized by this specification alone.
