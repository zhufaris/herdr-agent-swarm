# Context Map

## Contexts

- [Primary Session](./docs/domain/primary-session/CONTEXT.md) — owns the durable relationship between a Lark topic and a Primary Agent session.
- [Prompt Execution](./docs/domain/prompt-execution/CONTEXT.md) — owns ordered Primary work, steering, dispatch evidence, and observation.
- [Worker Runtime](./docs/domain/worker-runtime/CONTEXT.md) — owns delegated Worker identity, tasks, turns, and ownership.
- [Conversation Projection](./docs/domain/conversation-projection/CONTEXT.md) — owns user-visible conversation read models without owning execution state.
- [Delivery and Operations](./docs/domain/delivery-operations/CONTEXT.md) — owns durable delivery intent, ordered delivery, retries, and operational status.
- [Agent Observation Boundary](./docs/domain/agent-observation/CONTEXT.md) — translates exact Herdr Core Agent Events sources into identity-fenced observations without owning workflow state.

## Relationships

- **Primary Session -> Prompt Execution**: an active Topic-Pane Binding accepts ordinary prompts for its Primary Agent session.
- **Primary Session -> Worker Runtime**: one exact Primary generation and pane owns each Worker generation.
- **Prompt Execution -> Conversation Projection**: prompt lifecycle facts update Topic, Run, and Answer projections.
- **Worker Runtime -> Conversation Projection**: Worker lifecycle and turn facts update Worker Main and Worker Task projections.
- **Conversation Projection -> Delivery and Operations**: projection changes reserve durable delivery intents; delivery outcomes do not alter execution decisions.
- **Primary Session <- Runtime Observation**: authoritative Herdr observations converge durable binding state; wake-ups only request another observation.
- **Prompt Execution <- Agent Observation Boundary**: exact Core event turns provide reply, tool, plan, and lifecycle observations; unavailable history fails closed and never replays a prompt.
- **Worker Runtime <- Agent Observation Boundary**: Worker generation and runtime-turn fences select one Core event source before task projection.
- **Agent Observation Boundary <- Herdr Core**: Core owns producer decoding, journaling, source registration, and path discovery; Swarm selects one exact typed source by runtime identity and never locates Agent-owned transcript paths.
