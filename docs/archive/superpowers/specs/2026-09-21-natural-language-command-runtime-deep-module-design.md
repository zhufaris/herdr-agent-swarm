# Natural-Language Command Runtime Deep Module

## Goal

Refactor the Controller and natural-language command path into one deep module
with a small interface, while preserving every externally observable behavior.
The same change will reorganize the deterministic parser into ordered internal
rule groups so command matching remains explicit without one monolithic method.

This is the first of two refactors. It does not restructure SQLite stores or
migrations. That work will receive a separate design after this module is
stable.

## Behavioral compatibility

The refactor must not change:

- which configured-group messages are eligible for interpretation;
- any deterministic parser result for an existing input;
- Controller MCP tools, request or response schemas, or permissions;
- durable confirmation behavior;
- SQLite schema, migrations, persisted state names, or transaction semantics;
- capability, generation, pane, terminal, or Agent identity fences;
- no-replay and uncertain-recovery behavior;
- CardKit presentation or user-facing guidance;
- Controller Pane name, placement, Agent arguments, model selection, or deny
  list;
- configuration keys, defaults, health behavior, or structured log correlation
  fields.

The implementation and tests must demonstrate behavioral equivalence instead
of relying on the refactor being mechanically similar.

## Current problem

Controller knowledge is currently spread across application composition, bridge
lifecycle, ingress routing, the Controller manager, the Unix-socket tool
gateway, and the fallback interpreter. Callers need to know that the feature has
two independently started runtime objects plus a separately composed interpreter.
That is a shallow interface: orchestration details remain visible to callers.

The deterministic interpreter also expresses unsupported operations, exact
queries, ambiguity, project and Primary commands, Worker commands, session
mutations, and task classification in one long method. Its ordering is important
but implicit in the implementation's physical layout. Adding a rule requires
reasoning about every unrelated expression around it.

## Chosen architecture

Introduce one `NaturalLanguageCommandRuntime` module. Its external interface is:

```ts
interface NaturalLanguageCommandRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  interpret(
    text: string,
    message?: IncomingLarkMessage
  ): Promise<NaturalLanguageCommandResult>;
}
```

The interface includes lifecycle because the Controller tool endpoint and job
runner must be started and stopped together. It includes interpretation because
Ingress is the sole behavioral caller. It exposes no Controller Pane, gateway,
manager, job, capability, or fallback concepts.

Application composition constructs this one module. Managed bridge lifecycle
starts and stops one lifecycle entry. Ingress receives only the `interpret`
interface. The module internally selects the deterministic result first and
uses the Controller only when the result is `unresolved`.

This module is deep by the deletion test: removing it would redistribute
Controller lifecycle, fallback order, Pane ownership, durable job execution, MCP
capability handling, and shutdown ordering across composition, lifecycle, and
Ingress. It is not a pass-through facade over public legacy modules.

## Internal modules

The external module contains four internal modules. They may have private seams
for focused tests, but those seams are not exposed to application callers.

### Deterministic interpreter

The deterministic interpreter owns text normalization, project alias matching,
rule precedence, and typed result construction. Its top-level implementation
only applies ordered rule groups:

1. unsupported control rules;
2. exact query rules;
3. ambiguity rules;
4. project and Primary rules;
5. Worker rules;
6. current-session mutation rules;
7. task classification rules.

Each rule accepts one normalized interpretation context and returns a typed
result or `null`. The context contains normalized text and the configured project
catalog needed for alias resolution. Rules remain ordinary internal functions;
there is no generic rule-engine abstraction, dependency injection container, or
public rule interface.

Rule order is an explicit invariant. Unsupported control requests run before
task classification, exact queries run before command-shaped ambiguity, and task
classification runs before the final unresolved result. A rule must consume the
same complete input that the current parser consumes; the refactor cannot broaden
partial matching.

### Controller runtime owner

The runtime owner contains Controller Pane discovery, exact identity validation,
generation advancement, failed-start recovery, Agent startup, and runtime-record
persistence. It retains the existing one-Pane rule and refuses to choose when
multiple candidate Controller Panes require operator reconciliation.

The owner preserves the validated pre-turn identity behavior: a freshly observed
TraeX Pane may use terminal identity until a native Agent session exists, but
only after exact Pane, terminal, Agent kind, and non-unknown state validation.

### Controller job runner

The job runner contains durable admission, FIFO claiming, capability issuance,
prompt dispatch, result waiting, timeout handling, notification, and recovery.
It owns the process-local drain and waiters. SQLite remains the durable authority;
the drain and waiters are wake-up and latency mechanisms only.

The runner preserves the effect-certainty distinction:

- work that failed before Controller prompt dispatch may become `failed`;
- work that may have crossed the Agent boundary becomes `uncertain`;
- restart converts dispatching or observing work to uncertain and never sends
  the interpretation prompt again;
- a late structured result may settle only through the existing generation and
  capability fences.

### Controller tool endpoint

