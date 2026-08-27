# Durable Reconciler Projections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reconciler-observed terminal output and confirmed missing panes durably visible in the main Lark card even if the bridge process exits before an in-process event is projected.

**Architecture:** Keep Herdr as the source of runtime facts and SQLite as the authority for binding lifecycle, desired CardKit views, and delivery intent. Replace the reconciler's split fingerprint/event and binding/run-card/event sequences with two fenced SQLite commands that atomically write the state mutation, derived view, and outbox reservation; `BridgeEventBus` becomes a post-commit, best-effort latency hint only.

**Tech Stack:** TypeScript (Node ESM), better-sqlite3 transactions, Vitest, Zod-adapted boundary contracts, Lark CardKit renderers.

**Spec:** `docs/superpowers/specs/2026-08-27-durable-reconciler-projections-design.md`

## Global Constraints

- Keep SQLite authoritative for bindings, run-card/topic-card views, and Lark outbox intent; retain Herdr as the authority for live pane/runtime facts.
- Preserve pane/generation fences. A stale observation must not write a fingerprint, view, run-card, or outbox record.
- Persist no raw terminal output, TraeX session UUID, or secret. Pass only already-sanitized answer/model/context presentation data into the durable command.
- Do not make `BridgeEventBus` durable and do not introduce general event sourcing.
- Do not automatically replay any prompt that may have reached TraeX.
- Preserve ordered CardKit stream behavior; frozen answer pages are not patched.
- Keep the change restricted to reconciler durability; do not fold in the independent bridge-owned TraeX-session worktree changes.

---

## File structure and boundaries

- `src/domain/types.ts` defines the input/result records used by reconciler-owned durable transitions. These values contain only binding fences, deterministic presentation data, and state-machine outcomes.
- `src/domain/ports.ts` exposes the two transactions through `RuntimeReconciliationStore`; the reconciler no longer composes a lifecycle transition from multiple store calls.
- `src/store/sqlite-store.ts` owns both `BEGIN IMMEDIATE` transitions. It performs all SQLite writes, `TopicView` reduction/update, and durable Lark outbox reservation in the one transaction.
- `src/coordinator/herdr-runtime-reconciler.ts` continues bounded terminal parsing/redaction and Herdr observation. It creates sanitized patches/cards, calls the atomic store command, and only then emits the existing best-effort lifecycle event.
- `tests/sqlite-store.test.ts` proves transaction results and fences directly. `tests/herdr-runtime-reconciler.test.ts` proves the reconciler survives the absence of an event projector and never emits effects for stale data. `tests/startup-view-converger.test.ts` proves persisted desired state is picked up by normal delivery convergence.

### Task 1: Durable terminal-output checkpoint and main-card projection

**Files:**

- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports.ts: RuntimeReconciliationStore`
- Modify: `src/store/sqlite-store.ts: checkpointRuntimeOutput`
- Modify: `src/coordinator/herdr-runtime-reconciler.ts: publishChangedLocalOutput`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/herdr-runtime-reconciler.test.ts`
- Test: `tests/startup-view-converger.test.ts`

**Interfaces:**

- Consumes: `TopicViewState`, `updateTopicView()`, `renderMainCard()`, and the existing fenced binding columns `pane_id`, `generation`, and `last_output_fingerprint`.
- Produces: `RuntimeOutputProjectionInput` and `RuntimeOutputProjectionResult`, exposed as `checkpointRuntimeOutputWithProjection(input)` on `RuntimeReconciliationStore`.
- Required signature:

```ts
interface RuntimeOutputProjectionInput {
  bindingId: string;
  expectedPaneId: string;
  expectedGeneration: number;
  fingerprint: string;
  patch: Pick<TopicViewState, "answer" | "model" | "context">;
  rootMessageId: string;
  card: object;
}

interface RuntimeOutputProjectionResult {
  outcome: "projected" | "unchanged" | "stale";
  view: TopicViewState | null;
}
```

- The command must return `unchanged` when the persisted fingerprint already equals `fingerprint`, `stale` when its pane/generation/lifecycle fence does not match, and `projected` only after fingerprint, desired view, and main-card delivery intent commit.

- [ ] **Step 1: Write a direct SQLite failing test for atomic output projection**

In `tests/sqlite-store.test.ts`, create an active, attached binding with `paneId: "w1:p1"`, `generation: 1`, `rootMessageId: "root"`, and a persisted initial `TopicView`. Call the new command using `fingerprint: "fp-1"`, patch `{ answer: "safe final answer", model: "GPT-5.6", context: "12K tokens" }`, and a rendered main card. Assert all of the following after one call:

