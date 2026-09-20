# Superseded Card Quarantine Convergence Design

## Problem

An uncertain `card_update` must initially block its lane because the external effect may have completed. A later unclaimed, authoritative snapshot can safely supersede that update, but startup recovery currently recognizes only a new Primary Answer target. Same-target Worker Main snapshots remain blocked, and legacy Primary Answer update quarantines classified as `immutable` are excluded even when the complete replacement-target proof exists.

## Design

Startup recovery adds two proof-based convergence paths.

1. A same-target Worker Main update may advance when the failed reply is an uncertain `card_update`, the active quarantine is `replaceable_card`, and every pending row in the lane is an unclaimed `card_update` for the same Gateway, target message, binding, Worker, and Worker Session generation, with no Prompt or Worker Turn identity. The retained reply must also equal the authoritative Worker Main view version. The newest view is retained, older pending snapshots are dismissed, the lane quarantine is released as `released_newer_snapshot`, and the recovery obligation becomes `replacement_pending`. Only the retained reply's accepted ACK can mark it recovered through the existing delivery-evidence path.
2. The existing superseded Primary Answer recovery also accepts a legacy `immutable` quarantine when the failed operation itself is a `card_update` and all existing replacement-target proof remains satisfied: current Run Card and active static page agree, the new Answer create was durably delivered with matching card and message checkpoints, and every pending successor is unclaimed and targets that new projection.

Both paths run inside the existing SQLite startup transaction and refresh the lane head after the durable transition. They never retry the failed reply, never replay a Prompt, and never infer success from a newer local view alone.

## Safety

- Missing or mismatched Gateway, binding, Prompt, Worker, generation, target role, card role, or target message keeps the quarantine active.
- Any claimed or previously claimed successor keeps the quarantine active.
- The failed uncertain row and its audit evidence remain immutable dead-letter history.
- Releasing a lane does not mark recovery complete; only a matching accepted delivery does.
- Immutable creates, text replies, stream sequencing, and unrelated lanes remain unchanged.

## Acceptance

- A newer unclaimed Worker Main snapshot advances and its ACK resolves the old obligation.
- A mismatched or claimed Worker Main successor remains blocked.
- A legacy immutable Primary Answer update converges only with the existing exact replacement-target proof.
- Existing Answer, outbox, integrity, restart, and no-replay tests remain green.
