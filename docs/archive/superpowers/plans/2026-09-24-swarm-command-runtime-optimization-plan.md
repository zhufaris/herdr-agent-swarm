# Swarm Command Runtime Optimization Implementation Plan

## Objective

Replace the remaining source-shaped Swarm command interface with one deep
runtime, make mutation admission promptly asynchronous, converge each mutation
through a durable same-card status projection, and apply typed risk definitions
to natural-language confirmation and help behavior without weakening identity
fences, FIFO ordering, or no-replay recovery.

The work is delivered as behaviorally coherent slices. Each slice starts with a
failing focused test, preserves a usable repository state, passes its focused
gate, and receives a thematic commit before the next slice begins.

## Invariants

- SQLite remains the durable workflow authority; the EventBus and bounded
  waiters are wake-up and latency aids only.
- Herdr remains authoritative for current Pane, terminal, foreground process,
  Agent session, and turn identity.
- A command that may have reached an external effect is never automatically
  replayed.
- Same-lane commands remain FIFO; unrelated lanes may progress independently.
- Lark delivery retries never repeat command execution.
- High-risk TraeX approval remains local to Herdr.
- Existing literal syntax, aliases, permissions, and project routing remain
  compatible.
- SQLite schema changes are additive and existing databases remain readable.

## Dependency and seam strategy

The new `SwarmCommandRuntime` is the external module and principal test surface.
Pure policy, definitions, normalization, and projections are in-process
dependencies hidden inside it. SQLite is local-substitutable through temporary
database tests and remains behind consumer-shaped store capabilities. Herdr and
Lark are true external dependencies injected through their existing ports and
tested with fakes. Existing provisioning, session, Pane, model, Prompt recovery,
and Worker workflows are internal collaborators, not new public runtime methods.

New interface tests replace source-specific orchestration tests when they cover
the same behavior. Adapter protocol tests and focused workflow tests remain at
real seams. Do not retain parallel old and new tests solely to preserve the old
module shape.

## Work package 1: Typed command definitions

### Characterization

- Add exhaustive tests mapping every `BridgeCommand["kind"]` to mode, scope,
  authorization, replay policy, risk, handler, syntax, summary, and examples.
- Preserve the input-sensitive `model` query/mutation distinction.
- Add risk-matrix cases for literal, natural-language, CardKit, and Primary Tool
  sources without changing runtime behavior yet.
- Characterize the existing help card and parser results for every literal
  command and alias.

### Implementation

- Extend the current closed command policy map into typed command definitions.
- Add `SwarmCommandRisk` and a pure source/risk decision function.
- Keep parsing explicit and keep all current command shapes unchanged.
- Make context resolution and the dispatcher consume definitions rather than
  duplicated conditionals where doing so reduces knowledge exposed to callers.

### Focused gate and commit

- Run command parser, policy, context resolver, natural-language policy, help
  card, and architecture tests.
- Run typecheck and `git diff --check`.
- Commit as `refactor: define swarm command capabilities`.

## Work package 2: Normalized submission and typed receipts

### Characterization

- Add `SwarmCommandRuntime` interface tests for query completion, mutation
  acceptance, rejection, duplicate reuse, idempotency conflict, and source
  authorization equivalence.
- Prove callers do not choose lane keys, replay policies, or frozen context.
- Characterize CardKit and Primary Tool idempotency fingerprints before moving
  construction behind the module.

### Implementation

- Introduce discriminated `SwarmCommandRequest` variants and
  `SwarmCommandReceipt`.
- Add an internal request normalizer for Lark text, CardKit, natural language,
  and Primary Tool sources.
- Move context resolution, authorization, source-specific idempotency, and
  command-intent construction behind `submit`.
- Initially retain the existing dispatcher timing so this slice changes the
  seam without changing mutation response timing.
- Keep compatibility adapters only while consumers migrate; do not make them
  part of the final interface.

### Focused gate and commit

- Run runtime-interface, Gateway compatibility, context resolver, Card action,
  Primary Tools, natural-language workflow, and command-intent tests.
