# Answer Command Panel Budget Design

## Goal

Keep complete TraeX command activities expandable after an Answer Card is
finalized, including activities on continuation pages whose other content has
already consumed most of the CardKit payload budget.

## Current failure

Final Answer pages pass their canonical page rendering to
`foldFinalAnswerContent`. A recognized command activity becomes a collapsed
CardKit panel containing its command and bounded output. The folder currently
tests the complete panel against a fixed reserve. When it does not fit, it
silently emits only the compact Markdown summary. Later pages commonly approach
the 9,000-character stream page limit, so a command panel can lose its
expandable detail even though the command was parsed correctly.

## Chosen design

The final-card folder will treat a recognized command as an expandable element
with a payload-aware detail budget. It will first try the existing full bounded
detail. If that does not fit, it will shorten only the command output and add an
explicit truncation marker. It will retain the command, panel header, and
collapsed panel structure. Commands without output retain their existing empty
result message.

The calculation belongs in `final-answer-content.ts`, where command parsing,
detail rendering, and CardKit payload accounting already meet. The caller keeps
supplying the same page-local rendered content and total payload limit. No
pagination or workflow layer needs to know about CardKit element overhead.

If the fixed panel structure and command alone cannot fit, the folder may use
the compact summary as the bounded last resort. This preserves the hard payload
limit for pathological command text while making ordinary and large-output
commands expandable. The existing command-title truncation keeps this fallback
exceptional.

## Preserved boundaries

- Streaming Answer content remains Markdown and uses the existing element patch
  protocol. Panels appear only in the completed static card update.
- Canonical source offsets, page boundaries, frozen pages, continuation cards,
  recovery links, SQLite state, idempotency keys, and durable outbox behavior do
  not change.
- Tool output remains bounded and hidden by default. No additional Lark message,
  callback action, or remote terminal capability is introduced.
- Primary Answer metadata and first-page Worker activity keep their existing
  layout and share the same total CardKit payload limit.

## Error and limit handling

Payload decisions use the serialized CardKit size helper already used by the
folder rather than raw Markdown length. The detail budget is derived from the
elements already accepted into the card. Output truncation must be deterministic
and must not split the command itself. The rendered truncation marker states that
the command output was shortened for the card.

## Verification

Focused tests will prove that:

- a command near the end of a continuation page remains a
  `collapsible_panel`;
- a large output is shortened within the configured payload limit and includes
  the truncation marker;
- short and no-output commands preserve current rendering;
- the finalized Answer workflow keeps its existing page source boundaries and
  reserves one durable card update; and
- streaming Answer rendering is unchanged.

Before handoff, run the focused content, card, Answer workflow, and event-card
tests, followed by typecheck, build, the full suite, architecture, documentation,
public-release, and whitespace checks.
