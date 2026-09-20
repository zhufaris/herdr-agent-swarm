# Runtime Primary Model Selection Implementation Plan

> **For agentic workers:** Execute this plan inline. This repository session
> explicitly forbids sub-agent delegation. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make `/swarm model` select the current Primary TraeX session's model
for the next ordinary turn through a durable, strictly validated, no-replay
dispatch protocol.

**Architecture:** SQLite owns session-scoped desired/effective model state and
pins a pending revision to the next FIFO prompt. The repository-owned Herdr
TraeX shim exposes session-scoped catalog lookup plus a two-phase model-aware
prompt operation: `prepare` validates and durably reserves the exact session,
thread, prompt fingerprint, and model without delivering; Swarm crosses its
durable dispatch fence; `commit` sends one TraeX `turn/start` containing both
prompt and model. Exact transcript identity converges uncertain outcomes.

**Tech Stack:** TypeScript, Node.js 22+, SQLite, Vitest, Herdr CLI adapter,
TraeX app-server JSONL protocol, Lark CardKit

**Spec:** `docs/superpowers/specs/2026-09-05-runtime-primary-model-selection-design.md`

## Global Constraints

- Scope model preference to the exact current Primary binding generation.
- Apply the model only with the next ordinary FIFO prompt; never interrupt an
  active turn or create an empty turn.
- Validate against `model/list` through the current shim-managed session peer.
- Never automate the TraeX `/model` terminal UI or write model selection as pane
  text/key input.
- Preserve Herdr as the Agent control boundary; coordinators do not open TraeX
  peer sockets.
- Persist model intent before reporting acceptance. Persist the prompt dispatch
  fence before `turn/start` can be written.
- Once `turn/start` may have reached TraeX, neither the prompt nor model operation
  is automatically replayable.
- Keep Main Card `MODEL` factual: pending or uncertain intent must not replace
  confirmed effective model evidence.
- Do not change Worker startup model behavior, provider, reasoning effort,
  verbosity, or collaboration mode.
- Preserve the current unrelated prompt-settlement and outbox worktree changes.
  Several planned shim files already contain uncommitted work; inspect and extend
  those changes instead of reverting or overwriting them.
- Do not edit generated `dist/`.

---

### Task 1: Define model preference and dispatch contracts

**Files:**

- Create: `src/domain/model-selection.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports/external.ts`
- Modify: `src/domain/ports/prompt.ts`
- Modify: `src/domain/ports/workflow.ts`
- Test: `tests/model-selection.test.ts`

**Interfaces:**

```ts
type ModelPreferenceState = "pending" | "applying" | "effective" | "uncertain";

interface ModelPreference {
  bindingId: string;
  bindingGeneration: number;
  desiredModel: string;
  desiredRevision: number;
  effectiveModel: string | null;
  effectiveRevision: number | null;
  state: ModelPreferenceState;
  dispatchPromptId: string | null;
  preparedOperationId: string | null;
  updatedAt: string;
}

interface ModelDispatch {
  name: string;
  revision: number;
}

interface ClaimedPrompt {
  binding: Binding;
  prompt: PromptJob;
  model: ModelDispatch | null;
}
```

- [ ] **Step 1: Add failing pure-domain state-transition tests**

Cover new selection over no preference, replacement of `pending`, rejection of
replacement during `applying` or `uncertain`, exact-revision promotion, stale
binding generation, confirmed pre-delivery rollback, and uncertain no-replay.

- [ ] **Step 2: Define bounded canonical model rules**

Centralize canonical-name length and character validation. Preserve catalog
names exactly after lookup. Permit a case-insensitive input match only when one
catalog entry matches. Reject empty, oversized, ambiguous, hidden, or malformed
entries.

- [ ] **Step 3: Extend dispatch contracts without changing model-free callers**

Make `claimNextDispatchablePrompt` return an optional pinned model. Extend
`HerdrPort.runPrompt` with an optional final options object carrying
`modelDispatch` plus explicit lifecycle hooks needed by the two-phase protocol.
Keep existing positional observation/signal hooks source-compatible until all
callers and tests migrate.

- [ ] **Step 4: Run domain tests**

Run `npx vitest run tests/model-selection.test.ts`.

### Task 2: Persist session model preference and pin it to FIFO claim

**Files:**

- Modify: `src/store/sqlite-records.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/sqlite-store.test.ts`

**Schema:**