- Run typecheck, build, architecture check, and `git diff --check`.
- Commit as `refactor: unify swarm command admission`.

## Work package 3: Durable Command Status View

### Characterization

- Add SQLite tests for additive migration from the current latest schema.
- Add transaction tests proving intent, initial status view, and create-card
  outbox intent commit or roll back together.
- Add transition tests for `accepted`, `executing`, `succeeded`, `rejected`,
  `failed`, and `uncertain`, including version monotonicity and stale updates.
- Add duplicate tests proving one intent owns one stable card projection.

### Implementation

- Add domain types and consumer-shaped store ports for the status projection.
- Add the next ordered SQLite migration and concrete store implementation inside
  the SQLite capability graph.
- Add atomic admission and settlement store operations; do not compose multiple
  public store calls in the coordinator.
- Add a pure Command Status reducer and CardKit renderer with redacted summaries,
  effect-certainty guidance, safe next actions, and short intent correlation.
- Project create and patch delivery through the existing durable outbox and
  delivery checkpoints. Do not patch a card before its target exists.
- Wake outbound work only after a successful commit.

### Focused gate and commit

- Run migration, SQLite store, status reducer/card, outbox, delivery executor,
  CardKit context, and architecture tests.
- Run typecheck, build, docs audit, and `git diff --check`.
- Commit as `feat: add durable swarm command status`.

## Work package 4: Prompt asynchronous execution

### Characterization

- Add a latency-independent test in which a blocked fake effect does not block
  `submit` after durable admission.
- Prove an accepted intent executes after a missed wake-up through SQLite scan or
  recovery.
- Preserve same-lane FIFO, cross-lane concurrency, duplicate single execution,
  and shutdown behavior.
- Prove interrupted `executing` work becomes `uncertain` and is not reclaimed.

### Implementation

- Change mutation submission to return its accepted receipt immediately after
  the admission transaction.
- Publish an intent-ID-only runtime wake-up hint to a background dispatcher.
- Let the dispatcher scan and claim SQLite lane heads; retain periodic/recovery
  convergence when hints are lost.
- Persist `executing` before the effect and settle the intent plus status
  projection atomically afterward.
- Retain exact frozen-context and active-turn revalidation immediately before the
  effect.
- Stop admission before shutdown drain and conservatively settle work that cannot
  be proven safe.

### Focused gate and commit

- Run runtime, dispatcher, concurrency, service lifecycle, shutdown, recovery,
  EventBus integration, SQLite, and status-card tests.
- Run typecheck, build, architecture check, and `git diff --check`.
- Commit as `feat: dispatch swarm commands asynchronously`.

## Work package 5: Durable programmatic observation

### Characterization

- Add Primary Tool Worker creation tests for immediate acceptance, durable
  pending observation, terminal result reconstruction, timeout, restart, stale
  parent Prompt, start failure, and uncertain execution.
- Assert correctness from SQLite intent/outcome and Instance state rather than
  private dispatcher collections.

### Implementation

- Add `observe(intentId)` over the command-intent/status read model.
- Persist Worker operation identity and safe outcome details needed to reconstruct
  `CreateWorkerResult`.
- Replace `workerResults` and `awaitedWorkerResults` with a bounded observer that
  may use intent hints for latency but always reloads durable state.
- Make timeout return a typed pending or uncertain result without cancelling or
  replaying the command.

### Focused gate and commit

- Run Primary Tools MCP, runtime observer, dispatcher, Instance integration,
  Worker lifecycle, SQLite, and recovery tests.
- Run typecheck, build, architecture check, and `git diff --check`.
- Commit as `refactor: observe swarm command results durably`.

## Work package 6: Migrate all ingresses and close the seam

### Characterization

- Add one source matrix showing literal Lark, CardKit, natural language, and
  Primary Tool requests receive equivalent context, authorization, idempotency,
  and receipt semantics.
- Preserve CardKit toast behavior and Primary Tool structured errors.

### Implementation

