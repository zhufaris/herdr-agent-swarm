# Lifecycle Runtime Interface

Status: completed and archived.

## Goal

Increase the leverage of `RuntimeLifecycleLedger` by letting it manage ordinary
runtime modules directly, rather than requiring every caller to restate matching
start and stop callbacks. Preserve explicit lifecycle policy and every existing
startup and shutdown behavior.

## Current problem

The ledger now guarantees cleanup registration before startup, but its ordinary
`start(entry, callback)` interface still requires callers to describe the same
module twice: once in the cleanup callback and again in the startup callback. In
`ManagedBridgeRuntime`, most ordinary resources therefore expanded from two lines
to four. Correctness became more local, but the interface did not gain enough
leverage.

## Considered approaches

### A. Structural runtime interface

Pass a module with `start` and `stop` methods to the ledger, along with its explicit
name, shutdown stage, writer kind, and start arguments. The ledger binds method
receivers correctly, registers stop before invoking start, and forwards the shared
shutdown context when the module accepts it. This removes callback duplication while
keeping safety policy visible at each call site.

### B. Managed-runtime helper

Add a private helper to `ManagedBridgeRuntime`. This shortens the method but leaves
the lifecycle knowledge in the caller and duplicates the ledger's role. It fails the
deletion test: removing the helper restores only a few local lines.

### C. Declarative phase catalog

Describe all resources in a data table and have a generic runner start them. This is
compact but obscures recovery calls, convergence waits, interruption checkpoints,
and special concurrency. The lost visibility is not worth the line reduction.

## Chosen design

Use approach A. Replace the callback-oriented ordinary `start` operation with a
structural runtime operation. Its interface accepts lifecycle identity and policy,
the runtime module, and optional start arguments. It registers a cleanup closure
that invokes the same module's `stop` method, then invokes `start` with the supplied
arguments and returns its result.

The interface supports the actual runtime shapes already present: zero-argument
starts, interval starts, bus starts, and stop methods that either accept or ignore a
`ShutdownContext`. Type inference must validate the start arguments and preserve the
start result. No new runtime adapter classes are introduced.

The asynchronous factory operation remains separate because a factory does not have
a resource handle until creation succeeds. The ledger retains that handle internally
for cleanup.

## Explicit exceptions

The following remain direct registrations because they encode policy beyond an
ordinary start/stop pair:

- Primary tool and natural-language ingress start concurrently and their cleanup
  waits for the shared startup settlement.
- Coordinator and instance work enter the shutdown boundary before recovery work,
  not at their eventual start call.
- Herdr socket ingress and event drain are two cleanup actions around one start and
  rely on reverse registration order.
- Health creation remains factory-shaped and uses the existing resource-handle path.

## Behavioral boundaries

The change does not alter startup order, interruption checkpoints, recovery, cleanup
stages, writer classification, shutdown deadlines, lease fencing, ownership retention,
health behavior, reconciliation, durable delivery, or prompt replay semantics.

## Testing

Tests at the ledger seam verify registration-before-start, receiver binding, argument
forwarding, start-result preservation, shutdown-context forwarding, and failure
retention. Managed-runtime and architecture tests verify unchanged ordering and that
ordinary modules use the structural interface while policy-heavy exceptions stay
explicit. Full validation follows repository requirements.