Add a `binding_model_preferences` table keyed by binding ID and fenced by binding
generation. Store desired/effective model and revision, state, dispatch prompt
ID, prepared shim operation ID, and timestamps. Add model revision/name columns
to `prompt_jobs`, or a separate one-to-one dispatch table if that keeps migration
and mapping clearer. The prompt record must retain the revision needed for
reconciliation after restart.

- [ ] **Step 1: Add fresh- and upgrade-database tests before migration code**

Assert checked states, non-negative monotonic revisions, one row per binding,
foreign keys, unique dispatch ownership, and no fabricated effective model for
existing databases.

- [ ] **Step 2: Implement transactional selection acceptance**

Add store operations to read a preference and atomically accept a canonical
selection. A new request increments `desiredRevision`. It may replace only a
`pending` revision. `applying` and `uncertain` return a deterministic busy
outcome. Fence every write by binding generation.

- [ ] **Step 3: Pin the latest pending revision during prompt claim**

In the same `BEGIN IMMEDIATE` transaction that changes a FIFO prompt from
`queued` to `running`, attach the latest pending revision to that prompt and
change the preference to `applying`. Remove the current
`pane_control_operations(kind='model')` exclusion because model intent no longer
owns a separate control queue slot.

- [ ] **Step 4: Add explicit dispatch transitions**

Provide generation-, prompt-, and revision-fenced methods for:

- recording a successful shim `prepare`;
- crossing the durable dispatch fence before shim `commit`;
- promoting an accepted exact turn to `effective`;
- returning to `pending` only after a proven pre-delivery failure; and
- changing an attempted delivery to `uncertain`.

Keep these transitions transactional with the corresponding prompt lifecycle
state. Do not introduce a path from `uncertain` to dispatchable work.

- [ ] **Step 5: Integrate startup recovery**

When a prompt was claimed but no prepare/fence occurred, return it and its model
revision to the existing safe queued/pending state. When the dispatch fence was
crossed, detach the prompt and mark the preference uncertain. Retain exact prompt
and revision identity for transcript reconciliation.

- [ ] **Step 6: Retire legacy model-control rows safely**

Startup recovery rejects historical accepted/running/applied model rows using the
existing unsupported message; it must not convert them into new model preference
intent because their catalog and runtime identity were never validated. Stop
creating new model rows in `pane_control_operations` after the new workflow is
wired.

- [ ] **Step 7: Run store tests**

Run `npx vitest run tests/sqlite-store.test.ts`. Expected: transactional claim,
revision fencing, migration, recovery, and no-replay cases pass.

### Task 3: Add a bounded session model catalog operation to the shim

**Files:**

- Modify: `src/runtime/traex-session-peer.ts`
- Create: `src/runtime/traex-model-protocol.ts`
- Modify: `src/runtime/herdr-traex-shim.ts`
- Modify: `src/cli/herdr-traex-shim.ts`
- Modify: `scripts/herdr-traex-command-shim.sh`
- Modify: `scripts/install-herdr-traex-shim.sh`
- Create: `tests/traex-model-protocol.test.ts`
- Modify: `tests/herdr-traex-shim.test.ts`
- Modify: `tests/herdr-traex-shim-install.test.ts`

**Interfaces:**

```text
herdr agent model-list <target> \
  --agent-session <json> --timeout <ms>
```

The result is a bounded structured envelope containing canonical selectable
models and the catalog's current model when the protocol exposes it.

- [ ] **Step 1: Add failing parser and peer-protocol tests**

Cover exact command parsing, missing session fence, UUID validation, replaced
session, symlink/owner/mode rejection, socket byte limit, RPC timeout, invalid
JSON, wrong response ID, and model-list pagination loops.

- [ ] **Step 2: Factor a reusable authenticated peer RPC client**

Extract the duplicated initialize/socket framing from native steering into a
bounded local peer client. Preserve the current native-steering behavior and
tests. Require owner-only socket permissions, expected peer/session identity,
bounded response bytes, and exact request IDs.

- [ ] **Step 3: Implement paginated `model/list`**

Send `initialize`, `initialized`, then `model/list` with a bounded page size,
`includeHidden: false`, and explicit cursor traversal. Bound total pages and
entries, detect repeated cursors, and validate required model fields. Return only
the bounded fields required for selection cards and canonical matching.

- [ ] **Step 4: Expose the query through the Herdr-compatible shim**

Resolve the target with official Herdr `agent get`, require
`display_agent=traex` plus exact projected session identity, find the matching
peer, and call the protocol module. Do not fall back to `traex debug models` or
terminal reads.

- [ ] **Step 5: Preserve overlapping prompt-settlement work**

