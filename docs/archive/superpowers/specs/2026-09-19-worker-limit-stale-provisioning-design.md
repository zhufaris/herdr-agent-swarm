# Worker Limit Stale Provisioning Design

## Problem

A Worker start failure after pane allocation leaves an active, retryable Worker session with a pending pane identity. This is correct while the pane may still exist or the external start result is uncertain. If Herdr later proves that recorded pending pane no longer exists, however, the session cannot resume and continues consuming the project's Worker limit forever.

## Design

During authoritative full workspace reconciliation, treat a missing recorded pending pane the same as a missing attached Worker pane. Call the existing generation-fenced `terminateWorkerSession` transaction. It terminalizes the Worker session, clears pending runtime ownership, cancels turns that never started, preserves possibly dispatched turns as uncertain, retires its card/thread projection, and retains its workspace for explicit removal.

Do not terminate when the pending pane exists but its workspace, cwd, agent kind, or native session identity is missing or mismatched. Those cases remain fail-closed because the start effect may still require human inspection. Do not change the quota query: active Worker sessions remain the correct unit.

## Acceptance

- A missing pending pane terminalizes the Worker and releases one active-session quota slot.
- A present but unverifiable pending pane remains active and unchanged.
- Existing attached-runtime missing-pane and no-replay behavior remain green.
- Production reconciliation retires the three known stale pending sessions whose recorded panes are absent.