```ts
expect(result).toMatchObject({ outcome: "projected" });
expect(store.getBinding("b1")).toMatchObject({ lastOutputFingerprint: "fp-1" });
expect(store.loadTopicView("b1")).toMatchObject({
  phase: "done", answer: "safe final answer", model: "GPT-5.6", context: "12K tokens"
});
expect(store.listPendingOutboundReplies()).toEqual([
  expect.objectContaining({ bindingId: "b1", kind: "main_card" })
]);
```

- [ ] **Step 2: Run the focused test and confirm it fails because the durable command is absent**

Run: `npx vitest run tests/sqlite-store.test.ts -t "atomically projects changed runtime output"`

Expected: FAIL with a TypeScript or runtime error that `checkpointRuntimeOutputWithProjection` does not exist.

- [ ] **Step 3: Add the types and port contract**

Add the two interfaces above to `src/domain/types.ts`. Add `checkpointRuntimeOutputWithProjection(input: RuntimeOutputProjectionInput): RuntimeOutputProjectionResult` to `RuntimeReconciliationStore` in `src/domain/ports.ts`; remove `checkpointRuntimeOutput` from that reconciler-facing port after all its callers move. Keep the existing generic store interface only if another non-reconciler caller still needs it; otherwise remove the obsolete method to prevent a future split write.

- [ ] **Step 4: Implement the single SQLite transaction**

In `SqliteBindingStore`, use `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` like `reserveMainCard()`. Read the binding inside the transaction and check this exact fence before any write:

```sql
id = ? AND pane_id = ? AND generation = ?
AND lifecycle IN ('active', 'draining') AND attachment != 'orphaned'
```

If the fence fails, return `{ outcome: "stale", view: null }`. If `last_output_fingerprint` is already `input.fingerprint`, return `{ outcome: "unchanged", view: currentView }` without inserting an outbox reply. Otherwise, update the fingerprint, apply the sanitized patch with `updateTopicView(currentView, input.patch)`, and reserve the main-card intent using the same internal SQL used by `reserveMainCard()` rather than nesting its public transaction. Return the persisted desired view only after commit.

- [ ] **Step 5: Expand the store test for deduplication and stale fences**

In the same test block, repeat the exact call and assert `outcome === "unchanged"`, unchanged `viewVersion`, and exactly one pending main-card reply. Then call it with `expectedGeneration: 2` and a new fingerprint/answer; assert `outcome === "stale"`, that fingerprint/view remain from the first call, and no additional outbox reply exists.

- [ ] **Step 6: Run the direct store tests**

Run: `npx vitest run tests/sqlite-store.test.ts -t "runtime output"`

Expected: PASS, including the projected, unchanged, and stale-fence assertions.

- [ ] **Step 7: Make reconciler output parsing call the durable command before notification**

In `publishChangedLocalOutput()`, retain `cleanTerminalOutput`, `outputFingerprint`, `extractFinalTraexAnswer`, `extractTraexAnswer`, and telemetry parsing. Build a patch from the bounded/sanitized answer plus telemetry. Load/derive the current topic view, render the card, and call `checkpointRuntimeOutputWithProjection`. Only update `observedTerminalOutputs`, emit `PaneOutputObserved`, and call telemetry publishing when the result outcome is `projected`. Do not publish an answer event for `unchanged` or `stale`.

When output has telemetry but no final answer, persist just `{ model, context }`; when output contains a final answer, persist the answer plus any telemetry. Preserve the existing busy-binding guard: no passive answer projection may overwrite an active turn's run-card-owned view.

- [ ] **Step 8: Add the no-projector restart-shaped reconciler test**

In `tests/herdr-runtime-reconciler.test.ts`, construct the existing reconciler fixture with a `BridgeEventBus` that has no `ConversationViewProjector` subscriber. Reconcile a pane whose output is `◆ durable local answer`. Assert the store now has the fingerprint, a `TopicView` with `answer: "durable local answer"`, and a pending main-card reply. Create a fresh `StartupViewConverger` using that same store and assert it does not require re-reading terminal output to preserve/queue the durable view.

```ts
expect(store.loadTopicView("b1")).toMatchObject({ answer: "durable local answer" });
expect(store.listPendingOutboundReplies()).toContainEqual(
  expect.objectContaining({ bindingId: "b1", kind: "main_card" })
);
```

- [ ] **Step 9: Run the reconciler and startup convergence tests**

Run: `npx vitest run tests/herdr-runtime-reconciler.test.ts tests/startup-view-converger.test.ts`

Expected: PASS. The changed-output test remains green, duplicate output creates one durable intent, and the no-projector case is recoverable from SQLite alone.

