# Delivery and Operations

This context defines durable user-visible delivery and the operational facts needed to run it safely.

## Language

**Delivery Intent**:
An immutable, versioned description of user-visible output reserved by the workflow transition that produced it.
_Avoid_: Card payload, send request

**Delivery Subject**:
The typed projection identity and revision whose visible state is settled by one
Delivery Intent. It is distinct from the idempotency label and cannot be
reconstructed from a provider message or a formatted projection key.
_Avoid_: Projection key, card target, message ID

**Presentation Snapshot**:
The immutable, provider-neutral semantic input frozen with a Delivery Intent.
Delivery consumption may render it, but cannot refresh it from newer projection
state. Once an external effect plan is prepared, retries reuse that frozen plan.
_Avoid_: Card JSON, latest projection, mutable render input

**Gateway View**:
The provider-neutral visible structure rendered from a Presentation Snapshot.
Provider-specific materialization belongs to the Gateway boundary and is not
durable presentation state for new delivery.
_Avoid_: CardKit payload, opaque provider node

**Delivery Scope**:
The durable ordering boundary for delivery intents: one actual Pane scope,
identified by workspace and Pane ID, or the one non-Pane Global scope. New
Worker delivery uses the exact Worker Pane scope and separately freezes the
parent Primary Pane fence. Historical parent-scoped Worker rows retain their
old scope without replay or rewrite.
_Avoid_: Delivery Lane, Queue name, parent Binding scope

**Delivery Ring**:
The bounded process-local message queue, full-data cache, and serial
external-effect executor for one Delivery Scope. SQLite remains the restart
authority and cold-recovery source; Ring contents and local head state are
disposable.
_Avoid_: Outbox, Lane scheduler, reference queue

**Outbox Entry**:
A durable delivery work record carrying its typed subject, frozen Presentation
Snapshot or Prepared Delivery, idempotency, external-effect lifecycle, retry,
receipt, settlement, and dead-letter state. Ring refill replays these records
after the safe scope checkpoint.
_Avoid_: Event, message

**Completion Review Presentation**:
The fresh-card outbox entry linked one-to-one with a Completion Action Set. Its
initial payload includes the native actor mention and all review controls; no
new-flow inline Answer/Worker Task controls or follow-up reminder are created.
The Action Set becomes active only from its exact delivered receipt and message
identity. Pending delivery remains presenting. Missing, conflicting, or
uncertain evidence remains presenting with durable diagnostics and is never
automatically replayed or replaced. A Worker Segment presentation targets its
independent Worker Thread root and carries the Worker name, while its delivery
uses the Worker Pane Ring under a separate parent Binding and parent Pane fence.
_Avoid_: Inline completion action, standalone reminder, inferred delivery
receipt

**Completion Review Retention Fence**:
The live Action Set-to-outbox link and its frozen payload for a presenting or
active fresh Completion Review. Retention and payload compaction must preserve
this evidence; terminal safe history may compact only after the presentation is
no longer live.
_Avoid_: Best-effort card cache, replay permission

**Prepared Delivery**:
The immutable Gateway effect plan, scope, ownership fences, idempotency identity,
delivery order, subject revision, and prior checkpoints frozen before the first
external attempt and cached in a Delivery Ring after commit.
_Avoid_: Mutable card payload, Ring reference

**Delivery Checkpoint**:
Durable evidence of progress through a multi-step delivery such as streamed card creation, content updates, and finish.
_Avoid_: Stream status

**Delivery Ring Checkpoint**:
The derived, rebasable safe watermark for the contiguous terminal prefix of one
Delivery Scope. It accelerates Ring refill but never proves that a Gateway
effect occurred and never replaces current Outbox Entry state.
_Avoid_: Gateway checkpoint, irreversible cursor, delivery authority

**Dead Letter**:
A delivery intent quarantined after its retry policy is exhausted or its durable representation is invalid.
_Avoid_: Failed message

**Instance Lease**:
The fenced right of one service process to coordinate the shared durable workflow state.
_Avoid_: Process lock

**Convergence Summary**:
Operational facts for Submission Intent receipt states, Core projection lag and
gaps, outbox work, and recovery stages. It does not report an ordinary Prompt
queue because Swarm no longer owns conversation execution order. Completion
Review diagnostics are bounded counts by lifecycle and receipt condition; they
never include frozen card payloads, choice text, or actor data.
Pane Topology diagnostics expose only bounded pending/executing/uncertain
counts, and Delivery diagnostics expose Primary/Worker Pane-scope counts plus
legacy parent-scope debt; they do not expose prompts, payloads, or actors.
_Avoid_: Prompt FIFO status, readiness status
