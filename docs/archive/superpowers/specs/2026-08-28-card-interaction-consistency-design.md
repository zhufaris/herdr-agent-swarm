# Card Interaction Consistency Design

## Problem

Main Cards are durable projections and can briefly outlive the runtime state that
made an action valid. A card may therefore still show `立即补充` after the active
TraeX turn has ended. The input card adds a second delay: a turn may end after
the form opens but before it is submitted. In that case the bridge must not
create steering work or silently reinterpret the text as an ordinary task.

An orphaned binding has a related mismatch. Its Main Card correctly offers
recovery, but the More Actions card currently derives controls from
`lifecycle=active` before considering `attachment=orphaned`. It consequently
offers pane-dependent operations that cannot succeed. The reported binding
`<binding-id>` (`herdr-lark-bridge / task-4lrk`) is in
exactly this state because pane `wH:p3N` no longer exists.

## Design

### Supplement capability

Treat an active prompt identity as part of the Main Card's supplement
capability. Render `立即补充` only when the TopicView both has an interactive
phase (`running` or `blocked`) and a non-null `activePromptId`. A stale phase
without an active prompt must retain its status and recovery controls, but must
not advertise steering.

The callback workflow remains the authoritative fence. Opening the form
requires the current active turn to match the binding. Submitting requires the
same binding generation, operator-scoped interaction, unexpired interaction,
and the exact captured parent prompt to still be active. If any check fails,
return a clear warning that the task ended and the text was not sent.

If the runtime rejects steering after these checks, keep the operation rejected
and report that TraeX is no longer steerable. Never create an ordinary prompt,
never replay the text, and never claim success merely because durable steering
intent was accepted.

The request-card `改为立即补充` action has an additional reversible boundary.
Before atomically changing a queued ordinary prompt into steering work, observe
the target pane and require its authoritative agent state to remain `working`
or `blocked`. If the observation says the turn ended, or the observation itself
fails, leave the prompt unchanged in its FIFO position and return a warning.
Once conversion succeeds, later injection uncertainty remains a failed steering
operation and must never be converted back or replayed as ordinary work.

### Orphaned action capability

More Actions must derive its controls from attachment before lifecycle. For an
orphaned binding, a creator sees only:

- `刷新状态`
- `重新连接 Pane`
- `创建替代 Pane`
- `归档`

Pane-dependent actions (`停止当前任务`, `模型`, `重置会话`, and `关闭 Pane`)
must not render. A non-creator continues to see only `刷新状态`. Existing
generation fencing, creator authorization, interaction expiry, and callback
idempotency remain unchanged.

## Data and delivery boundaries

No schema migration or stored-state rewrite is required. Existing cards are
updated through normal TopicView convergence after deployment. Historical
outbox and audit rows remain intact. The fix does not replay prompts, retry
unknown delivery outcomes, or infer authoritative state from Feishu.

## Verification

- Renderer tests prove a stale interactive phase without `activePromptId` does
  not expose `open_supplement`.
- Interaction tests prove a form cannot submit after its captured turn ends and
  no steering call occurs.
- Renderer/integration tests prove orphaned creator and non-creator action sets.
- Existing CardKit tests continue proving direct CardKit 2.0 callback behavior.
- Run focused tests, the full suite, typecheck, and build before restart.
- Restart the managed service and verify `/health`, `/ready`, `/status`, the
  expected build identity, and the live binding projection.

## Non-goals

- Automatically converting rejected steering into an ordinary task.
- Recreating or reattaching `task-4lrk` without an explicit creator action.
- Deleting historical dead letters, interactions, or audit records.
- Changing the four-character random `task-xxxx` tab naming policy.
