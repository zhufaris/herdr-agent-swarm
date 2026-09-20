# Consumer Seam Contraction Design

## Status

Proposed design for the selected architecture direction following the SQLite
kernel contraction. It narrows composition and workflow interfaces; it does not
change workflow behavior or persistence ownership.

## Problem

The SQLite capability graph now exposes named production capabilities, but two
consumer-side seams still obscure the real dependencies:

1. `StartupViewConverger` receives only `StartupViewStore`, then uses type
   assertions to construct `AnswerPageWorkflow` and `MainCardWorkflow` as if the
   same value also implemented `AnswerPageStore` and `MainCardStore`.
2. Instance workflows repeatedly spell anonymous intersections of broad
   `InstanceLifecycleStore`, `InstanceTurnStore`, and selected `InstanceStore`
   methods. The intersections make each caller's interface difficult to find,
   review, and preserve during refactoring.

These are interface and composition problems, not transaction problems. The
existing SQLite aggregate modules own the required atomic transitions and must
remain intact.

## Goals

- Make startup projection dependencies explicit without type assertions.
- Give stable instance workflow consumers named, consumer-shaped interfaces.
- Improve locality: a maintainer can inspect one port definition to understand
  what a workflow requires.
- Improve leverage: production composition and tests use the same narrow seams.
- Preserve the single `SqliteContext`, single primary `DatabaseSync`
  connection, migrations, and aggregate transaction ownership.
- Add architecture checks that prevent regression to unsafe startup projection
  assertions and anonymous instance-store intersections.

## Non-goals

- Splitting `SqlitePromptStore`, `SqliteWorkerTurnStore`, or other large files
  based on line count.
- Moving SQL, transactions, reducers, rendering, or outbox reservation between
  modules.
- Changing prompt or Worker-turn dispatch behavior.
- Introducing a service locator, generic repository, generic event publisher,
  second primary database connection, durable lifecycle event log, or event
  sourcing.
- Changing public commands, configuration, Lark cards, or Herdr integration.

## Considered designs

### 1. Add two more constructor parameters

Pass `AnswerPageStore` and `MainCardStore` directly to `StartupViewConverger`.
This is the smallest patch, but the positional constructor becomes broader and
composition must keep three related projection stores aligned manually.

### 2. Introduce a named startup projection capability (selected)

Define `StartupViewProjectionStores` as the composition interface containing
`startupViews`, `answerPages`, and `mainCards`. `StartupViewConverger` receives
that named object and constructs its internal workflows through the explicit
stores. The bundle still exposes the three consumer ports individually for
other workflows.

This places the seam at the consumer: it describes the complete capability
needed to converge startup views while preserving each underlying deep module.
It removes assertions, keeps dependencies discoverable, and does not add a
pass-through adapter.

### 3. Require preconstructed child workflows

Make `AnswerPageWorkflowPort` and `MainCardWorkflowPort` mandatory and remove
their construction from `StartupViewConverger`. This yields a small converger
interface but pushes repetitive wiring into every test and caller. The existing
child workflows do not vary in production, so this seam would be hypothetical
rather than useful.

## Architecture

### Startup projection seam

The composition flow becomes:

```text
SqliteCapabilityGraph
  ├─ startupViews: StartupViewStore
  ├─ answerPages:  AnswerPageStore
  └─ mainCards:    MainCardStore
             │
             v
createIngressRecoveryRuntime
             │ named StartupViewProjectionStores
             v
StartupViewConverger
  ├─ recovery and binding traversal through startupViews
  ├─ AnswerPageWorkflow through answerPages
  └─ MainCardWorkflow through mainCards
```

`StartupViewConverger` remains the orchestration module for startup-visible
state. `AnswerPageWorkflow` remains the deep module for immutable answer-page
continuation and recovery. `MainCardWorkflow` remains the deep module for
versioned Main Card convergence. No caller can obtain one capability by casting
another.

The constructor changes to an options object. This prevents positional
parameter drift and names every dependency at the call site. Tests may inject
preconstructed child workflows through optional `answerPageWorkflow` and
`mainCardWorkflow` fields, but the default construction always uses the explicit
stores.

### Instance workflow interfaces

