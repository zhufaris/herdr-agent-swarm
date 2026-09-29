# Pane-Aligned Answer Card Implementation Plan

## Objective

Implement the approved pane-aligned Answer Card design for new Primary and
Worker turns while preserving persisted `rich_post` turns until they finish.

## Constraints

- Herdr Core Agent Events remain the only structured Answer authority.
- Main Card output is out of scope.
- New Answer pages use CardKit `streaming`; no new turn chooses `rich_post`.
- Existing `rich_post` rows continue through their current workflow.
- One active CardKit Markdown element ID exists per Answer page.
- Structural and content operations share the page's durable sequence and lane.
- Frozen pages are never patched and prompts are never replayed for delivery.

## Task 1: Add provider-neutral Answer presentation options

Files:

- `src/gateways/contract/view.ts`
- `src/gateways/feishu/cardkit-view.ts`
- `tests/gateway-view.test.ts`

Changes:

1. Extend `GatewayView` with additive optional width and stream-presentation
   fields.
2. Teach `cardKitToGatewayView` to retain `wide_screen_mode` and
   `streaming_config` from CardKit input.
3. Teach `materializeFeishuView` to emit the corresponding CardKit config.
4. Preserve the absence of these fields for Main Card and historical views.

Tests:

- Round-trip a wide streaming Answer config.
- Prove a standard Main Card does not gain wide mode or streaming config.
- Prove a terminal Answer retains wide mode while omitting active streaming
  configuration.

## Task 2: Centralize Answer semantic presentation

Files:

- new `src/cards/answer-presentation.ts`
- `src/cards/answer-timeline.ts`
- `src/runtime/answer-rich-text.ts`
- `tests/answer-timeline-card.test.ts`
- `tests/answer-rich-text.test.ts`

Changes:

1. Move category labels, category Emoji, state Emoji, border colors, safe short
   target formatting, and bounded detail formatting into one pure module.
2. Use an 88-code-point safe first-line summary for commands.
3. Render labels as `Read`, `Search`, `Edited`, `Ran`, `Tested`, `Input`,
   `Delegated`, and `Tool` with the approved Emoji map.
4. Keep every Tool panel collapsed, including failures.
5. Render a `✅ 最终回答` boundary before a final-answer item.
6. Keep the legacy rich-text renderer semantically aligned for persisted
   `rich_post` pages without adding a new delivery fallback.

Tests:

- Cover every category and state.
- Cover short-command redaction, ANSI/control removal, Unicode truncation, and
  empty command behavior.
- Cover Bash/text fences and `write_stdin` code-only behavior.
- Cover clean Agent Markdown and the Final Answer boundary.

## Task 3: Make Primary and Worker Answer cards wide and slot-correct

Files:

- `src/cards/run-card.ts`
- `src/cards/worker-turn-card.ts`
- `src/cards/answer-timeline.ts`
- `src/cards/answer-timeline-page.ts`
- `src/domain/ports/presentation.ts`
- `tests/run-card.test.ts`
- `tests/worker-turn-card.test.ts`
- `tests/answer-timeline-page.test.ts`

Changes:

1. Enable wide mode and native streaming presentation only on Answer cards.
2. Add the approved active and terminal header states.
3. Render page metadata once and task progress once at the bottom.
4. Change timeline page rendering so completed Markdown nodes are immutable and
   only the last active Markdown tail receives `answerElementId` or
   `workerTurnElementId`.
5. Ensure a newly inserted Tool panel is followed by an empty active Markdown
   slot while the turn remains active.
6. Keep terminal pages free of mutable slots.

Tests:

- Exactly one Answer element ID per active page and zero per terminal page.
- Agent/Tool/Agent ordering and collapsed panels.
- Main Card output remains unchanged.
- Primary and Worker presentation parity.

## Task 4: Select CardKit streaming for every new Answer entry point

Files:

- `src/store/sqlite/prompt-acceptance-store.ts`
- `src/store/sqlite/prompt-store.ts`
- `src/store/sqlite/binding-projection-store.ts`
- `src/store/sqlite/turn-control-store.ts`
- `src/store/sqlite/external-turn-adoption-store.ts`
- `src/store/sqlite/worker-turn/acceptance.ts`
- `src/events/outbound-intent-writer.ts`
- related focused store and admission tests

Changes:

1. Replace new `rich-text-reply` reservations with `stream_card_create` and the
   existing deterministic page element IDs.
2. Use the existing `stream-card:<aggregate>:<page>` idempotency family.
3. Persist `delivery_mode = 'streaming'` through current outbox reservation and
   delivery settlement paths.
4. Leave code that completes an already-persisted `rich_post` page intact.
5. Update recovery selection so an unclaimed new create remains CardKit and is
   never rewritten to rich text.

Tests:

- Primary acceptance, priority continuation, external adoption, queued recovery,
  Worker acceptance, and startup recovery all reserve a streaming card.
- Existing active `rich_post` fixtures continue to reserve rich-text updates.
- Duplicate admission retains one logical create intent.

## Task 5: Add hybrid timeline convergence with one sequence

Files:

- `src/coordinator/answer-page-workflow.ts`
- `src/coordinator/worker-turn-card-workflow.ts`
- `src/store/sqlite/projection-store.ts`
- `src/store/sqlite/worker-turn/projection.ts`
- `src/store/sqlite/answer-timeline-page-store.ts`
- `src/domain/ports/projection.ts`
- `src/domain/ports/instance.ts`
- `tests/answer-page-workflow.test.ts`
- `tests/worker-turn-card-workflow.test.ts`
- `tests/sqlite-store.test.ts`

Changes:

1. Classify each convergence as either:
   - a pure append to the active Agent Markdown item; or
   - a structural timeline change.
2. Reserve element-content delivery for a pure append.
3. Reserve a whole-card snapshot for Tool insertion, Tool state/result changes,
   new Agent message boundaries, status items, Final Answer, and page footer
   changes.
4. Increment and persist the same page sequence for both operations.
5. Store timeline checkpoint fingerprints only when the matching provider intent
   settles.
6. Maintain one outbox lane per Primary Answer or Worker turn.
7. Continue item-aware pagination and late-result projection without updating a
   frozen page.

Tests:

- Content append -> Tool structural update -> new content append has sequences
  1, 2, 3 and targets the same page slot.
- A retry preserves the reserved operation identity and sequence.
- Running-to-succeeded Tool updates one stable panel.
- Restart resumes from the persisted checkpoint without duplicate prose or Tool
  items.
- Continuation freezes the prior page and creates a wide CardKit next page.

## Task 6: Remove new-flow rich-text assumptions and document behavior

Files:

- `src/events/outbound-gateway-intent.ts`
- `src/events/outbound-delivery-executor.ts`
- `src/events/outbound-target-validation.ts`
- `src/store/sqlite/outbox-queue-store.ts`
- `docs/feishu-group-usage.md`
- `docs/architecture.md`
- focused delivery and documentation tests

Changes:

1. Keep rich-text intent decoding only for historical persisted rows.
2. Ensure new Answer target validation accepts the single active slot and rejects
   extra mutable slots.
3. Keep streaming structural updates fenced to the current message/card/page.
4. Document wide Answer Cards, clean Agent prose, semantic Tool panels, and the
   in-flight `rich_post` handoff.
5. Do not remove rich-text schema or historical recovery code in this change.

Tests:

- Gateway intent materialization for stream create, append, structural replace,
  finish, and historical rich-text update.
- Target mismatch and stale-generation failures remain permanent and safe.
- Documentation audit recognizes the new Answer contract.

## Verification sequence

Run after each task's focused tests pass:

1. `npx vitest run <affected-test-files>`
2. `npm run typecheck`
3. `npm run build`
4. `npm test -- --run`
5. `git diff --check`

Do not install or restart until source verification is complete. Installation
and restart remain separate operator steps guarded by the active-work safety
gate.