Rebase the parser additions onto the existing uncommitted `prompt-traex`
interception and settlement changes. Keep each invocation mutually exclusive and
retain the current exact-command delegation behavior.

- [ ] **Step 6: Run focused shim tests**

Run `npx vitest run tests/traex-model-protocol.test.ts tests/herdr-traex-shim.test.ts tests/herdr-traex-shim-install.test.ts tests/traex-native-steering.test.ts`.

### Task 4: Implement two-phase model-aware prompt dispatch

**Files:**

- Modify: `src/runtime/traex-model-protocol.ts`
- Modify: `src/runtime/herdr-traex-shim.ts`
- Modify: `src/cli/herdr-traex-shim.ts`
- Modify: `src/adapters/herdr-adapter.ts`
- Modify: `src/domain/ports/external.ts`
- Modify: `src/infra/command-runner.ts` only if the adapter cannot express the
  prepare/commit sequence without broadening the generic runner
- Test: `tests/traex-model-protocol.test.ts`
- Test: `tests/herdr-traex-shim.test.ts`
- Test: `tests/herdr-adapter.test.ts`
- Test: `tests/command-runner.test.ts`

**Two-phase protocol:**

```text
herdr agent model-prompt prepare <target> \
  --model <name> --model-revision <revision> \
  --prompt-sha256 <digest> --agent-session <json> --timeout <ms>

herdr agent model-prompt commit <operation-id> <text> \
  --prompt-sha256 <digest> --timeout <ms>
```

`prepare` writes a private, owner-only shim record after validating the exact
target/session/thread, idle state, catalog membership, model revision, and prompt
fingerprint. It has no TraeX turn side effect. The adapter then invokes the
Swarm `onDispatched` callback, which durably marks the prompt as potentially
deliverable. Only after that callback succeeds may it invoke `commit`.

- [ ] **Step 1: Add failing two-phase safety tests**

Prove that prepare never sends `turn/start`; commit cannot run without an exact
prepared operation; prompt/model/revision/session/thread mismatches reject before
write; a duplicate commit never emits a second turn; and a crash after the
dispatch fence but before commit is uncertain rather than replayable.

- [ ] **Step 2: Persist private shim operation records**

Use an owner-only operation directory and atomic create/replace rules analogous
to native steering. Store only operation ID, target/session/thread identity,
model, revision, prompt digest, state, timestamps, and bounded result metadata.
Do not store prompt text. States are `prepared | dispatching | accepted |
rejected | uncertain`. A stale `prepared` record has no external effect and may
be expired; `dispatching` is never automatically retried.

- [ ] **Step 3: Implement atomic commit-to-`turn/start` behavior**

On commit, atomically change the shim record from `prepared` to `dispatching`
before writing to the validated peer socket. Send one `turn/start` with exact
thread ID, one text `UserInput`, and canonical model. Parse a `TurnStartResponse`
and require a valid new turn ID. Persist `accepted` with that turn ID before
returning the structured Herdr-compatible receipt.

- [ ] **Step 4: Classify failures by the shim record, not process spawn alone**

An explicit prepare rejection is not delivered. Any adapter failure after the
Swarm dispatch fence queries the prepared operation result:

- `prepared` with proven commit never invoked may be marked rejected by an
  explicit compare-and-swap abort operation; only after that abort confirms the
  record can never enter `dispatching` may Swarm transactionally clear
  `dispatched_at`, requeue the prompt, and return the revision to `pending`;
- `dispatching` or missing response is uncertain;
- `accepted` returns its exact turn ID idempotently; and
- terminal rejected results cannot be recommitted.

Do not use generic child-process spawn as proof that `turn/start` was written.

- [ ] **Step 5: Integrate transcript settlement**

After acceptance, reuse the existing typed transcript reader to observe the exact
turn through completion and emit the same structured Agent result expected by
`HerdrCliAdapter.runPrompt`. Preserve `--until`, timeout, abort, and current
`agent_prompt_stalled` recovery behavior for model-free prompts.

- [ ] **Step 6: Add adapter support and redaction**

For model-aware input, the adapter runs prepare, invokes the durable
`onDispatched` callback, then runs commit. Return the exact accepted runtime turn
ID through a new receipt hook so SQLite can promote the correct revision. Keep
prompt text and sensitive session data redacted in command errors; additionally
bound and sanitize model names in errors. Model-free `runPrompt` retains its
existing command and classification.

- [ ] **Step 7: Run protocol and adapter tests**

