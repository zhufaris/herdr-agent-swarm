# Conversation Projection

This context defines user-visible read models derived from workflow facts; projections do not own execution state.

## Language

**Topic Projection**:
The current user-visible summary of a Topic-Pane Binding.
_Avoid_: Binding state, source of truth

**Turn Projection**:
The user-visible lifecycle reconstructed from one canonical Core Turn event
sequence. A late exact repair is delivered as a separate history continuation;
it never patches a frozen Answer Page. Projection state never establishes input
submission or conversation order.
_Avoid_: Prompt aggregate, SQLite-ordered run

**Worker Main Projection**:
The user-visible summary and controls for one Worker generation.
_Avoid_: Worker state

**Worker Task Projection**:
The user-visible lifecycle and terminal result of one Worker Task.
_Avoid_: Worker turn aggregate

**Completion Review**:
The one fresh, immutable card that presents a valid terminal human-review
choice for an exact Primary Prompt, Primary Segment, Worker Segment, or Worker
Turn. It is a separate projection from a frozen Answer Page, Turn Card, or
Worker Task Projection; new flow never adds controls to either older card and
never emits a standalone reminder. Its Action Set owns the choice specification
and presentation lifecycle, while its minimal callback revalidates the actor
and owner fences before deriving the persisted choice's next Agent Input. A
Worker Segment's business choice creates Worker-owned input against the
independent Worker Thread root; Ignore remains local.
_Avoid_: Answer-card buttons, reminder message, mutable final-card controls

**Worker Thread**:
The independently named conversation surface for a Worker Pane. It is symmetric
with a Primary Thread for Completion Review ownership. The parent Primary
contributes only the parent Binding/generation fences and its Primary Pane
delivery scope; it does not own the Worker Thread.
_Avoid_: Child Primary conversation, parent-owned Worker name

**Answer Page**:
One immutable or active page in the ordered visible answer stream for a run.
Existing-page delivery is addressed by that page's durable page index and
message identity, not by the Run Projection's mutable current-page fields.
_Avoid_: Transcript chunk

**Page Plan**:
The versioned canonical-source interval assigned to one visible page under a
typed presentation budget. Frozen page boundaries never change, and an active
legacy page continues from its persisted canonical anchor instead of being
replanned by a newer renderer.
_Avoid_: Rendered character count, CardKit size, mutable page cursor

**Card Context**:
The immutable identity carried by a card action so ownership and generation can be validated.
_Avoid_: Card metadata

**Visible Pane Token**:
The normalized native four-character token used to identify a Pane in a
conversation view. It is never synthesized from a Runtime Pane Reference.
_Avoid_: Pane ID, Pane name

**Run Projection Context**:
The Binding-derived ownership and display identity attached to a Run Projection.
Stable ownership identifies where the run occurred; refreshed display identity
keeps its visible Session, Agent, Space, and Pane token current.
_Avoid_: Runtime identity, card metadata

**Task List**:
The current native Core Agent plan for one Run Projection. It is durable
conversation state distinct from Tool activity and survives service restart.
_Avoid_: Process trace, Tool timeline

**Task List Title**:
The latest structured Core status title attached to a Run Projection and shown
only as the Answer Task List heading. It is durable but remains independent from
native plan-step identity and is never inferred from terminal frames or Answer
prose.
_Avoid_: Plan step, Pane status text

**Goal Snapshot**:
A read-only copy of the Primary Session's Current Goal carried by a mutable Run
Projection for Answer rendering. It never owns Goal transitions and is not
derived from Task List or Tool activity.
_Avoid_: Goal aggregate, Task List summary

**Reply Context**:
The bounded, redacted request summary shown once in the Answer subtitle.
_Avoid_: Human timeline item, full Prompt

**Late Tool Result**:
A render-only copy of a Tool result whose earlier running state is already on a
frozen Answer Page. It is projected onto the active page without changing the
Tool label or exposing its source page.
_Avoid_: Replayed Tool, new Tool call, page update label
