# Agent Observation Boundary

This anti-corruption boundary converts an exactly identified Herdr Core Agent
Events source into stable observations consumed by Primary, Worker, and
Conversation Projection workflows. It is not a durable business aggregate.

## Language

**Core Event Source**:
The Core-owned, journaled stream for one Agent kind and native session, attached
to an exact Herdr pane/terminal identity.
_Avoid_: Latest transcript, newest file

**Core Event Turn Identity**:
The source, Agent kind, native session, turn ID, and canonical start time used to
reject output from unrelated, stale, or superseded work.
_Avoid_: Cursor alone, timestamp guess

**Observation Cursor**:
An ordered position in Core's retained event journal. It controls replay position
but is not sufficient identity proof by itself.
_Avoid_: Workflow checkpoint

**Core Source Discovery**:
Bounded, exactly-one lookup performed inside Herdr Core from an authoritative
pane/session identity and allowlisted source roots.
_Avoid_: Swarm-side path locator

**Boundary Unavailable**:
A fail-closed result when identity, retained history, source health, or schema
compatibility cannot prove the requested exact turn.
_Avoid_: Empty answer, successful completion

## Ownership

This boundary owns:

- Core attach/locate/read protocol adaptation;
- source/session/turn identity validation;
- conversion from versioned Core events to bounded domain observations;
- cursor and retained-boundary failure semantics.

It does not own:

- Agent-native JSONL files or Core journal retention;
- Binding, Prompt, Worker, or card lifecycle transitions;
- presentation policy, pagination, or Lark delivery;
- pane scrollback as a structured-reply fallback.

Herdr Core owns descriptor/path discovery. Swarm knows only pane, Agent kind,
expected native session ID, turn identity, and Core cursor—not Agent session
roots or JSONL paths.