Run `npx vitest run tests/traex-model-protocol.test.ts tests/herdr-traex-shim.test.ts tests/herdr-adapter.test.ts tests/command-runner.test.ts`.

### Task 5: Replace the rejecting ModelSelectionWorkflow

**Files:**

- Modify: `src/coordinator/model-selection-workflow.ts`
- Modify: `src/coordinator/pane-control-workflow.ts`
- Modify: `src/coordinator/session-operation-workflow.ts`
- Modify: `src/domain/session-operation-policy.ts`
- Modify: `src/coordinator/card-action-router.ts`
- Modify: `src/composition/create-bridge-runtime.ts`
- Modify: `tests/helpers/create-test-router.ts`
- Modify: `tests/model-command-integration.test.ts`
- Modify: `tests/session-operation-policy.test.ts`
- Modify: `tests/session-operation-workflow.test.ts`
- Modify: `tests/architecture-boundaries.test.ts`

**Interfaces:**

- `ModelSelectionWorkflow.query(...)` resolves exact session identity and returns
  catalog plus durable preference.
- `ModelSelectionWorkflow.select(...)` validates a catalog name and persists a
  new pending revision.
- Neither method creates a `pane_control_operations` row.

- [ ] **Step 1: Replace unsupported integration tests with query/set tests**

Cover no active binding, non-TraeX pane, non-shim session, unavailable peer,
catalog timeout, exact match, unique case-insensitive match, ambiguous match,
unknown/hidden model, duplicate Lark event, active turn, pending replacement, and
applying/uncertain rejection. Assert zero terminal input and zero ordinary prompt
creation.

- [ ] **Step 2: Add a structured model-catalog port**

Expose catalog lookup through `HerdrPort` or a narrow model-control port backed
by the adapter/shim command. Pass exact pane and Agent session identity. Avoid
coupling the workflow directly to `TraexSessionPeer`.

- [ ] **Step 3: Implement query and mutation**

Verify active/attached binding, chat, creator-and-administrator policy, pane, and
session identity. Fetch the current session catalog, canonicalize the selection,
and call the transactional preference store. Audit only canonical model and
outcome. Wake outbound delivery but not prompt dispatch merely because a model
was selected.

- [ ] **Step 4: Retire old model operation behavior**

Remove model execution from `PaneControlWorkflow`. Keep one startup compatibility
path that terminalizes legacy recoverable model rows without dispatch. Remove the
blanket rejection from session-operation policy and historical card handling only
where current authorized model callbacks are now supported. Stale interaction
and binding-generation checks remain.

- [ ] **Step 5: Run workflow tests**

Run `npx vitest run tests/model-command-integration.test.ts tests/session-operation-policy.test.ts tests/session-operation-workflow.test.ts tests/architecture-boundaries.test.ts`.

### Task 6: Apply and reconcile the pinned model in PromptRunWorkflow

**Files:**

- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `src/coordinator/prompt-execution-lifecycle.ts`
- Modify: `src/coordinator/external-turn-observer.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/concurrency-controls.integration.test.ts`
- Test: `tests/prompt-execution-lifecycle.test.ts`
- Test: `tests/external-turn-observer.test.ts`
- Test: `tests/model-command-integration.test.ts`

- [ ] **Step 1: Pass the claimed model revision only to its pinned prompt**

Use the extended claim result in `drain`. A later model command cannot change the
already claimed value. A prompt without a pinned model uses the untouched native
Herdr prompt path.

- [ ] **Step 2: Persist prepare, dispatch, and acceptance in the correct order**

Record the shim operation after prepare. In the adapter's pre-commit callback,
atomically call `markPromptDispatched` and mark the preference dispatch-fenced.
On exact accepted turn receipt, persist transcript turn identity and promote the
same model revision to effective. Late callbacks are fenced by prompt, binding
generation, revision, and prepared operation ID.

- [ ] **Step 3: Preserve explicit pre-delivery retry behavior**

Catalog or identity failure during prepare occurs before `onDispatched`; fail the
current prompt according to existing policy and return its model revision to
pending. Do not silently send that prompt without its selected model.

- [ ] **Step 4: Extend detached reconciliation**

If commit may have happened, detach and observe without replay. An exact fresh
transcript turn owned by the prompt promotes the model revision to effective. An
explicit shim compare-and-swap abort of a still-`prepared` operation proves no
commit can begin and permits the transactional prompt/preference rollback. A
mere read of `prepared` is insufficient because a commit process could race the
reader. Missing, `dispatching`, or conflicting evidence leaves the model
uncertain and blocks later model mutations.

