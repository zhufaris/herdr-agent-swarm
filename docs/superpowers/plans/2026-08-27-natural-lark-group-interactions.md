# Natural Lark Group Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver phases 1 and 2 of the approved state-driven Lark interaction design, verify all safety invariants, and deploy the rebuilt Herdr plugin.

**Architecture:** Add a typed CardKit response boundary and one focused interaction workflow. Persist creator identity and single-use interaction records in SQLite, route all card controls through fresh authorization/state checks, and delegate effects to the existing workflows. Main and Answer cards remain pure projections; durable facts and outbox delivery remain authoritative.

**Tech Stack:** TypeScript ESM, Node.js >= 22.5, `@larksuiteoapi/node-sdk`, Zod, SQLite, Vitest, Herdr plugin/systemd.

**Spec:** `docs/superpowers/specs/2026-08-27-natural-lark-group-interactions-design.md`

## Global Constraints

- Ordinary topic replies remain FIFO and are never inferred as steering.
- A stale supplement or conversion never targets a newer turn and never falls back to FIFO.
- High-impact controls are creator-only; there is no takeover flow.
- High-risk TraeX approval remains local to Herdr.
- Persist workflow intent before Lark delivery; delivery retries never repeat a prompt or Pane action.
- Existing `/swarm` commands remain behaviorally compatible.
- Preserve the current 9,000-character Answer Card page limit and frozen-page behavior.
- Do not manually edit generated `dist/`.

---

### Task 1: Typed CardKit interaction response boundary

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/adapters/lark-adapter.ts`
- Modify: `tests/lark-adapter.test.ts`

**Interfaces:**
- Produces: `LarkCardActionResult = { toast?: { type: "success" | "warning" | "error"; content: string }; card?: object }`.
- Produces: normalized `IncomingLarkCardAction.formValues: Record<string, string>`.
- Changes: `LarkPort.start` card handler returns `Promise<LarkCardActionResult | void>`.

- [ ] Add adapter tests proving `action.form_value` is normalized with strict string values and a handler result is returned by the registered `card.action.trigger` callback.
- [ ] Run `npx vitest run tests/lark-adapter.test.ts` and confirm the new assertions fail.
- [ ] Add the typed result and form values, validate the external payload with Zod, and return the handler result from the SDK callback.
- [ ] Re-run `npx vitest run tests/lark-adapter.test.ts` and require a pass.
- [ ] Commit only Task 1 files with `feat: add typed Lark card interaction responses`.

### Task 2: Creator identity and durable single-use interactions

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/coordinator/binding-provisioning-workflow.ts`
- Modify: `tests/sqlite-store.test.ts`
- Modify: `tests/project-selection-integration.test.ts`

**Interfaces:**
- Produces: `Binding.creatorOpenId: string | null`.
- Produces: `CardInteraction` with binding/generation/actor/action/parent/target/state/expiry/result fields.
- Produces: `createCardInteraction`, `getCardInteraction`, `consumeCardInteraction`, and atomic `convertQueuedPromptToSteering`.

- [ ] Write migration tests for adding `creator_open_id` and `card_interactions` without damaging existing databases.
- [ ] Write store tests for actor scoping, generation checks, expiry, duplicate consumption, and result replay.
- [ ] Write an atomic-conversion test proving a queued prompt becomes steering exactly once and a stale parent leaves it unchanged in its original FIFO order.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts tests/project-selection-integration.test.ts` and confirm the new tests fail.
- [ ] Implement schema convergence, row mapping, narrow store ports, creator propagation from project selection/attach, and the interaction transactions.
- [ ] Re-run the focused tests and require a pass.
- [ ] Commit only Task 2 files with `feat: persist creator-scoped card interactions`.

### Task 3: Explicit project selection for natural-language roots

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/coordinator/inbound-router.ts`
- Modify: `src/coordinator/binding-provisioning-workflow.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `tests/project-selection-integration.test.ts`
- Modify: `tests/herdr-discovery-integration.test.ts`

**Interfaces:**
- Extends: `ProjectSelection.initialPromptText: string | null`.
- Produces: selection completion that durably enqueues the original natural-language request only after explicit project confirmation.

- [ ] Add integration tests showing `@Bot <request>` opens project selection, creates no binding before selection, and dispatches the original text once after selection.
- [ ] Add duplicate-selection and restart-recovery tests proving the initial prompt is not duplicated.
- [ ] Run the two focused integration files and confirm the new tests fail.
- [ ] Store the initial prompt with the selection, route natural-language roots through selection, and enqueue it after activation through the existing prompt acceptance path.
- [ ] Ensure `/swarm new [title]` still creates an empty task while preserving its title semantics.
- [ ] Re-run focused tests and require a pass.
- [ ] Commit only Task 3 files with `feat: require explicit project selection for new tasks`.

### Task 4: Immediate supplement and queued-prompt conversion

**Files:**
- Create: `src/coordinator/card-interaction-workflow.ts`
- Create: `src/cards/interaction-card.ts`
- Modify: `src/coordinator/inbound-router.ts`
- Modify: `src/main.ts`
- Modify: `tests/helpers/create-test-router.ts`
- Create: `tests/card-interaction-integration.test.ts`
- Modify: `tests/steering-integration.test.ts`

**Interfaces:**
- Produces: `CardInteractionWorkflow.openSupplement`, `submitSupplement`, and `convertQueuedPrompt`.
- Consumes: `PromptRunWorkflow.activeTurn(bindingId)`, `PaneControlWorkflow.steer`, durable interaction APIs, scheduler wake-up.
- Produces: CardKit response cards containing a form (`input` plus submit button) and concise Toast outcomes.

- [ ] Add renderer tests for the supplement input card and its opaque callback values.
- [ ] Add integration tests for working and blocked turns, stale generation, ended parent turn, wrong actor, duplicate callback, and restart replay.
- [ ] Add the race test where the parent ends between card render and submission; assert no newer turn receives the text.
- [ ] Run `npx vitest run tests/card-interaction-integration.test.ts tests/steering-integration.test.ts` and confirm failures.
- [ ] Implement the focused workflow, pure card renderer, router delegation, and composition-root wiring.
- [ ] Make queued conversion use the store's single atomic transition and post-commit steering wake-up.
- [ ] Re-run focused tests and require a pass.
- [ ] Commit Task 4 files with `feat: add immediate supplement card interactions`.

### Task 5: State-driven Main Card and progressive help

**Files:**
- Modify: `src/domain/topic-view.ts`
- Modify: `src/domain/run-card-view.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `src/events/conversation-view-projector.ts`
- Modify: `src/coordinator/main-card-workflow.ts`
- Modify: `tests/run-card.test.ts`
- Modify: `tests/topic-view.test.ts`
- Modify: `tests/event-card-integration.test.ts`
- Modify: `tests/commands.test.ts`

