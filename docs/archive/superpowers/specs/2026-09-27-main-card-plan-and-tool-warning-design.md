# Main Card Plan and Primary Tool Notice Design

## Goal

Reduce Main Card noise while keeping the authoritative execution plan immediately readable.

## Design

- Keep `primaryToolsAvailable` and `primaryToolsNotice` in the durable topic view so capability checks and recovery remain unchanged.
- Do not render `primaryToolsNotice` on the shared Main Card. This removes only the repeated user-facing callout; it does not grant tools or alter `/swarm reset` and `/swarm replace`.
- Render every authoritative `update_plan` step directly inside the expanded `当前任务` panel, regardless of plan length. Do not add a nested collapsed `完整计划` panel or duplicate the active step.
- Preserve all unrelated degraded, orphaned, blocked, and runtime notices.

## Verification

- A topic view with unavailable Primary tools retains its durable availability state but its rendered Main Card omits the notice text.
- A plan longer than five steps renders every step exactly once and contains no nested plan panel.