- [ ] **Step 10: Commit the independently verifiable output transition**

```bash
git add src/domain/types.ts src/domain/ports.ts src/store/sqlite-store.ts src/coordinator/herdr-runtime-reconciler.ts tests/sqlite-store.test.ts tests/herdr-runtime-reconciler.test.ts tests/startup-view-converger.test.ts
git diff --cached --check
git commit -m "fix: persist reconciler output projections atomically"
```

Do not stage unrelated bridge-owned session files that are already modified in the worktree. If the Git index remains read-only, retain the verified changes and report that environmental blocker rather than retrying blindly.

### Task 2: Atomic missing-pane orphan transition

**Files:**

- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports.ts: RuntimeReconciliationStore`
- Modify: `src/store/sqlite-store.ts: transitionBinding/listRunCardsByPhases/saveRunCard/outbox helpers`
- Modify: `src/coordinator/herdr-runtime-reconciler.ts: orphanMissingPane and confirmed-missing callers`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/herdr-runtime-reconciler.test.ts`

**Interfaces:**

- Consumes: the existing `pane_probe_failed` state-machine transition, `RunCardView`, `renderRequestAnswerCard()`, current `TopicViewState`, and main-card reservation semantics.
- Produces: `OrphanBindingProjectionInput` and `OrphanBindingProjectionResult`, exposed as `orphanBindingWithProjection(input)` on `RuntimeReconciliationStore`.
- Required signature:

```ts
interface OrphanBindingProjectionInput {
  bindingId: string;
  expectedPaneId: string;
  expectedGeneration: number;
  occurredAt: string;
  reason: string;
  rootMessageId: string;
  renderRunCard(view: RunCardView): object;
  mainCard: object;
}

interface OrphanBindingProjectionResult {
  outcome: "orphaned" | "unchanged" | "stale";
  binding: Binding | null;
  view: TopicViewState | null;
  updatedPromptIds: string[];
}
```

- `renderRunCard` is a pure callback invoked only for non-streaming answer-message updates within the transaction; it lets CardKit rendering remain in `src/cards/` while SQLite retains ownership of the atomic delivery intent.

- [ ] **Step 1: Write the failing store test for an orphaned binding as one durable projection**

In `tests/sqlite-store.test.ts`, create an attached active binding and three run cards: one `running`, one `blocked`, and one `queued`. Give the running/blocked cards `answerMessageId` values but no `answerCardId`; give the queued card no answer message. Call `orphanBindingWithProjection()` with the exact pane/generation fence and deterministic reason. Assert in one post-call snapshot:

```ts
expect(result).toMatchObject({ outcome: "orphaned", updatedPromptIds: ["running", "blocked", "queued"] });
expect(store.getBinding("b1")).toMatchObject({ state: "orphaned", attachment: "orphaned" });
expect(store.loadRunCard("running")).toMatchObject({ phase: "failed", queuePosition: 0 });
expect(store.loadRunCard("blocked")).toMatchObject({ phase: "failed", queuePosition: 0 });
expect(store.loadRunCard("queued")).toMatchObject({ phase: "failed", queuePosition: 0 });
expect(store.getPrompt("queued")).toMatchObject({ state: "cancelled", observationState: "completed" });
expect(store.loadTopicView("b1")).toMatchObject({ phase: "orphaned", notice: expect.stringContaining("no longer exists") });
```

Also assert one main-card outbox intent and exactly two answer-card update intents, matching only the non-streaming run cards.

- [ ] **Step 2: Run the focused orphan test and confirm it fails**

Run: `npx vitest run tests/sqlite-store.test.ts -t "orphan.*atomically"`

Expected: FAIL because `orphanBindingWithProjection` does not exist.

- [ ] **Step 3: Add the orphan transition types and port contract**

Add the two orphan interfaces to `src/domain/types.ts` and `orphanBindingWithProjection(input: OrphanBindingProjectionInput): OrphanBindingProjectionResult` to `RuntimeReconciliationStore`. Keep the callback return type as `object`; no renderer, raw output, or Lark SDK object crosses into the domain types.

- [ ] **Step 4: Implement the fenced orphan transaction**

In `SqliteBindingStore`, start `BEGIN IMMEDIATE`, load/check `bindingId`, `expectedPaneId`, and `expectedGeneration`, and reject stale observations before touching any row. If the current attachment is already `orphaned`, return `unchanged` without new outbox writes. Otherwise execute the existing `pane_probe_failed` transition with `{ confirmedMissing: true, orphanThreshold: 2 }`, require its result to be orphaned, and update all `running`, `blocked`, and `queued` views with the existing messages:

