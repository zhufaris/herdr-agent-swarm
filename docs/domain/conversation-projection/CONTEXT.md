# Conversation Projection

This context defines user-visible read models derived from workflow facts; projections do not own execution state.

## Language

**Topic Projection**:
The current user-visible summary of a Topic-Pane Binding.
_Avoid_: Binding state, source of truth

**Run Projection**:
The user-visible lifecycle of one ordinary prompt.
_Avoid_: Prompt aggregate

**Worker Main Projection**:
The user-visible summary and controls for one Worker generation.
_Avoid_: Worker state

**Worker Task Projection**:
The user-visible lifecycle and terminal result of one Worker Task.
_Avoid_: Worker turn aggregate

**Answer Page**:
One immutable or active page in the ordered visible answer stream for a run.
_Avoid_: Core event fragment, transcript chunk

**Answer Timeline**:
The durable ordered projection of Agent Markdown, tool calls/results, status, and
final answer items derived from one exact Core event turn.
_Avoid_: Raw event journal, rendered card payload

**Card Context**:
The immutable identity carried by a card action so ownership and generation can be validated.
_Avoid_: Card metadata
