# Agent Input

This context defines one immutable human input offered independently to one exact Herdr Agent route.

## Language

**Agent Input**:
Human-authored text submitted through the versioned Herdr Core input contract. It is not a queue entry and does not inherit ordering from Feishu, SQLite, timestamps, or identifiers.
_Avoid_: Ordinary Prompt, queued message

**Submission Intent**:
The durable aggregate that freezes source identity, body, Binding generation, Pane, terminal, Agent kind, and native session before any Core effect.
_Avoid_: Prompt Job, Native Input Batch

**Source Message Identity**:
The unique `(ingress source, source message key)` pair used only for duplicate admission. It never establishes conversation order.
_Avoid_: Sequence number, ordering key

**Submission Receipt**:
Core's durable result for one caller-supplied submission ID. A prepared or observed receipt proves the request crossed the external-effect boundary; an uncertain attempt may only be queried, never resubmitted automatically.
_Avoid_: Turn order, Answer ownership

**Independent Eligibility**:
Every valid input can be submitted without consulting an earlier input's running, detached, recovering, or uncertain state.
_Avoid_: FIFO release, predecessor completion

**Effect Certainty**:
The rule that only work durably proven never attempted may be retried as submission work. Possible-effect legacy rows remain evidence and recovery inputs only.
_Avoid_: Best-effort retry

**Input Card**:
A compatibility-only Feishu projection retained for historical Pending-first
rows. New Submission Intents never create one. Historical rows may converge
only from the matching canonical Core JSONL
`human_message.submission_id`; they are presentation state, never a Prompt or
a conversation-order gate.
_Avoid_: New input surface, Prompt card, receipt-as-working, local timestamp ordering

**Turn Card**:
The Feishu projection for one canonical Human Message and its Core-ordered
Conversation Segment. Its first page is created in `working` state only after
the canonical Human event is durably projected; Submission Intent admission
alone creates no card.
_Avoid_: Pending receipt card, Feishu-ordered transcript

Core JSONL is the sole authority for final conversation order. Submission Intent creation time, Feishu arrival, SQLite row order, hashes, and receipt timing are audit or correlation facts only.