```ts
const terminalNotice = `Herdr pane ${binding.paneId} no longer exists`;
const queuedNotice = `Herdr pane ${binding.paneId} no longer exists，请恢复绑定后重试。`;
```

Set running jobs to `failed`, queued jobs to `cancelled`, and both observation states to `completed`. Use `failed` with `finishedAt`, `queuePosition: 0`, and a new `viewVersion` for all affected RunCards. For each affected card having `answerMessageId` and no `answerCardId`, persist the corresponding answer-card update intent in this same transaction. Derive the topic state with `updateTopicView(currentView, { phase: "orphaned", notice: input.reason })`, reserve the main-card outbox intent, commit, and return the updated prompt IDs in deterministic creation order.

- [ ] **Step 5: Extend store tests for idempotence and stale fences**

Repeat the orphan command with the same input and assert `outcome === "unchanged"`, no view-version changes, and no duplicate answer/main-card replies. In a separate binding, change the generation before the call and assert `outcome === "stale"`, the attachment remains active, and all run cards/outbox rows are unchanged.

- [ ] **Step 6: Run the orphan store tests**

Run: `npx vitest run tests/sqlite-store.test.ts -t "orphan"`

Expected: PASS for atomic state, idempotence, and stale-fence coverage.

- [ ] **Step 7: Replace the reconciler's split orphan loop**

In `orphanMissingPane()`, remove the standalone `transitionBinding`, `listRunCardsByPhases`, `saveRunCard`, and `enqueueRunCardUpdate` sequence. Build the deterministic reason, load/render the current main card, and call `orphanBindingWithProjection()` with `renderRequestAnswerCard`. Publish `BindingOrphaned` only if the returned outcome is `orphaned`; do not publish or schedule run-card updates when the result is `unchanged` or `stale`.

Update `captureBaselines()` and the workspace-unavailable path to use this durable transition only when their current policy has confirmed a missing pane. Leave unconfirmed probe degradation on the existing non-orphaning lifecycle path.

- [ ] **Step 8: Add reconciler integration coverage without a view projector**

In `tests/herdr-runtime-reconciler.test.ts`, configure `listAllPanes()` to return an authoritative empty snapshot for a workspace containing one active bound pane. Seed running and queued cards. Do not subscribe a view projector to the bus. After reconcile, assert binding attachment/state, each run-card phase, the orphaned topic view, and pending outbox intents. Run reconcile a second time and assert reply count and run-card `viewVersion`s do not change.

- [ ] **Step 9: Run reconciler tests for pane loss and normal snapshot safety**

Run: `npx vitest run tests/herdr-runtime-reconciler.test.ts -t "orphan|authoritative snapshot"`

Expected: PASS. Confirmed absence becomes durable orphaning; snapshot-unavailable fallback still produces degradation rather than orphaning.

- [ ] **Step 10: Commit the independently verifiable orphan transition**

```bash
git add src/domain/types.ts src/domain/ports.ts src/store/sqlite-store.ts src/coordinator/herdr-runtime-reconciler.ts tests/sqlite-store.test.ts tests/herdr-runtime-reconciler.test.ts
git diff --cached --check
git commit -m "fix: atomically project orphaned Herdr bindings"
```

Again, do not stage unrelated existing modifications. If Git still cannot create `.git/index.lock`, do not force the commit; retain the patch and record the exact error.

### Task 3: Document the durable ownership boundary and run complete verification

**Files:**

- Modify: `docs/architecture.md: reconciliation, TopicView, and outbox sections`
- Modify: `docs/superpowers/specs/2026-08-27-durable-reconciler-projections-design.md` only if implementation exposes a material design mismatch
- Test: `tests/herdr-runtime-reconciler.test.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/startup-view-converger.test.ts`

**Interfaces:**

- Consumes: the completed durable commands from Tasks 1 and 2, existing `StartupViewConverger`, `MainCardWorkflow`, and `LarkOutboxDispatcher` contracts.
- Produces: architecture documentation that accurately states post-commit event publication is advisory and startup convergence delivers persisted desired view versions.

- [ ] **Step 1: Write a documentation assertion list before editing prose**

List these claims as a checklist beside the relevant `docs/architecture.md` section, then ensure each has code/test evidence:

```text
1. A terminal-output fingerprint is not considered observed until its sanitized main-card projection and delivery intent commit.
2. Confirmed pane absence commits binding, affected run cards, desired topic view, and relevant outbox intents together.
3. Bridge events after either transaction are best-effort low-latency notifications, not recovery records.
4. Startup convergence delivers persisted view versions; it does not replay terminal parsing or prompts.
```

