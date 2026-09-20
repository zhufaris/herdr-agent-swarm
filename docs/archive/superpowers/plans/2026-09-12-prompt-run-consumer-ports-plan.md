# Prompt Run Consumer Ports Implementation Plan

**Goal:** Replace broad `PromptRunStore` dependency exposure with three real
consumer-shaped production capabilities.

## Task 1: Lock the seam

- Add architecture assertions for the three interfaces and bundle fields.
- Reject the old `PromptRunStore` and `store: PromptRunStore` workflow shape.
- Run the focused test red.

## Task 2: Define and adapt ports

- Define `PromptDispatchStore`, `PromptRecoveryStore`, and `PromptSessionStore`.
- Replace the broad SQLite capability adapter with three focused adapters over
  the existing implementation modules.
- Expose three bundle fields and remove `promptRun`.

## Task 3: Rewire consumers

- Change `PromptRunWorkflow` to receive named stores.
- Give executor, safety scanner, and transcript observer only their required
  interfaces.
- Update production composition and test constructors.

## Task 4: Verify and commit

- Run architecture, prompt safety, concurrency, steering, transcript, lifecycle,
  SQLite, typecheck, build, and the full suite.
- Run `git diff --check` and commit independently.
