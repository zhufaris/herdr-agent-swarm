# Runtime Model Preference Deep Module Implementation Plan

## Objective

Concentrate `/swarm model` lifecycle decisions behind one deep domain module,
make prompt execution report one typed stream of dispatch evidence, and render
the model card and Main Card from the same presentation snapshot without
changing next-ordinary-prompt, FIFO, exact-session, or no-replay semantics.

Each work package is a vertical TDD slice: add one failing behavior test, make
the smallest implementation pass, then run the focused gate before proceeding.

## Confirmed test seams

- `RuntimeModelPreference` pure interface for selection decisions, dispatch
  evidence transitions, and presentation snapshots.
- `PromptDispatchStore` temporary-SQLite interface for atomic prompt claim and
  durable fenced transitions.
- `ModelSelectionWorkflowPort` for text-command and CardKit behavior.
- `PromptTurnExecutor` for mapping structured TraeX callbacks to evidence.
- `ApplicationPresentation` for model-card and Main Card projections.

Tests must not reach through these seams to assert private collaborators.

## Invariants

- A validated selection applies only to the next ordinary FIFO prompt.
- Steering and control work do not consume a model preference.
- Prompt claim and model-revision pinning stay in one SQLite transaction.
- Exact binding generation, prompt, revision, operation, and native session
  identity fence every effect.
- Work that may have reached TraeX is never automatically replayed.
- Preference intent is persisted before card delivery; delivery retry never
  repeats selection or prompt submission.
- Text commands create reply cards; card callbacks update the originating card.

## Work package 1: Deep domain module and shared snapshot

### Red

- Add interface-level tests for selecting from null, pending, effective,
  applying, uncertain, and stale-generation states.
- Add table-driven tests for `prepared`, `prepare_aborted`, `accepted`, and
  ambiguous failure evidence, including every fence mismatch.
- Add literal snapshot expectations for pending, applying, effective,
  uncertain, and absent preferences.

### Green

- Replace standalone transition helpers with a `RuntimeModelPreference` module
  exposing request, evidence, and snapshot operations.
- Define one discriminated dispatch-evidence type so callers cannot select a
  persistence transition directly.
- Define an immutable presentation snapshot consumed by both card surfaces.
- Retain persisted state names and schema compatibility.

### Focused gate

- `npx vitest run tests/model-selection.test.ts tests/topic-view.test.ts`
- `npm run typecheck`

## Work package 2: Atomic SQLite adapter

### Red

- Extend SQLite tests to prove prompt claim and preference pinning commit or
  roll back together.
- Prove evidence events are idempotent only for the exact fence and reject
  stale generation, revision, prompt, or operation IDs.
- Prove pre-prepare failure returns to pending while post-prepare ambiguity
  becomes uncertain and survives recovery.

### Green

- Make the SQLite model-preference implementation delegate decisions to the
  deep module while keeping SQL compare-and-set fences authoritative.
- Replace the three executor-facing transition methods with one
  `recordModelDispatchEvidence` method.
- Keep model pinning inside `claimNextDispatchablePrompt` and return the pinned
  dispatch as part of the existing claimed-prompt result.
- Update capability adapters and test fakes without widening composition roots.

### Focused gate

- `npx vitest run tests/sqlite-store.test.ts tests/sqlite-capability-graph.test.ts`
- `npm run typecheck`

## Work package 3: Workflow and executor migration

### Red

- Extend command integration tests for pending replacement, applying/uncertain
  busy refusal, stale session refusal, text reply-card creation, and callback
  same-card update.
- Add executor tests proving each structured TraeX callback emits the correct
  evidence and that a rejected fence aborts dispatch safely.

### Green

- Make `ModelSelectionWorkflow` consume module outcomes and snapshots rather
  than interpreting persistence states.
- Make `PromptTurnExecutor` report typed evidence through one store method.
- Preserve exact native TraeX identity checks, normal scheduler wake-up, Main
  Card convergence, and existing no-replay failure classification.

### Focused gate

- `npx vitest run tests/model-command-integration.test.ts tests/prompt-turn-executor.test.ts`
- `npm run typecheck`

## Work package 4: Unified state presentation

### Red

- Add model-card tests for absent, pending, applying, effective, and uncertain
  snapshots, including compact revision text and the no-retry warning.
- Add Main Card tests proving the same snapshots produce consistent state hints
  without replacing confirmed runtime model telemetry.
- Retain a regression for Feishu error `230001`: text-originated commands never
  enqueue a card update against a text message.

### Green

- Change `renderModelSelectionCard` and Main Card projection to consume the
  shared snapshot.
- Keep selection controls and deterministic state colors while making current,
  next, applying, and uncertain states explicit.
- Keep internal session UUIDs, prompt IDs, and operation IDs out of visible card
  text.
- Update architecture and operator documentation against implemented behavior.

### Focused gate

- `npx vitest run tests/model-card.test.ts tests/model-command-integration.test.ts tests/main-card-workflow.test.ts tests/run-card.test.ts`
- `npm run typecheck`
- `npm run build`

## Work package 5: Final verification and deployment

- Run all directly affected tests.
- Run the full `npm test` suite.
- Run `npm run typecheck`, `npm run build`, and `git diff --check` on touched
  files.
- Inspect prompt, outbox, and service health before deployment.
- Stage the immutable release with `./install.sh`.
- Force-restart with `npm run swarm:restart -- --force` and verify `/ready`,
  SQLite health, build identity, service PID, and recent error logs.

## Separate queued slice

After the model work is stable, remove the standalone `👤 Human message` card
through its own Answer/outbox TDD slice. Do not mix that presentation change
into the model lifecycle commits.
