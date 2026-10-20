# Answer Card Token and Choice Fallback

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Two visible-card projection gaps remain. First, historical `run_cards` rows can
have a null `pane_token` after the Binding later receives its native Pane
token. `answer-card-header` correctly renders `RunCardView.paneToken`, but the
current `run_cards_view` JSON reads only the stale row column, so Answer Cards
show `—`. The live database contains historical examples of this shape.

Second, a valid terminal `herdr-choice-list` protocol with `intent: "none"`,
or a valid protocol with no actionable choice, currently clears choice state.
No durable completion choice specification is persisted, so the completion
choice card and its buttons are absent. Ordinary answers without a terminal
choice protocol must remain unchanged.

## Solution

Add two bounded projection fallbacks:

1. Rebuild `run_cards_view` so its serialized `paneToken` uses the stored Run
   Card token first, then the exact same-generation Binding token. Existing
   rows are repaired at read/projection time without a bulk SQLite data write;
   generation mismatch remains null.
2. Normalize a valid terminal no-choice decision into one durable default
   `ChoicePrompt`: option id `continue`, label `继续`, submit text `continue`,
   and a bounded continue question. Persist it through the existing completion
   choice store so normal action-set and choice-card rendering produces one
   Continue button. Preserve the protocol-owned no-choice decision as that
   Continue prompt while visible Markdown is projected without the fence, so
   attached and detached recovery paths retain the same durable signal.
   Explicit actionable choices retain their exact order and semantics;
   non-protocol answers do not gain a button.

## User Stories

### SCN-1: Render a historical Answer Card with current Pane identity

When a Run Card's stored token is null but its exact binding generation has a
current Binding token, loading the Run Card and rendering an Answer Card shows
the current token. A different Binding generation does not leak its token.

### SCN-2: Show a Continue choice for a terminal no-choice protocol

When final trace normalization yields valid `intent: "none"` or a valid
no-actionable-choice decision, completion normalization persists one Continue
choice and the existing choice-card renderer displays its button. Selecting it
continues through the existing durable completion-action path.

### SCN-3: Preserve explicit choices and ordinary answers

Existing actionable choices remain unchanged. A normal final answer without a
terminal choice protocol remains without a completion choice card. Duplicate
normalization remains idempotent and does not create a second action set.

## Implementation Decisions

### INV-1: Pane token fallback is generation-fenced

`run_cards_view` may fall back from `run_cards.pane_token` only to
`bindings.pane_token` where `bindings.id=run_cards.binding_id` and
`bindings.generation=run_cards.binding_generation`. It never uses a nearby or
newer Binding generation.

### INV-2: Continue fallback is protocol-scoped and durable

Only a valid terminal choice protocol with no actionable choice receives the
synthetic Continue prompt. The projector and Core-lane fold preserve that
protocol decision as the shared Continue prompt until the SQLite completion
choice store persists it through the existing completion-choice
specification/action-set transaction and callback identity. Invalid or ordinary
answer text is not upgraded.

### ARCH-1: Existing projection and choice owners remain authoritative

The SQLite projection view owns Run Card read compatibility; the completion
choice store owns normalization and persistence; CardKit renderers remain
presentation-only. No new schema, transport, or external API is introduced.

### ARCH-2: Fallbacks are read/projection compatibility, not live repair

The service does not bulk-update historical `run_cards` rows or send a test
card. A normal future projection may persist a resolved token naturally, while
the view fallback makes old cards readable immediately.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, INV-1, INV-2, ARCH-1, ARCH-2

Use the existing SQLite projection seam to load a Run Card with a null stored
token, a same-generation Binding token, and a mismatched-generation Binding;
assert the view fallback and fence. Use the existing completion-choice protocol
and durable interaction seams to assert intent-none/empty-choice normalization,
Continue card button payload, idempotent reopen, explicit-choice preservation,
and ordinary-answer rejection. Run the focused suites, typecheck, build,
architecture check, and full Vitest delivery suite. Cover attached projection
and Core-lane detached recovery so the decision survives removal of the visible
fence.

## Out of Scope

No bulk live SQLite backfill, no changes to Pane identity authority, no
changes to explicit choice ordering or callback semantics, no Continue button
for malformed/ordinary answers, no Feishu SDK change, no deployment or service
restart in this change.

## Further Notes

Prepared workspace: `<repo-root>/.trae/worktrees/fix-ring-delivery-recovery`.
Branch: `fix/ring-delivery-recovery`; current base is the previously delivered
recovery chain. Fresh baseline in this request: focused Answer Card/choice/
SQLite suites passed `5 files / 660 tests`; typecheck, build, and architecture
check (`553` source files) passed. Gate 2 and Gate 3 were explicitly approved;
delivery review found and repair commit `5fd978e0` fixed the lost no-choice
signal in attached and Core recovery paths.
