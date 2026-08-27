# Durable Reconciler Projections Design

## Goal

Ensure that a reconciler-observed terminal output or a confirmed missing Pane
cannot be made permanently invisible by a process exit between durable state
mutation and an in-process lifecycle projection.

## Problem

`HerdrRuntimeReconciler` currently persists an output fingerprint before it
publishes `PaneOutputObserved` through the in-process event bus. If the process
stops after the fingerprint write, subsequent reconciliation treats the same
terminal content as already handled while no durable TopicView or Lark intent
exists for it.

Similarly, confirmed Pane loss currently updates a Binding, several RunCards,
and then publishes a main-card event through separate operations. A stop in the
middle can leave an orphaned Binding with stale visible run state.

## Authority and invariant

SQLite remains authoritative for Binding state, durable views, and Lark delivery
intent. Herdr remains authoritative for live Pane/runtime facts. The in-process
`BridgeEventBus` remains a low-latency notification mechanism and is not a
durability boundary.

For every reconciler transition that changes user-visible state, the SQLite
transaction must persist one of the following before returning:

1. the resulting desired TopicView/RunCard state and any necessary outbox
   intent; or
2. a durable, idempotent projection obligation that startup and periodic
   convergence can consume.

The implementation uses option 1 for this slice. A lost in-process event may
delay a refresh but cannot lose the desired state.

## Durable terminal-output transition

Replace the standalone runtime-output fingerprint checkpoint with a fenced store
command that receives the Binding ID, Pane ID, generation, output fingerprint,
and the already-sanitized presentation patch. In one transaction it:

- verifies the current Pane fence;
- rejects unchanged fingerprints;
- advances `last_output_fingerprint`;
- applies the deterministic TopicView patch; and
- reserves the current main-card outbox intent when the desired view changes.

The command does not persist raw terminal text. The reconciler continues to use
bounded parsing/redaction before passing any derived answer, model, or context
field. It returns an outcome containing the durable desired view so the caller
may publish a best-effort event only for live latency.

Startup repair needs only compare `TopicViewState.viewVersion` with
`deliveredVersion`, which is already the MainCard workflow contract; it does not
need to reread terminal scrollback to recreate the presentation.

## Durable missing-Pane transition

Add a fenced `orphanBinding` store command. Its transaction:

- verifies the expected pane and generation;
- transitions the Binding through the existing orphaning lifecycle rule;
- terminates affected prompt jobs without replay: running work becomes failed and
  queued work becomes cancelled; their RunCards become terminal failures;
- records the corresponding Answer-card update intent where a non-streaming card
  exists;
- derives and saves the Binding's orphaned TopicView; and
- reserves the current main-card delivery intent.

The command is idempotent: stale fences, already-orphaned Bindings, and repeat
observations do not create duplicate user-visible effects. It does not resend or
replay a TraeX prompt.

## Event and recovery behavior

After a successful durable transition, `HerdrRuntimeReconciler` may emit the
existing lifecycle event for same-process view refreshes and scheduler hints.
Those emissions are non-authoritative. Startup convergence and the normal outbox
dispatcher deliver the persisted desired views when a process exits before such
notifications run.

`StartupViewConverger` remains responsible for delivery convergence, not replaying
terminal parsing. Its contract becomes sufficient because the reconciler has
already persisted the desired projection.

## Non-goals

- Do not make `BridgeEventBus` durable or introduce general event sourcing.
- Do not change Herdr as the source of live Pane/runtime facts.
- Do not replay a prompt that may have reached TraeX.
- Do not expose raw terminal output, session UUIDs, or secrets to SQLite logs or
  Lark cards.
- Do not redesign Answer-page pagination or outbox lane ordering.

## Verification

- Store tests prove terminal-output deduplication and its TopicView/outbox
  obligation commit atomically behind a Pane fence.
- Reconciler integration tests simulate that no process-local event subscriber
  runs, then recreate the normal delivery convergence from persisted state.
- Store and reconciler tests prove Pane orphaning leaves Binding, affected
  RunCards, and main-card delivery state mutually consistent.
- Existing no-replay tests continue to demonstrate that an interrupted or
  orphaned prompt is observed or made explicit, never automatically resent.
