# Prompt Acceptance Deep Module Design

## Goal

Move Primary prompt admission out of the broad `SqlitePromptStore` into one
deep SQLite module without changing message semantics, schema, transaction
boundaries, or application-facing ports.

## Problem

After prompt recovery was extracted, `SqlitePromptStore` still combines four
different bodies of knowledge: acceptance, FIFO dispatch, exact transcript
ownership, and externally originated Herdr turns. Admission is a cohesive and
safety-sensitive transaction of its own:

- deduplicate an inbound message;
- fence the Binding generation and active attachment;
- enforce ordinary and priority queue capacity;
- persist the Prompt, Run Card, and Answer-card delivery intent atomically;
- expose process-local wake-ups only after the transaction commits;
- validate and consume interrupted-task continuation authority exactly once.

Keeping this behavior beside dispatch and transcript transitions makes changes
to ingress safety require understanding unrelated runtime state changes. It
also leaves the implementation owner of `PromptAcceptanceStore` implicit.

## Selected module

Introduce `SqlitePromptAcceptanceStore` over the existing shared
`SqliteContext`. It owns:

- `enqueuePrompt`;
- `acceptPrompt`;
- `acceptPromptWithEffects`;
- `acceptInterruptedContinuation`.

The module interface is durable prompt admission, not CRUD over
`prompt_jobs`. It receives the existing projection module plus only two narrow
queries: current Binding lookup and pending Prompt count. It may update
`prompt_jobs`, `run_cards`, `outbound_replies`, and `card_interactions` in one
outer transaction because those rows form one admission decision.

`SqlitePromptCapabilityStore` composes acceptance, dispatch, and recovery
implementations behind the existing application ports. The public
`PromptAcceptanceStore` and `PromptRunStore` shapes do not change in this
slice. `SqliteCapabilityGraph` remains the sole constructor and supplies the
shared transaction context. The test compatibility kernel delegates its direct
acceptance helpers to the graph-owned module.

## Alternatives

### Split only the application interface

The application already has a named `PromptAcceptanceStore` port. Adding more
types without moving SQL would create a shallow seam and would not improve
locality.

### Extract external-turn adoption first

External adoption is also cohesive, but it overlaps exact transcript ownership
and supersession policy. Admission is the cleaner next seam because all its
writes begin at one trusted inbound decision and existing tests already cover
its atomic outcome.

### Create repositories per table

This would expose transaction choreography to callers. Prompt admission must
commit Prompt, projection, delivery intent, and continuation ownership as one
decision, so table-shaped repositories are deliberately rejected.

## Invariants

- An inbound message ID creates at most one Prompt and returns its original Run
  Card on duplicate delivery.
- Binding generation, lifecycle, state, and attachment checks occur in the same
  outer transaction as insertion.
- Queue-depth and priority-turn gates remain unchanged.
- Prompt, Run Card, and Answer create intent commit atomically.
- A `PromptAcceptanceReceipt` exposes effects only after commit and exposes no
  effects for duplicate acceptance.
- A continuation consumes exactly one active, unexpired, creator-owned
  interaction and remains idempotent after consumption.
- The module uses the existing `SqliteContext`; it creates no connection and no
  migration.

## Testing

Add an architecture test that requires all four admission methods to live in
`prompt-acceptance-store.ts`, prohibits them from `prompt-store.ts`, and proves
the capability adapter and graph delegate to the new module. Preserve existing
behavior tests for duplicate messages, rollback, generation fences, queue
capacity, priority turns, committed effects, and continuation consumption. Run
the architecture and SQLite suites, inbound/card interaction integration tests,
typecheck, build, the complete Vitest suite, and `git diff --check`.

## Non-goals

- No schema migration or persisted-state rewrite.
- No change to FIFO ordering, dispatch, model selection, external-turn adoption,
  recovery, cards, commands, or visible text.
- No application-port redesign in this slice.
- No production installation or restart.