Add named type aliases in `src/domain/ports/instance.ts` for stable consumer
roles. Each alias is a `Pick` or an intersection of existing atomic interfaces;
it does not add implementation or forwarding methods.

The initial set is limited to current, repeated workflow responsibilities:

- `InstanceMessagingStore`: accepts ordinary/follow-up/steering work, checks
  the owning Primary binding and active prompt, and reads instance state.
- `InstanceTurnSupervisionStore`: claims FIFO turns, updates exact runtime-turn
  ownership, and observes instance lifecycle.
- `WorkerTurnObservationStore`: reads exact instance/turn identity and commits
  generation- and runtime-turn-fenced projections.
- `InstanceRuntimeReconciliationStore`: reconciles instance lifecycle and wakes
  queued work based on pending-turn count.
- `InstanceControlStore`: performs instance lifecycle control and resolves the
  owning binding needed for authorization/fencing.

Names describe what the consumer can do, not which SQLite tables happen to
store it. No new adapter class is introduced because the existing instance
capability already implements these structural interfaces. Workflows import one
named interface instead of assembling anonymous intersections locally.

If inspection shows that two proposed aliases have identical semantics and
method sets, they may share one named interface. They must not be merged merely
to reduce type declarations when their invariants differ.

## Data flow and invariant preservation

This refactor changes only compile-time dependency expression and composition
wiring.

- Durable inbound acceptance still commits before dispatch.
- Ordinary prompts and Worker turns still claim in FIFO order.
- Work that may have reached TraeX remains detached or observable and is never
  automatically replayed.
- Prompt/run-card/outbox and Worker-turn/card/event/outbox changes retain their
  existing outer SQLite transactions.
- Outbox lane ordering, compare-and-swap delivery checkpoints, retry,
  dead-letter, and frozen-page behavior remain owned by the existing stores.
- Primary and Worker controls retain binding generation, pane, native session,
  logical turn, runtime turn, and runtime start-time fences.
- Fresh Herdr snapshots remain the runtime convergence authority; Lark remains
  projection only.

Because no persistence implementation moves, behavior preservation is verified
by focused workflow tests plus the full suite, not by creating replacement SQL
tests.

## Error handling and recovery

No runtime error mode changes. Startup convergence continues to isolate a
failure per binding, log a redacted warning, and proceed with remaining
bindings. Outbox recovery still wakes delivery only after durable recovery
state is recorded. Instance reconciliation and observation continue to fail
closed on missing or mismatched identity.

The type assertions being removed currently hide composition errors rather than
handle runtime errors. Explicit stores turn those errors into compile-time
failures.

## Implementation slices

1. Introduce `StartupViewProjectionStores`, migrate `StartupViewConverger` to an
   options object, update composition/tests, and prohibit the old assertions.
2. Add the named instance consumer interfaces and migrate the corresponding
   workflows without changing method calls or runtime construction.
3. Update architecture documentation and static architecture tests to describe
   and enforce the new seams.

Each slice is independently typechecked, tested, and committed. No slice mixes
behavior changes with interface contraction.

## Verification

Focused verification:

- `npx vitest run tests/startup-view-converger.test.ts`
- focused instance messaging, supervision, observation, control, and runtime
  reconciliation tests selected from the actual touched workflows;
- architecture-boundary tests and `npm run architecture:check`.

Final verification:

- `npm test`
- `npx tsc -p tsconfig.typecheck.json --noUnusedLocals --noUnusedParameters`
- `npm run typecheck`
- `npm run build`
- `npm run architecture:check`
- `npm run docs:audit`
- `git diff --check`
- clean `git status --short`

The completion audit must map every goal and invariant above to current source,
tests, command output, and commit state. Green commands alone are not sufficient
if a seam still relies on a cast, anonymous intersection, or uncovered behavior.

## Completion criteria

- No store type assertion remains in `StartupViewConverger`.
- Production composition passes all startup projection stores explicitly.
- Target instance workflows depend on named consumer interfaces and contain no
  local anonymous store intersections.
- No new database context or connection is created.
- No production behavior, persistence transaction, or authority changes.
- Architecture documentation and checks reflect the final implementation.
- All focused and final verification gates pass.
- The work is split into thematic commits and the worktree is clean.
