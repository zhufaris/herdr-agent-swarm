# Prompt Recovery Deep Module Design

## Goal

Move Primary prompt recovery and uncertain-result convergence out of the broad
`SqlitePromptStore` into one deep persistence module without changing user
behavior, schema, transaction boundaries, or the public application capability.

## Problem

`SqlitePromptStore` currently owns several distinct bodies of knowledge:

- prompt acceptance and FIFO claim;
- model-selection dispatch transitions;
- exact transcript ownership and external-turn adoption;
- restart recovery, stale-claim recovery, detached settlement, manual skip, and
  terminal-binding backlog cleanup;
- queue feedback and Answer projection coordination.

The recovery cluster is safety-critical and cohesive, but it is spread across a
600-line implementation. Changes to no-replay behavior require understanding
unrelated prompt acceptance and model-selection code. This reduces locality and
makes recovery invariants harder to review.

## Selected module

Introduce `SqlitePromptRecoveryStore` as an internal SQLite module over the
existing shared `SqliteContext`. It owns these operations:

- `recoverRunningPrompts`;
- `scanDurablePromptWork`;
- `listStaleUndispatchedPromptClaims`;
- `requeueStaleUndispatchedPromptClaim`;
- `releaseUndispatchedPromptClaim`;
- `listDetachedPrompts`;
- `settleDetachedPrompt`;
- `skipOldestDetachedPrompt`.

Its interface is the recovery lifecycle, not CRUD over `prompt_jobs`. The module
may update Prompt, Run Card, Topic View, model-preference, audit, and outbox rows
inside one shared transaction because those writes form one recovery decision.
It receives only the existing projection, binding transition, and outbox
collaborators required for those atomic outcomes.

`SqlitePromptCapabilityStore` composes the dispatch-oriented
`SqlitePromptStore` and the recovery module behind the existing
`PromptRunStore` interface. This preserves application callers during this
slice while making the implementation ownership explicit. A later slice may
split the application-facing interface after the implementation boundary is
stable.

## Alternatives

### Keep one store and split only the TypeScript interface

This would reduce compile-time visibility but leave recovery SQL and transaction
knowledge mixed with dispatch and acceptance. The deletion test fails because
removing the new interface would not move any implementation complexity.

### Split one repository per table

This would expose transaction choreography to callers and create shallow CRUD
modules. Prompt recovery intentionally spans multiple tables, so table-shaped
repositories are the wrong seam.

## Invariants

- Never requeue a prompt with durable evidence that it may have reached TraeX.
- Stale and immediate release paths remain compare-and-swap fenced.
- Binding generation and pane identity fence immediate pre-dispatch release.
- Detached prompt settlement verifies exact prompt ownership before terminal
  transition.
- Manual skip updates Prompt, Run Card, Topic View, outbox intent, and audit as
  one transaction.
- Startup recovery preserves model-preparation uncertainty and does not fabricate
  transcript identity.
- The module opens no database connection of its own and owns no schema migration.

## Testing

Existing tests through `SqliteBindingStore` and `PromptRunStore` remain the
behavioral contract. Add an architecture test proving recovery SQL and named
operations live only in `prompt-recovery-store.ts`, while
`SqlitePromptCapabilityStore` delegates to the recovery module. Run focused
SQLite, prompt safety, concurrency, and lifecycle tests, followed by typecheck,
build, architecture checks, the complete Vitest suite, and `git diff --check`.

## Non-goals

- No schema migration.
- No change to FIFO ordering, retry timing, cards, commands, or user-visible text.
- No production SQLite repair or service restart.
- No split of the application-facing `PromptRunStore` interface in this slice.
