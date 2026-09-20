# Answer Card Empty-Output Command Folding Implementation Plan

**Goal:** Render completed commands with no displayable output as collapsed final Answer Card panels while leaving active commands as compact Markdown.

**Architecture:** Keep transcript projection, canonical Answer text, pagination, and finalization unchanged. Make the pure final-content parser retain command lifecycle independently of output presence, then let the final renderer choose a panel for terminal commands and the existing payload fallback for oversized cards.

## Task 1: Add failing renderer coverage

- Extend `tests/final-answer-content.test.ts` for terminal success without output at the end of an Answer.
- Cover failed-without-detail, running-without-output, surrounding prose, and payload fallback.
- Confirm the current implementation fails only the new terminal-panel expectations.

## Task 2: Separate lifecycle from output presence

- Extend the command render model in `src/cards/final-answer-content.ts` with an explicit running/terminal distinction.
- Render terminal commands as collapsed panels even when output is empty.
- Add the fixed safe empty-output message to the panel body.
- Preserve compact Markdown for running, malformed, partial, and payload-fallback cases.

## Task 3: Verify and commit independently

- Run `npx vitest run tests/final-answer-content.test.ts tests/answer-stream.test.ts tests/answer-page-workflow.test.ts`.
- Run `npm run typecheck` and `npm run build`.
- Inspect the diff and commit this presentation fix without Worker-card changes.
