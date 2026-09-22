# Answer Command Panel Budget Implementation Plan

## Objective

Keep completed command activities expandable on every Answer Card page by
shrinking only their displayed output when the card payload budget is tight.

## Public test seams

- `foldFinalAnswerContent`: returned CardKit element types, bounded serialized
  size, command/detail preservation, and explicit output truncation marker.
- `renderFinalAnswerCard`: continuation-page cards retain a collapsed command
  panel under the configured payload limit.
- `AnswerPageWorkflow.converge`: finalization retains the existing canonical page
  boundary and reserves one durable card update containing the panel.

Tests will not import private budget or truncation helpers.

## Work packages

### 1. Preserve a command panel near the payload boundary

- Add a failing content test with preceding Markdown and a command whose full
  detail exceeds the remaining payload budget.
- Require a `collapsible_panel`, the complete bounded command, an explicit output
  truncation marker, and a serialized element payload within the configured
  limit.
- Compute available detail from the already accepted elements and the panel's
  fixed CardKit structure. Shorten output deterministically until the panel fits.

### 2. Preserve existing command variants

- Keep short command output unchanged.
- Keep the existing no-output message and running-command compact row.
- Retain the compact-summary fallback only when the fixed panel and command cannot
  fit within the hard payload limit.

### 3. Verify the continuation Answer Card

- Add a final-card test with `pageNumber > 1`, substantial page-local prose, and
  a complete command activity near the end.
- Assert the final card is non-streaming, contains a collapsed command panel, and
  stays within the configured payload limit.
- Add or extend workflow coverage to prove `sourceStart`, page index, durable
  update reservation, and stream behavior are unchanged.

### 4. Review, document, and commit

- Run focused content, run-card, Answer workflow, Answer stream, and event-card
  tests.
- Run typecheck, build, the full test suite, architecture check, documentation
  audit, public-release audit, and whitespace check.
- Review against the approved design and repository standards.
- Mark the TODO complete, update architecture behavior, archive this design and
  plan, remove their active index entries, and commit without installing,
  restarting, or pushing.

## Guardrails

- Do not change canonical pagination, stream element patching, SQLite schema,
  outbox identities, frozen pages, recovery links, or retry behavior.
- Do not emit a second card or introduce a command-detail action.
- Do not expose more terminal output than the current bounded command parser.
- Do not exceed the caller-provided CardKit payload limit.
