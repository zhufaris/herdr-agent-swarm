# Prompt Execution

This context defines accepted Primary work and the evidence required to dispatch and observe it safely.

## Language

**Ordinary Prompt**:
User work accepted into the per-binding FIFO and dispatched only when that binding owns no other ordinary turn.
_Avoid_: Message, request

**Steering Work**:
Eligible input intentionally delivered to an already active turn rather than queued as a new ordinary prompt.
_Avoid_: Follow-up prompt, priority message

**Dispatch Evidence**:
The durable proof that a prompt may have crossed the Agent boundary; once present, automatic replay is forbidden.
_Avoid_: Sent flag, attempt marker

**Attached Observation**:
Observation performed while the original dispatch owner is still supervising the exact turn.
_Avoid_: Live polling

**Detached Observation**:
Observation of a possibly dispatched turn without resubmitting its prompt.
_Avoid_: Retry, replay

**Transcript Identity**:
The exact session and turn identity used to fence transcript output from unrelated or superseded work.
_Avoid_: Cursor, latest output
