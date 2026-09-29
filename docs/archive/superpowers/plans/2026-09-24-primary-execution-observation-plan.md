# Primary Execution and Observation Implementation Plan

## Objective

Implement the approved Primary execution/observation design without changing
Prompt FIFO order, dispatch evidence, exact transcript ownership, no-replay
recovery, lifecycle events, Card output, or SQLite schema. Complete the pass only
after interface-level behavior and repository-wide verification are green.

## Step 1: Characterize the two orchestration seams

Files:

- `tests/primary-prompt-dispatcher.test.ts`
- `tests/detached-prompt-observer.test.ts`
- existing Prompt, transcript, recovery, and concurrency tests

Actions:

1. Add interface-level tests for the current live-dispatch and detached-observer
   behavior before moving implementation.
2. Cover fresh-pane preflight, safe claim release, exact-turn completion and
   abort, superseding-turn handoff, uncertain failure, and no replay.
3. Keep existing integration tests as compatibility coverage.

## Step 2: Extract `DetachedPromptObserver`

Files:

- create `src/coordinator/detached-prompt-observer.ts`
- update `src/coordinator/prompt-run-workflow.ts`
- add `tests/detached-prompt-observer.test.ts`

Actions:

1. Move durable Prompt/Binding reload, exact transcript opening, Herdr polling,
   transcript ownership, superseding external-turn handoff, and terminal
   settlement behind `observe(prompt)`.
2. Inject registry turn attachment, active-binding lookup, lifecycle publication,
   and stopping state as narrow functions.
3. Preserve every completion, abort, uncertain, and logging outcome.
4. Keep scheduling and worker ownership in `PromptRunWorkflow`.

Verification:

```bash
npx vitest run tests/detached-prompt-observer.test.ts tests/transcript-observer.test.ts tests/external-turn-observer.test.ts
```

## Step 3: Extract `PrimaryPromptDispatcher`

Files:

- create `src/coordinator/primary-prompt-dispatcher.ts`
- update `src/coordinator/prompt-run-workflow.ts`
- add `tests/primary-prompt-dispatcher.test.ts`

Actions:

1. Move the per-binding durable FIFO loop behind `drain(bindingId)`.
2. Preserve external-turn handoff before every claim.
3. Re-read the Herdr pane and enforce identity, workspace, and runtime preflight
   before calling `PromptTurnExecutor`.
4. Release only undispatched claims through the existing durable fence.
5. Retain model Main Card convergence, active-turn registry lifecycle, control
   wake-up, draining Binding archival, and safe loop termination.
6. Do not create worker promises or timers inside the dispatcher.

Verification:

```bash
npx vitest run tests/primary-prompt-dispatcher.test.ts tests/prompt-run-safety-scan.test.ts tests/concurrency-controls.integration.test.ts
```

## Step 4: Reduce `PromptRunWorkflow` to its facade role

Files:

- `src/coordinator/prompt-run-workflow.ts`
- `src/coordinator/prompt-run-registry.ts`
- `src/composition/create-primary-runtime.ts`
- affected test fixtures

Actions:

1. Keep the existing public `PromptRunWorkflowPort` unchanged.
2. Construct the internal dispatcher and observer once in the workflow.
3. Retain scheduler subscription, safety scanner, registry exclusion, explicit
   `awake`/`skipDetached`, diagnostics, and shutdown ordering.
4. Remove live claim/preflight and detached polling implementation from the
   facade after all callers use the new modules.

## Step 5: Enforce architecture and update documentation

Files:

- `tests/architecture-boundaries.test.ts`
- `docs/architecture.md`
- `docs/architecture-boundary-inventory.md`
- `docs/superpowers/README.md`

Actions:

1. Assert that `PromptRunWorkflow` no longer claims FIFO work, inspects panes, or
   evaluates detached terminal outcomes.
2. Assert that dispatcher and detached observer do not import composition,
   concrete SQLite, Gateway, or Card renderer modules.
3. Document the final interfaces, ownership model, recovery path, and test
   evidence.
4. Mark the Primary seam complete only after requirements have direct evidence.

## Step 6: Final verification and completion audit

Run:

```bash
npx vitest run tests/primary-prompt-dispatcher.test.ts tests/detached-prompt-observer.test.ts tests/prompt-run-safety-scan.test.ts tests/transcript-observer.test.ts tests/external-turn-observer.test.ts tests/concurrency-controls.integration.test.ts tests/architecture-boundaries.test.ts
npm run typecheck
npm run build
npm run architecture:check
npm run docs:audit
npm test
git diff --check
```

Audit every invariant in the design against source and focused tests. Preserve
the clean worktree baseline and do not install, restart, or push.
