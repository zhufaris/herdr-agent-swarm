# Swarm Command Bounded Context Implementation Plan

**Goal:** Migrate every `/swarm` command through one DDD command boundary, add durable mutation intent and recovery, unify text/CardKit Worker creation, and correct Primary dual-identity verification.

**Spec:** `docs/superpowers/specs/2026-09-05-swarm-command-context-design.md`

## Constraints

- Work only in `feat/swarm-command-context`.
- Preserve all existing `/swarm` syntax and visible behavior.
- Do not migrate legacy non-`/swarm` instance commands except the CardKit Worker-create adapter.
- Business aggregates and specialized operation tables remain authoritative.
- Never replay an external side effect after uncertain dispatch.
- Keep the main checkout's prompt-settlement WIP untouched.

## Slice 1: Command language and policy

- Extend the command union and parser with `/swarm worker create`.
- Add exhaustive command metadata for query/mutation, scope, authorization, replay policy, and handler ownership.
- Add parser and manifest tests that fail when a command variant is unclassified.

## Slice 2: Context resolution and runtime identity

- Add immutable `SwarmCommandContext` value objects and typed rejection results.
- Resolve global, project, Primary-session, and active-turn scopes from durable state.
- Add a reusable dual-identity verifier comparing terminal and native identities only within their own dimensions.
- Add the exact `task-di58` regression and genuine identity-replacement failures.

## Slice 3: Durable mutation aggregate

- Add `CommandIntent`, lifecycle transitions, replay policies, and a capability-focused store port.
- Add a forward-only SQLite migration, atomic acceptance, binding-lane claim, terminalization, deduplication, and startup recovery.
- Test duplicate delivery, concurrent claims, stale executing recovery, and independent binding lanes.

## Slice 4: Gateway and handlers

- Add `SwarmCommandGateway` as the sole `/swarm` entry point.
- Route queries synchronously without command rows.
- Route mutations through durable acceptance and dispatch to narrow adapters over existing workflows.
- Reduce `InboundMessageRoutingWorkflow` to command, legacy-instance-command, and ordinary-message routing.
- Wire notifier, startup recovery, periodic scan, and shutdown into the composition root.

## Slice 5: Worker creation convergence

- Add the Worker-create handler and canonical argument normalization.
- Route `/swarm worker create` and CardKit create submission through the same handler.
- Persist exact Primary binding, generation, pane, terminal, and native-session fences.
- Preserve Worker capacity, scoped-name, worktree, and optional-start semantics.

## Slice 6: Command-by-command migration verification

- Cover every command in the spec inventory with route, scope, authorization, durability, and outcome assertions.
- Verify queries do not create intent rows.
- Verify mutations deduplicate and never replay uncertainty.
- Re-run existing provisioning, pane-control, session-administration, operations, Worker, and routing suites.

## Slice 7: Completion audit and commits

- Run focused tests after each slice.
- Run `npm run typecheck`, `npm run build`, `npm run docs:audit`, and the full Vitest suite.
- Map every spec verification item and every command inventory row to concrete source/tests.
- Commit design, domain/persistence, routing/handlers, and final fixes as thematic commits.