- Move Inbound routing, CardKit actions, natural-language handling, and Primary
  Tools to the narrow portion of `SwarmCommandRuntime` they consume.
- Remove source-specific synthetic-message and command-intent construction.
- Remove `drainAcceptedIntent`, `createWorkerFromCard`,
  `createWorkerFromPrimaryTool`, and other superseded Gateway methods.
- Keep `SwarmCommandGateway` only if it remains a meaningful internal module;
  otherwise fold its remaining behavior into runtime admission/query internals.
- Narrow composition exports and add import guards preventing production callers
  from importing the dispatcher or concrete command-intent store.
- Replace obsolete implementation-shaped tests with runtime-interface tests.

### Focused gate and commit

- Run inbound routing, Card action/router, natural-language workflow/runtime,
  Primary Tools, runtime-interface, startup recovery, composition, and
  architecture tests.
- Run typecheck, build, architecture check, and `git diff --check`.
- Commit as `refactor: close swarm command runtime seam`.

## Work package 7: Risk-based natural-language admission

### Characterization

- Add a table covering every command definition under literal and
  natural-language sources.
- Prove queries execute directly, recoverable mutations admit directly, and
  `stop`, `skip`, and `pane_close_confirm` require durable confirmation only for
  natural language.
- Prove ambiguous, unsupported, cancelled, expired, unauthorized, and stale
  requests execute nothing.

### Implementation

- Make the natural-language workflow submit typed commands to the runtime rather
  than deciding that every mutation needs confirmation.
- Stage confirmation only when the runtime returns `confirmation-required`.
- Keep confirmation consumption and command admission in one SQLite transaction.
- Preserve explicit `/swarm` high-risk execution and existing CardKit-specific
  confirmation contracts.
- Do not expose new high-risk operations to Primary Tools.

### Focused gate and commit

- Run natural-language parser/runtime/workflow, confirmation card, Card action,
  SQLite confirmation, runtime, and security-boundary tests.
- Run typecheck, build, architecture check, and `git diff --check`.
- Commit as `feat: apply swarm command risk policy`.

## Work package 8: Help, diagnostics, and documentation

### Characterization

- Add tests proving every command definition appears in the correct operator
  group and no forbidden remote capability is advertised.
- Add consistency tests between known literal syntax, help rendering, and the
  command reference.
- Add redaction tests for status cards, durable details, and structured logs.

### Implementation

- Render help groups from typed definitions: create/connect, inspect, control,
  recover, Worker management, and high-risk operations.
- Standardize status-card failure guidance around whether an effect may have
  started, whether automatic recovery is allowed, and the next safe action.
- Add structured logs correlated by intent ID, lane, command kind, source, and
  terminal outcome without logging raw sensitive arguments.
- Update `docs/feishu-group-usage.md`, `docs/architecture.md`, and
  `docs/architecture-boundary-inventory.md` against the implemented behavior.
- Update the active engineering index and archive superseded records only when
  they no longer describe an active implementation path.

### Focused gate and commit

- Run help/card, documentation audit, redaction, logging, architecture, and
  command runtime tests.
- Run typecheck, build, and `git diff --check`.
- Commit as `docs: document swarm command runtime`.

## Final completion audit

Before declaring the optimization complete:

1. Map every approved design requirement to implementation files and executable
   tests.
2. Confirm no source-specific admission or process-local result authority remains
   in production code.
3. Confirm all command definitions are exhaustive and all risk decisions derive
   from them.
4. Confirm migrations are ordered, additive, and exercised against historical
   schema fixtures.
5. Run the affected focused suites.
6. Run `npm run typecheck`.
7. Run `npm run build`.
8. Run `npm run architecture:check`.
9. Run `npm run docs:audit`.
10. Run `npm run public:audit`.
11. Run `npm test`.
12. Run `git diff --check`.
13. Inspect each thematic commit and confirm it contains no disallowed automated
    co-author trailer.
14. Confirm the worktree is clean.

Do not install, restart, or push as part of this plan unless the user separately
requests that operational action.
