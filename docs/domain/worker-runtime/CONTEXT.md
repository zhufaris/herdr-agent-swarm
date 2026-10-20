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

**Worker Pane Identity**:
The canonical `<group-token>-<worker-name>` label on the Worker's actual Pane.
Workers share the Primary's Group Token and tab, but each keeps its own runtime
Pane reference and Delivery Ring.
_Avoid_: Parent Pane identity, Worker Thread title

**Idle Topology Convergence**:
The Pane Topology Intent policy that may move or relabel an existing Worker only
after its runtime is settled and no active Worker Turn is durable. Ambiguous or
possible-effect evidence remains observable and is never replayed blindly.
_Avoid_: Live layout repair, terminal input, pane recreation