The endpoint contains the private Unix-socket server and the same three MCP
tools: interpretation context, target inspection, and typed result submission.
It keeps the current request-size bound, one-request connection behavior, socket
permissions, schema validation, project and instance projection, and capability
checks.

The endpoint is lifecycle-owned by `NaturalLanguageCommandRuntime`; composition
does not receive or start it separately. The Controller MCP CLI and JSON-RPC
contract remain unchanged.

## Construction and lifecycle

The composition root creates either:

- an enabled runtime containing the deterministic interpreter, runtime owner,
  job runner, and tool endpoint; or
- a deterministic-only runtime when Controller interpretation is disabled.

Both variants satisfy the same interface. This is a real seam because production
configuration selects two behaviors and tests exercise both. Ingress does not
branch on configuration.

For the enabled runtime, startup performs recovery before accepting Controller
work, starts the private tool endpoint, reconciles the Controller runtime, and
starts the durable job drain. A Controller startup failure leaves the module in
degraded deterministic-only operation rather than failing bridge readiness.

Shutdown stops accepting or waiting for interpretation work, aborts the active
bounded Controller observation, stops the drain, closes the tool endpoint, and
leaves the Controller Pane intact for diagnosis. The exact ordering must retain
the current rule that potentially delivered work is persisted as uncertain
before its capability becomes unusable. Managed bridge lifecycle registers one
cleanup entry for the entire module.

Start and stop are idempotent. Starting after a completed stop is not required
unless the existing bridge lifecycle already permits it.

## Error handling

- Controller Pane creation or reconciliation failure is logged as degraded;
  deterministic rules continue to operate.
- More than one candidate Controller Pane remains an operator-reconciliation
  error; the module neither chooses nor closes a Pane.
- Prompt failure before dispatch evidence records `failed`.
- Failure after possible dispatch, shutdown during observation, or restart after
  dispatch evidence records `uncertain` and never causes automatic replay.
- Missing structured output after a completed Controller turn records the same
  terminal evidence and result currently used by the manager.
- Interpretation wait timeout returns `unresolved` to Ingress; durable job
  convergence continues according to recorded evidence.
- Stale capability, generation, job state, or runtime identity is rejected by
  the endpoint and cannot execute a Swarm command.
- The deterministic parser continues to return clarification for ambiguous
  command-shaped input and unsupported for prohibited control operations; neither
  may fall through to an ordinary Agent task.

## Testing strategy

The external module interface becomes the main Controller test surface. Tests
cover:

- deterministic matches do not admit Controller jobs;
- only unresolved input enters the durable Controller FIFO;
- disabled and unavailable Controllers preserve deterministic behavior;
- enabled lifecycle starts and stops the endpoint and runner in the safe order;
- startup and shutdown are idempotent;
- pre-dispatch failure and possible-dispatch failure retain their distinct
  persisted outcomes;
- restart recovery does not redispatch uncertain work;
- stale capability, generation, and runtime identity are rejected;
- multiple Controller Panes remain degraded and require operator action.

Deterministic parser tests become table-driven and are organized by rule group.
The existing Chinese and English inputs and their exact typed results form the
compatibility table. Tests explicitly preserve rule precedence for dynamic
project creation, ambiguous commands, Worker forms, current-session mutations,
ordinary tasks, and unresolved text.

Herdr adapter, MCP protocol, and SQLite store tests remain because they exercise
real seams. Tests that only duplicate internal manager or gateway orchestration
are replaced by tests at the new runtime interface. The refactor must not retain
parallel old and new orchestration tests merely to preserve implementation
structure.

Validation includes focused runtime and parser tests, `npm run typecheck`,
`npm run build`, `npm run architecture:check`, and the complete Vitest suite.

## Implementation boundaries

This change may move and rename Controller orchestration and parser implementation
files, update composition and lifecycle wiring, and replace tests that target the
old shallow interfaces. It may introduce narrow internal types that improve
locality.

It must not:

- change SQLite tables, migration numbers, store SQL, state names, or transaction
  boundaries;
- add another public port for an internal helper with only one implementation;
- alter ordinary Prompt, Worker, or general bridge lifecycle modules;
- change Lark routing, command execution, confirmation, CardKit, or health
  behavior;
- add new Controller tools or permissions;
- combine the later SQLite stores and migrations refactor into this change.

The existing Matt engineering-skills repository configuration is a separate
documentation commit and is not part of the implementation diff.

## Success criteria

- Composition constructs and exposes one natural-language runtime instead of a
  Controller manager, tool gateway, and fallback interpreter.
- Managed lifecycle knows one natural-language lifecycle entry.
- Ingress knows only the interpretation interface.
- Controller orchestration knowledge is local to the deep module.
- Parser precedence is visible at the top level and regex/extraction details are
  grouped by domain purpose.
- Existing inputs produce identical deterministic results.
- Controller permission, fencing, durability, confirmation, and no-replay
  behavior remain unchanged.
- The complete test and validation suite passes without runtime schema changes.
