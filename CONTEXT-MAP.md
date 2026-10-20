# Context Map

## Contexts

- [Primary Session](./docs/domain/primary-session/CONTEXT.md) — owns the durable relationship between a Lark topic and a Primary Agent session.
- [Agent Input](./docs/domain/agent-input/CONTEXT.md) — owns independent human-input submission intent and Core receipt convergence.
- [Worker Runtime](./docs/domain/worker-runtime/CONTEXT.md) — owns delegated Worker identity, tasks, turns, and ownership.
- [Conversation Projection](./docs/domain/conversation-projection/CONTEXT.md) — owns user-visible conversation read models without owning execution state.
- [Delivery and Operations](./docs/domain/delivery-operations/CONTEXT.md) — owns durable delivery intent, ordered delivery, retries, and operational status.

## Relationships

- **Primary Session -> Agent Input**: an active Topic-Pane Binding supplies an exact Pane, terminal, Agent, session, and generation route for each independent input.
- **Primary Session -> Worker Runtime**: one exact Primary generation and pane owns each Worker generation.
- **Agent Input -> Core**: each Submission Intent is offered independently; predecessor state is never an admission or submission gate.
- **Core JSONL -> Conversation Projection**: canonical session events, in their emitted order, update Turn, Topic, and Answer projections.
- **Worker Runtime -> Conversation Projection**: Worker lifecycle and turn facts update Worker Main and Worker Task projections.
- **Conversation Projection -> Delivery and Operations**: projection changes reserve durable delivery intents; delivery outcomes do not alter execution decisions.
- **Primary Session <- Runtime Observation**: authoritative Herdr observations converge durable binding state; wake-ups only request another observation.
