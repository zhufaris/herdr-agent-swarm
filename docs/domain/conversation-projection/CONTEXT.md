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
_Avoid_: Transcript chunk

**Card Context**:
The immutable identity carried by a card action so ownership and generation can be validated.
_Avoid_: Card metadata
