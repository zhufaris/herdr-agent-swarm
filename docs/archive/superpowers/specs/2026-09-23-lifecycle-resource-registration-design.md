# Lifecycle Resource Registration

Status: completed and archived.

## Goal

Deepen `RuntimeLifecycleLedger` so managed startup can express the common
"register cleanup, then start resource" operation once, without moving startup
policy out of `ManagedBridgeRuntime` or changing shutdown safety semantics.

## Current problem

`ManagedBridgeRuntime.performStart()` currently repeats lifecycle mechanics for
each resource: name the resource, classify its shutdown stage and writer risk,
register its stop action, then invoke its start action. The ordering is important,
but the repeated mechanics obscure that order and leave the start/cleanup pairing
spread across the caller.

`RuntimeLifecycleLedger` already owns cleanup registration, uniqueness, stage
ordering, and reverse registration within a stage. Its interface stops just short
of the operation that gives those rules value during startup.

## Chosen design

Add a lifecycle resource operation to `RuntimeLifecycleLedger`. The operation
accepts the existing cleanup entry plus a start callback. It registers cleanup
before invoking start, awaits synchronous or asynchronous startup, and returns the
start result. Registration-before-start is the central invariant: partial startup
or a thrown start must still leave a cleanup path in the shutdown plan.

`ManagedBridgeRuntime` retains the exact sequence of calls. It uses the ledger
operation only where startup and cleanup form a direct pair. Recovery calls,
convergence calls, lease/write-fence setup, and startup interruption checks remain
explicit because they are lifecycle policy rather than resource mechanics.

## Special cases

The Primary tool Gateway and natural-language runtime continue to start together
with `Promise.allSettled`. Their cleanup callbacks remain registered before either
start begins and continue to wait for the shared startup settlement before stopping.
The ledger must not serialize this pair or hide its failure selection policy.

The health server uses the operation's returned server handle to bind cleanup to
the successfully or partially created resource without adding mutable state to the
ledger. Herdr socket ingress and event drain keep their intentionally reversed
registration order so shutdown closes admission before awaiting the writer drain.

## Behavioral boundaries

This refactor does not change:

- startup order, parallelism, interruption checks, or recovery ordering;
- cleanup stage ordering or reverse order within a stage;
- writer and non-writer classifications;
- shutdown deadlines, ownership retention, lease fencing, or store closure;
- health behavior, Herdr reconciliation, durable outbox, or prompt replay rules.

It does not introduce phase objects, a generic lifecycle DSL, automatic rollback,
or a second lifecycle registry.

## Testing

The ledger interface is tested for registration before startup, cleanup retention
when startup throws, returned startup values, duplicate ownership, and the existing
shutdown ordering. `ManagedBridgeRuntime.start()` and `stop()` remain the behavioral
seam for integration tests covering exact startup/cleanup order, parallel ingress
failure, interruption, writer safety, and lease-loss shutdown. Architecture tests
prevent the repeated direct registration pattern from returning to managed startup.

Before completion, run the focused lifecycle and managed-runtime tests, typecheck,
build, the full Vitest suite, architecture check, documentation audit, public audit,
and diff check. Review the result against repository standards and this design.
