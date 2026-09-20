# Domain Contexts

These concise context maps define the repository's shared language and ownership
boundaries. Use them before naming a new concept or moving behavior between
modules. For full lifecycle and dependency rules, see the
[architecture guide](../architecture.md) and
[architecture reference](../architecture-reference.md).

| Context | Owns | Does not own |
| --- | --- | --- |
| [Primary Session](primary-session/CONTEXT.md) | Topic-to-Primary binding, generation, provisioning, and live-runtime evidence | Prompt execution or visible card state |
| [Prompt Execution](prompt-execution/CONTEXT.md) | Ordinary prompt FIFO, steering, dispatch evidence, and attached or detached observation | Pane authority or Lark delivery |
| [Worker Runtime](worker-runtime/CONTEXT.md) | Worker ownership, generations, sessions, and delegated tasks | Primary conversation binding |
| [Conversation Projection](conversation-projection/CONTEXT.md) | User-visible topic, run, Worker, answer-page, and card-context read models | Execution state |
| [Delivery and Operations](delivery-operations/CONTEXT.md) | Delivery intents, lanes, outbox attempts, checkpoints, dead letters, and instance lease | Agent execution or card-derived workflow truth |

When a feature crosses contexts, keep the transition in an application workflow
and depend on consumer-shaped domain ports. Do not make a projection, adapter, or
process-local notification the authority for another context.