- [ ] **Step 5: Test concurrency and restart boundaries**

Cover selection while a turn is active, two queued prompts, a later pending
replacement before claim, selection during an applying dispatch, crash after
prepare, crash after SQLite dispatch fence, response loss after socket write,
exact transcript recovery, conflicting transcript turn, and service restart.
Assert at most one `turn/start`.

- [ ] **Step 6: Run dispatch/recovery tests**

Run `npx vitest run tests/concurrency-controls.integration.test.ts tests/prompt-execution-lifecycle.test.ts tests/external-turn-observer.test.ts tests/model-command-integration.test.ts`.

### Task 7: Project model state into cards and documentation

**Files:**

- Modify: `src/cards/model-card.ts`
- Modify: `src/domain/topic-view.ts`
- Modify: `src/events/conversation-view-projector.ts`
- Modify: `src/coordinator/main-card-workflow.ts`
- Modify: `src/cards/main-card.ts` or the current Main Card renderer
- Modify: `tests/run-card.test.ts`
- Modify: `tests/topic-view.test.ts`
- Modify: `tests/main-card-workflow.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/feishu-group-usage.md`

- [ ] **Step 1: Render structured catalog and preference state**

Replace terminal-text parsing in `model-card.ts` with a structured input model.
Render confirmed current model, pending next-turn model, applying prompt, and
uncertain warning distinctly. Keep selector options bounded and canonical.

- [ ] **Step 2: Keep Main Card metrics factual**

Update `MODEL` only from confirmed effective or structured runtime evidence. Add
a separate pending/uncertain hint without overwriting the metric. Preserve card
sequence ordering and immutable frozen answer pages.

- [ ] **Step 3: Make result updates durable and idempotent**

Persist the accepted model-result card and every later state update through the
outbox. Use revision-based idempotency keys so delivery retry cannot cause a
second model operation or prompt.

- [ ] **Step 4: Update operator and architecture documentation**

Replace all claims that runtime model selection is unsupported. Document current-
Primary scope, current-session catalog validation, next-turn activation, busy/
uncertain behavior, exact recovery, and absence of terminal-menu fallback.

- [ ] **Step 5: Run projection and documentation tests**

Run `npx vitest run tests/run-card.test.ts tests/topic-view.test.ts tests/main-card-workflow.test.ts tests/docs-audit.test.ts`.

### Task 8: Verify the complete change and perform disposable runtime acceptance

**Files:**

- Modify tests or docs only for defects discovered by verification.
- Do not modify generated `dist/` directly.

- [ ] **Step 1: Run all focused suites from Tasks 1-7**

Re-run every focused command after integration. Resolve failures at their owning
boundary; do not weaken identity or no-replay assertions.

- [ ] **Step 2: Run repository gates**

Run:

```bash
npm run typecheck
npm run build
npm test
git diff --check
```

- [ ] **Step 3: Install the built shim only after tests pass**

Use the repository's supported shim installation command and record the immutable
release/build identity. Do not restart the production swarm as part of this step.

- [ ] **Step 4: Run a disposable real-session acceptance test**

Create an isolated Herdr pane and temporary repository. Verify:

1. `/model` or `/status` reports model A initially;
2. the shim catalog contains model B;
3. selecting B while idle creates only pending durable intent;
4. the next prompt creates exactly one `turn/start` with model B;
5. the turn completes through structured transcript settlement;
6. `/status` reports model B for the same session;
7. the following model-free prompt remains on B; and
8. a forced response-loss case does not replay the prompt.

Destroy only the disposable pane/repository after capturing bounded evidence.
Do not use or mutate the production Primary.

- [ ] **Step 5: Prepare thematic commits**

Keep commits independently reviewable: domain/store, shim protocol, workflow/
dispatch, cards/docs. Stage around unrelated pre-existing changes with
`git add -p` or explicit paths. Do not push unless separately requested.

## Final Acceptance Checks

- `/swarm model` lists models for the exact current Primary session.
- `/swarm model <name>` never changes or interrupts the active turn.
- The latest pending selection is pinned transactionally to the next FIFO prompt.
- Prompt and model are delivered in one `turn/start`; no terminal UI input occurs.
- The durable dispatch fence exists before socket write.
- A response loss after possible delivery never authorizes prompt replay.
- Exact transcript evidence can converge an uncertain model-aware turn.
- Main Card distinguishes confirmed current model from pending/uncertain intent.
- Other Primary sessions, Workers, provider, effort, verbosity, and collaboration
  mode are unchanged.
