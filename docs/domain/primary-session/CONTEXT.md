# Primary Session

This context defines the durable relationship between a Lark conversation and the Primary Agent session that serves it.

## Language

**Topic-Pane Binding**:
The durable association between one Lark topic and one Primary Agent pane generation.
_Avoid_: Session mapping, chat binding

**Primary Agent**:
The human-facing Agent that owns ordinary conversation work and may delegate work to Workers.
_Avoid_: Parent worker, coordinator bot

**Binding Generation**:
The identity epoch of a Topic-Pane Binding; observations and actions from another generation are stale.
_Avoid_: Version, revision

**Provisioning Checkpoint**:
A durable milestone in creating a new Topic-Pane Binding, used to resume or fail closed after interruption.
_Avoid_: Step status, progress flag

**Orphaned Binding**:
A Topic-Pane Binding whose previously proven runtime can no longer be confirmed.
_Avoid_: Deleted session, dead chat

**Runtime Observation**:
A fresh statement from Herdr about pane, terminal, Agent session, and turn state.
_Avoid_: Event truth, cached status

**Agent Route**:
The exact Binding generation, Pane, terminal, Agent kind, and native session to
which one Agent Input is addressed. A changed fence makes that submission stale;
the route never supplies conversation order.
_Avoid_: Prompt owner, queue lane

**Control Lane**:
The owner-scoped CommandIntent order for Swarm mutations. It is separate from
Agent Input and establishes no global order with Core conversation events.
Queries and form-opening interactions do not enter the lane.
_Avoid_: Prompt priority, global Binding queue

**Runtime Pane Reference**:
Herdr's internal Pane identifier used for observation, ownership, and fencing.
It is not a human-facing token.
_Avoid_: Pane token, display name

**Group Token**:
The owning Primary Pane token used as the shared Herdr tab label and the stable
prefix for every canonical Pane Identity in that tab.
_Avoid_: Binding ID, tab ID, display title

**Pane Identity**:
The canonical Herdr pane label for one actual runtime: `<group-token>-main` for
a managed Primary, `<own-token>-default-main` for a directly adopted Primary,
and `<group-token>-<worker-name>` for a Worker.
_Avoid_: Lark title, Pane ID, Agent session ID

**Pane Topology Intent**:
The durable, identity-fenced instruction used to converge one existing Pane's
tab placement and canonical labels without replaying an uncertain Herdr effect.
_Avoid_: Rename command, layout hint, best-effort move

**Current Goal**:
The latest non-completed native Goal for the exact Primary Agent session. The
Primary Session owns its lifecycle and ordering fence across turns; completing
the same Goal clears it. A Run Projection receives only a read-only render
snapshot.
_Avoid_: Task List, Prompt goal, inferred objective