- [ ] **Step 2: Update the active architecture document**

In the reconciliation/durability discussion of `docs/architecture.md`, replace any wording that implies an in-process `PaneOutputObserved` or `BindingOrphaned` event is the durable projection boundary. State the four verified claims above and point readers to `HerdrRuntimeReconciler`, `SqliteBindingStore`, `StartupViewConverger`, and `LarkOutboxDispatcher` by module name. Keep the document's existing language that Lark cards are output only, not workflow truth.

- [ ] **Step 3: Run focused verification after the documentation update**

Run: `npx vitest run tests/sqlite-store.test.ts tests/herdr-runtime-reconciler.test.ts tests/startup-view-converger.test.ts`

Expected: PASS.

- [ ] **Step 4: Run repository-required static/build checks**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both commands exit 0; build regenerates only ignored `dist/` output and its expected build identity.

- [ ] **Step 5: Run the complete workflow/persistence regression suite**

Run: `npm test`

Expected: all Vitest tests pass, including no-replay, queue, store, projection, and reconciler tests.

- [ ] **Step 6: Inspect the final diff for scope and secret safety**

Run:

```bash
git diff --check
git diff -- src/domain/types.ts src/domain/ports.ts src/store/sqlite-store.ts src/coordinator/herdr-runtime-reconciler.ts docs/architecture.md tests/sqlite-store.test.ts tests/herdr-runtime-reconciler.test.ts tests/startup-view-converger.test.ts
git status --short
```

Expected: no whitespace errors; only the intended durability files plus the known pre-existing uncommitted work are present; no `.env`, database, log, session UUID, or terminal transcript is staged.

- [ ] **Step 7: Commit the architecture documentation after verification**

```bash
git add docs/architecture.md
git diff --cached --check
git commit -m "docs: record durable reconciler projection boundary"
```

If Tasks 1–2 were not committable because of the filesystem issue, leave this documentation uncommitted too so the resulting change set remains coherent.

## Plan self-review

### Review remediation addendum

- [ ] Add failing store coverage proving orphaning also transitions `prompt_jobs`: running work becomes failed/completed-observation and queued work becomes cancelled, with matching failed RunCards.
- [ ] Extend `orphanBindingWithProjection()` so Binding, prompt jobs, RunCards, TopicView, and outbox intents commit in one transaction. No prompt is replayed automatically.
- [ ] Add a failing reconciler test for two consecutive workspace-unavailable probes, then route the threshold-crossing probe through the fenced atomic orphan command.
- [ ] Add a failing startup test proving non-empty historical terminal scrollback establishes a baseline without replacing an already durable TopicView answer.
- [ ] Return whether an outbox row was reserved from both durable commands and wake `OutboundWorkNotifier` only after a successful commit.
- [ ] Add failing Markdown tests where middle truncation crosses one or more fenced blocks, then render retained source ranges through the existing block-aware renderer so every result is bounded and fence-balanced.
- [ ] Run the focused reconciler/store/Markdown/card/startup/stream suite, then `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.

### Spec coverage

- Durable terminal output: Task 1 implements a fenced fingerprint/view/outbox transaction, does not store raw terminal output, verifies deduplication/staleness, and proves no projector is needed for recovery.
- Durable missing pane: Task 2 atomically updates binding, applicable run cards, answer-card intents, main-card desired state, and main-card intent; it covers idempotence, stale observations, and no prompt replay.
- Event/recovery semantics: Tasks 1 and 2 make event emission post-commit and best-effort; Task 3 documents that `StartupViewConverger` delivers persisted versions rather than reparsing terminal output.
- Non-goals: all tasks preserve Herdr authority, outbox behavior, CardKit ordering, and no-replay semantics; no generic durable event bus or pagination redesign is introduced.

### Placeholder scan

Searched this plan for `TBD`, `TODO`, `implement later`, `fill in details`, `appropriate error handling`, `handle edge cases`, and `similar to Task`; none occur. Each code-bearing task specifies concrete input/result names, fences, state transitions, assertions, and commands.

### Type consistency

- `checkpointRuntimeOutputWithProjection(RuntimeOutputProjectionInput)` returns `RuntimeOutputProjectionResult` consistently in Tasks 1 and 3.
- `orphanBindingWithProjection(OrphanBindingProjectionInput)` returns `OrphanBindingProjectionResult` consistently in Tasks 2 and 3.
- Both command inputs use `bindingId`, `expectedPaneId`, and `expectedGeneration` for the same pane fence.
- `RuntimeReconciliationStore` is the only reconciler-facing port changed; CardKit rendering stays in `src/cards/`, and `StartupViewConverger` remains a delivery converger.
