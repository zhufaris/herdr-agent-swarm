# Answer Card Fast Streaming Implementation Plan

**Goal:** Make long, full-content CardKit Answer Card updates visibly catch up quickly.

**Architecture:** Change the rendering-only `streaming_config` emitted by
`renderRequestAnswerCard`; all durable stream content, sequence, outbox, and
page behavior stays unchanged.

### Task 1: Lock fast rendering configuration

**Files:**
- Modify: `tests/run-card.test.ts`

- [ ] Assert a running Answer Card renders `print_frequency_ms.default` as 40,
  `print_step.default` as 50, and `print_strategy` as `fast`.
- [ ] Run `npx vitest run tests/run-card.test.ts` and observe the old values fail.

### Task 2: Change only the presentation configuration

**Files:**
- Modify: `src/cards/run-card.ts`

- [ ] Update the running-card `streaming_config` to 40 ms and 50 characters.
- [ ] Run focused card tests, `npm run typecheck`, `npm run build`, and `npm test`.
- [ ] Rebuild, link, restart the managed bridge, then verify its health identity.
