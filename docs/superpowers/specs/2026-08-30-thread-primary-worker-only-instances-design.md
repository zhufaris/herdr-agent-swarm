# Thread Primary and Worker-Only Instances Design

## Problem

The product currently has two unrelated representations of a Primary. A Lark
thread binding already owns the TraeX pane that receives ordinary thread turns,
while the instance subsystem separately expects an `agent_instances` row with
`role = primary`. The instance directory reads only the latter. A healthy bound
thread can therefore show `PRIMARY 未设置`, route the symbolic Primary target to
nothing, and offer a form that creates a second Primary with an independent
lifecycle.

The live database demonstrates this mismatch: bindings and their TraeX panes
exist, while `agent_instances` is empty. The rendered directory consequently
reports zero instances even though the thread already has its Primary runtime.

## Product semantics

The current bound Lark thread is its Primary. The binding, its generation, and
its Herdr pane remain the sole durable and runtime authority for that Primary.
The instance subsystem manages only additional Workers. It must not create,
promote, stop, remove, or duplicate the thread Primary.

The instance directory presents the binding-backed Primary separately from the
Worker count. With no Workers it says that no Workers exist and offers only a
`创建 Worker` action. The creation form has no role selector and the server
always submits `role: worker`; a forged `role: primary` form value has no effect.

The symbolic Primary target means the current binding. An ordinary message sent
to that target continues through the existing binding prompt FIFO, not through
`InstanceMessagingWorkflow`. A selected Worker target continues through the
instance turn queue. Commands that name a Worker operate only on Worker rows.

Primary-to-Worker MCP authority follows the same boundary. Its capability is
issued to a binding generation and authorizes calls only while that binding has
the server-owned active ordinary prompt. The gateway derives `projectId`,
Primary identity, and parent prompt ID from the binding and prompt store; the
client cannot supply them. Replacing, archiving, or advancing the binding
generation invalidates the credential. Worker targeting remains fenced by the
Worker's instance generation.

## Boundary changes

`InstanceInteractionWorkflow` receives the current binding context when it
renders the directory or resolves the symbolic Primary target. It does not
synthesize or persist an `AgentInstance` for the binding. Directory rendering
accepts an explicit thread-Primary view plus Worker entries, so presentation
cannot infer Primary existence from Worker storage.

`InstanceControlWorkflow.create` rejects non-Worker creation at the server
boundary even if a stale or forged callback supplies `role: primary`. Primary
promotion is removed from the Lark instance controls. Existing legacy Primary
rows are not silently deleted or converted by this change; they are excluded
from the worker directory and reported by validation or migration diagnostics
for explicit operator cleanup.

Project setup stops generating Primary/Worker instance templates whose runtime
does not provision them. Project `maxInstances` is interpreted as a Worker
limit. Existing configuration fields are handled by an explicit schema decision
in the implementation plan rather than being silently ignored.

## Failure handling and durability

Worker creation remains a human-only durable operation. The Worker row and
workspace lease are committed before optional runtime provisioning. If immediate
startup fails, the failed Worker remains inspectable with its checkpoint and
redacted error; it is not reported as an unqualified creation failure and is
never retried by creating a duplicate row.

The change preserves binding FIFO, detached-turn observation, instance turn
idempotency, SQLite transaction boundaries, and the rule that uncertain work is
never replayed automatically.

## Verification

Regression coverage must prove all of the following:

- a bound thread with no instance rows renders itself as Primary and zero
  Workers;
- the empty directory offers only Worker creation;
- the form contains no role selector and a forged Primary role cannot create a
  Primary row;
- symbolic Primary routing continues through the binding prompt path;
- an explicitly selected Worker routes through the instance workflow;
- a current binding Primary can call a same-project Worker, while stale binding
  generations and calls outside an active Primary prompt are rejected;
- legacy Primary rows cannot create a second Primary authority or appear as
  ordinary Workers;
- Worker creation failure leaves durable, inspectable state without duplicates;
- focused tests, typecheck, build, and the full Vitest suite pass.
