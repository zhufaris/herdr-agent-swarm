# Configurable Primary Agent Design

## Goal

Allow a user to choose the Primary Agent runtime when creating a project topic:

~~~text
/swarm new [title] --agent traex|pi|codex|claude-code
~~~

The option is optional and defaults to **traex**. The selected kind must remain
authoritative through project selection, pane creation, Agent startup, restart
recovery, runtime reconciliation, cards, and later session replacement. Existing
bindings and project selections remain TraeX after migration.

## Command contract

The parser accepts these forms:

~~~text
/swarm new
/swarm new Investigate login failures
/swarm new --agent pi
/swarm new Investigate login failures --agent codex
~~~

The title is every token before **--agent**. Quoted titles are not required;
whitespace is normalized by the existing title path. The only accepted values
are **traex**, **pi**, **codex**, and **claude-code**.

An unknown kind, duplicate option, missing option value, or trailing unknown
option resolves to the help command. No project selection or provisioning state
is created for invalid input. **/swarm projects** continues to create a TraeX
selection because it has no Agent option.

The domain command becomes:

~~~text
{ kind: "new", title: string | null, agentKind: AgentKind }
~~~

## Durable model

Agent kind is a property of a Primary Binding, not a transient provisioning
argument. Add **agent_kind** to both **bindings** and
**project_selections**, constrained to the four supported domain values and
defaulted to **traex** for existing rows.

The existing **runtime** binding column is retired. It currently permits only
the literal **traex** and duplicates the new, more precise Agent kind. A
transactional table rebuild removes it after **agent_kind** has been populated.
Application types and mappers expose **binding.agentKind**; they do not retain a
second runtime discriminator.

The project selection record stores the requested kind before its selection card
is delivered. Card callbacks identify only the durable selection ID and project
ID, so retries and delayed callbacks cannot lose or alter the requested kind.

Command intent serialization includes **agentKind**. Existing durable **new**
intents without the field decode as TraeX during migration or compatibility
parsing.

## Provisioning and lifecycle

Project creation chooses an Agent driver from the persisted Binding kind:

| Domain kind | Herdr native kind | Executable setting |
| --- | --- | --- |
| **traex** | **traex** | **TRAEX_BIN** |
| **pi** | **pi** | **PI_BIN** |
| **codex** | **codex** | **CODEX_BIN** |
| **claude-code** | **claude** | **CLAUDE_CODE_BIN** |

Pane allocation is unchanged. Agent startup goes through the existing Herdr
Agent start boundary with the selected native kind and configured executable.
TraeX alone receives Primary-tool MCP arguments because the current Primary-tool
protocol is TraeX-specific. Other Agents start without those arguments and the
Main Card reports Primary tools unavailable for that runtime.

Provisioning reaches **runtime_started** only after a fresh Herdr observation
reports the expected native Agent kind, a usable state, and the exact pane and
project route. An unavailable executable, unsupported Herdr kind, unknown state,
or kind mismatch fails provisioning without creating another pane on automatic
recovery.

**/swarm reset** inherits **binding.agentKind**. Replacing an orphaned pane also
preserves the kind. **/swarm attach** discovers and persists the actual supported
Agent kind reported by Herdr; it rejects a pane with no supported structured
Agent identity. Reattach requires the observed kind to match the persisted
Binding kind.

## Turn execution and capability boundaries

Primary FIFO, generation fencing, no-replay behavior, durable views, and outbox
semantics do not change. Dispatch selects the same Agent-driver abstraction used
for Workers, but keeps Primary-specific ownership and persistence in the Binding
workflow.

Each driver must provide a fenced turn-start operation and structured observation
appropriate to its runtime. A turn that may have reached an Agent is detached or
observed; it is never automatically replayed.

Capabilities remain runtime-specific:

- TraeX retains exact transcript streaming, model catalog and preference,
  Primary-tool MCP, and native exact-turn control.
- Pi, Codex, and Claude Code expose only capabilities their existing drivers and
  Herdr observations can prove.
- **/swarm model**, steering, stop, or transcript streaming fail closed with a
  clear card when the selected Primary driver cannot support the requested
  operation. They are never emulated through arbitrary terminal input.

This change does not promote Primary Bindings into Worker **AgentInstance** rows
and does not change Worker topology or ownership.

## Presentation

Project-selection status, Main Cards, Answer Cards, failure cards, and operational
views display the selected Agent label. User-visible text must not say “TraeX”
for a Pi, Codex, or Claude Code Primary.

Help and user documentation show:

~~~text
/swarm new [title] [--agent traex|pi|codex|claude-code]
~~~

The docs state that TraeX is the default and that model, steering, transcript,
and Primary-tool capabilities vary by runtime.

## Recovery and compatibility

- Existing Binding and project-selection rows migrate to **agent_kind=traex**.
- Existing serialized **new** commands without **agentKind** are interpreted as
  TraeX.
- Startup recovery always reads the durable kind before observing or starting an
  Agent.
- A persisted kind and observed Herdr kind mismatch degrades or fails the Binding;
  recovery never rewrites the durable kind from a different live process.
- Work proven not to have started remains retryable. Work with uncertain delivery
  remains detached and is observed using the selected driver.
- Lark cards are projections and never determine Agent kind.

## Validation

Focused tests cover:

- parser acceptance, defaulting, and malformed options;
- project-selection persistence across card delivery, callbacks, retries, and
  startup recovery;
- SQLite migration from the current TraeX-only schema;
- pane creation and verified startup for all four kinds;
- executable failure, unsupported runtime, and observed-kind mismatch;
- reset inheritance, attach discovery, reattach matching, and replacement;
- Primary dispatch and no-replay behavior through each driver contract;
- capability-specific fail-closed responses and Agent-aware card labels;
- README and Lark command documentation.

Before handoff, run the affected tests, **npm run typecheck**,
**npm run architecture:check**, **npm run build**, **npm test**, and
**npm run public:audit**.

## Non-goals

- Selecting a model in the **/swarm new** command.
- Changing the Agent kind of an existing Binding in place.
- Remote approval, denial, arbitrary terminal input, or process termination.
- Unifying Primary Bindings and Worker AgentInstance persistence.
- Automatically falling back to TraeX when another Agent fails to start.
