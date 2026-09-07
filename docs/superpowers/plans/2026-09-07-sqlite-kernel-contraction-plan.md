# SQLite Kernel Contraction Implementation Plan

## Goal

Implement the approved kernel-contraction design without changing persistence
schema or workflow behavior. Every slice ends with focused tests and a thematic
commit.

## Slice 1: Capability graph ownership

- Add `src/store/sqlite/capability-graph.ts`.
- Construct the sole `SqliteContext`, run migrations, and instantiate all
  focused SQLite modules there.
- Let the transitional `SqliteStoreKernel` consume graph-owned modules.
- Preserve its compatibility methods without copying SQL or transactions.
- Extend architecture tests to prove that only the graph constructs the context
  and that the production bundle enters through the graph-backed kernel.
- Run architecture tests, SQLite context/store tests, strict unused checking,
  typecheck, build, and the full suite.

## Slice 2: Projection capability

- Add a projection capability adapter only where multiple existing modules are
  required to satisfy one consumer interface.
- Point `projection`, `mainCards`, `answerPages`, `queueFeedback`, and
  `workerTurnCards` bundle fields at real capability modules.
- Remove their pure forwarding methods from the kernel once no production
  consumer needs them.
- Verify projection/outbox atomicity, page freezing, continuation ordering, and
  view-version fencing.

## Slice 3: Prompt capability

- Make prompt acceptance and prompt execution complete graph capabilities.
- Preserve typed post-commit receipts and outer-transaction ownership.
- Point production prompt bundle fields at those capabilities and remove the
  replaced kernel forwarding surface.
- Verify FIFO, duplicate acceptance, prepared/accepted dispatch fencing,
  detached observation, rollback, and no replay.

## Slice 4: Binding-session capability

- Introduce a binding-session aggregate for provisioning, reconciliation, reset
  cutover, session administration, cleanup, and pane retention.
- Keep cross-table work in one shared-context transaction.
- Move corresponding production bundle entries off the kernel.
- Verify generation fences, fresh-Herdr convergence, reset atomicity, cleanup,
  and projection/outbox reservation.

## Slice 5: Control and recovery capabilities

- Consolidate exact-turn and pane control around their identity fences.
- Expose model selection, external turns, card interactions, delivery recovery,
  and inbound/startup recovery through named graph capabilities.
- Remove replaced kernel forwarding methods.
- Verify exact-turn fencing, uncertainty handling, dead-letter actions, startup
  recovery, and absence of remote approval or arbitrary terminal control.

## Slice 6: Consumer-shaped ports

- Split startup convergence and operational recovery out of prompt acceptance.
- Replace intersection-heavy bundle fields with named ports.
- Update workflows and tests to consume the smallest real capability.
- Add compile-time and architecture assertions against broad regressions.

## Slice 7: Kernel retirement and documentation

- Remove the production kernel or leave it with no forwarding surface.
- Move any indispensable broad fixture adapter under `tests/helpers`.
- Update architecture documentation and static import rules.
- Audit source and tests against every design completion criterion.

## Per-slice verification

Run affected Vitest files,
`npx tsc -p tsconfig.typecheck.json --noUnusedLocals --noUnusedParameters`,
`npm run typecheck`, `npm run build`, `npm run architecture:check`, and
`git diff --check`. Run `npm test` for every persistence/workflow slice. Commit
only after all required checks pass.

## Final verification

Run the complete suite and build checks again, inspect the production bundle and
import graph directly, map durability/FIFO/no-replay/outbox/recovery requirements
to source and tests, and require a clean worktree. Do not install, restart, push,
tag, release, or publish.
