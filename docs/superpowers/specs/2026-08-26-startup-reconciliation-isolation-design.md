# Startup Reconciliation Isolation Design

## Goal

Start the bridge's durable workers and Lark ingress even when one recoverable
binding, pane, or external recovery stage fails, while retaining fail-fast
behavior for local configuration and SQLite invariants.

## Design

Startup has two phases. Local durable recovery and configured-workspace
validation remain prerequisites. After those gates, workers, periodic recovery,
and Lark ingress start before best-effort external convergence. Each recovery
stage logs a bounded outcome and continues to the next stage.

Batch workflows isolate their own unit of work. `StartupViewConverger` catches
per binding. `HerdrRuntimeReconciler` catches per pane after a workspace snapshot
has been acquired. This ensures a malformed projection or one failed terminal
read cannot prevent healthy bindings from converging. Failed work remains durable
and is retried by normal periodic or delivery convergence.

## Safety

No prompt is replayed. Workspace validation remains a hard startup gate. The
change does not alter binding authority or card pagination. Failures are logged
with stage and binding/pane identity but without card or terminal payloads.
