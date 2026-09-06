# Worker Runtime

This context defines delegated Agent instances and the task turns they execute for an owning Primary Agent.

## Language

**Worker**:
A delegated Agent instance owned by one exact Primary binding generation and pane.
_Avoid_: Child session, sub-agent card

**Worker Generation**:
The identity epoch of a Worker instance; actions targeting another generation are stale.
_Avoid_: Worker version

**Worker Session Generation**:
The identity epoch of the Agent session running inside a Worker generation.
_Avoid_: Session version

**Worker Task**:
A durable unit of delegated work whose interaction is fenced by Worker, Worker-session, and owning-Primary identity.
_Avoid_: Card reply, child prompt

**Worker Ownership**:
The exact Primary binding generation and pane identity allowed to operate a Worker and its tasks.
_Avoid_: Parent link