**Interfaces:**
- Produces: shared action descriptors derived only from current durable view state.
- Produces: Main Card callbacks for `open_supplement`, `open_more_actions`, `view_queue`, and recovery guidance.
- Produces: queued Answer Card callback `convert_queued_prompt` bound to captured parent turn.

- [ ] Add a renderer matrix covering provisioning, idle/done, working, queued, blocked, error/orphaned, and archived views.
- [ ] Assert creator-only controls never appear directly on the shared Main Card.
- [ ] Add progressive-help assertions: natural-language start, FIFO versus supplement, emergency commands, and collapsed advanced/recovery reference while parser compatibility remains unchanged.
- [ ] Run the focused card/view/command tests and confirm failures.
- [ ] Implement pure state-driven controls and help rendering without parsing rendered card text as state.
- [ ] Re-run focused tests and require a pass.
- [ ] Commit Task 5 files with `feat: add state-driven Lark task controls`.

### Task 6: Creator-scoped complete session controls

**Files:**
- Modify: `src/coordinator/card-interaction-workflow.ts`
- Modify: `src/cards/interaction-card.ts`
- Modify: `src/coordinator/pane-control-workflow.ts`
- Modify: `src/coordinator/model-selection-workflow.ts`
- Modify: `src/coordinator/session-administration-workflow.ts`
- Modify: `src/coordinator/pane-closure-workflow.ts`
- Modify: `src/coordinator/binding-provisioning-workflow.ts`
- Modify: `tests/card-interaction-integration.test.ts`
- Modify: `tests/model-command-integration.test.ts`
- Modify: `tests/pane-close-integration.test.ts`

**Interfaces:**
- Produces: operator-scoped More actions card from fresh binding state.
- Delegates: status, model, rename, stop, reset, archive, Pane close, reattach, replace, and resume to existing workflow methods through typed inputs.

- [ ] Test that non-creators receive only read-only/collaboration controls and forged callbacks are rejected server-side.
- [ ] Test each creator action against stale generation, invalid state, duplicate callback, and the existing command-equivalent behavior.
- [ ] Test Pane close still uses two-step confirmation and fresh Herdr identity/busy checks.
- [ ] Run the three focused integration files and confirm failures.
- [ ] Implement the action-card capability calculation and thin workflow adapters; do not duplicate command business transitions.
- [ ] Return Toast success for completed actions and a dedicated card only for confirmation, recovery, or uncertain outcomes.
- [ ] Re-run focused tests and require a pass.
- [ ] Commit Task 6 files with `feat: add creator-scoped Lark session controls`.

### Task 7: Documentation, regression verification, and deployment

**Files:**
- Modify: `docs/feishu-group-usage.md`
- Modify: `docs/architecture.md`
- Modify: affected files only if verification exposes defects

**Interfaces:**
- Documents: natural task creation, explicit project choice, FIFO/supplement distinction, More actions permissions, Toast behavior, command compatibility, and Herdr-only approvals.

- [ ] Update user and architecture documentation from the implemented behavior.
- [ ] Run focused interaction tests plus `tests/concurrency-controls.integration.test.ts`, `tests/lark-outbox-dispatcher.test.ts`, and detached-recovery tests.
- [ ] Run `npm run typecheck` and require exit 0.
- [ ] Run `npm run build` and require exit 0 with generated build identity.
- [ ] Run `npm test` and require every Vitest test to pass.
- [ ] Inspect `git diff --check`, changed-file scope, and every acceptance criterion in the spec.
- [ ] Commit documentation and any verification-only fixes with a focused commit message.
- [ ] Restart with `herdr plugin action invoke restart --plugin herdr-lark-bridge`.
- [ ] Verify `herdr plugin action invoke status --plugin herdr-lark-bridge`, the configured loopback `/ready` endpoint, deployed build identity, and bounded recent logs.
- [ ] Confirm no live Lark message or destructive Pane action was used as a smoke test; production verification remains non-mutating.
