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
