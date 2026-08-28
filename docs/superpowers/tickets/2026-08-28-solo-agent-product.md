# Ticket: Solo Agent Product

## Status

Approved for implementation on 2026-08-28.

## Problem

Herdr Lark Bridge currently exposes one Lark topic as one TraeX-backed Herdr
pane. It already has durable prompt delivery, recovery, CardKit projection, and
an operational plugin, but it is not a standalone multi-agent product. A user
cannot explicitly manage several projects, create multiple named agent
instances with different runtimes, isolate writable workers in Git worktrees,
or let a primary instance coordinate existing workers without manually
operating Herdr.

## Outcome

Turn the bridge into a headless, human-controlled agent product. Herdr remains
the mandatory pane and process runtime, but its TUI is optional. A user manages
projects and named instances from Feishu, selects Pi, Claude Code, Codex, or
TraeX per instance, assigns one primary instance per project, and explicitly
chooses where each message goes. The primary may coordinate existing workers in
the same project through controlled tools, but it cannot create, remove, or
retarget instances.

- Design: [Solo Agent Product](../specs/2026-08-28-solo-agent-product-design.md)
- Plan: [Solo Agent Product Implementation Plan](../plans/2026-08-28-solo-agent-product.md)

## Acceptance Criteria

1. The daemon runs against a headless Herdr server without requiring the Herdr TUI.
2. Configuration supports multiple projects, each with at most one primary and multiple named workers.
3. A user explicitly creates, starts, stops, selects, promotes, and removes instances through one application control path shared by Feishu cards and commands.
4. Each instance declares an agent kind: `pi`, `claude-code`, `codex`, or `traex`; unavailable or unsupported adapters are reported honestly.
5. The primary uses the main checkout by default; writable workers use platform-owned branch and worktree leases by default.
6. Users can send FIFO turns to a selected instance and can explicitly steer or interrupt an active turn.
7. A primary can list, prompt, follow up, inspect, wait for, steer, and interrupt existing workers in its own project without per-call approval.
8. A primary cannot create, remove, promote, or call cross-project instances.
9. Worker completion updates durable state and Feishu views but never automatically triggers another primary turn.
10. SQLite remains authoritative for projects, instances, queues, operations, workspace leases, approvals, projections, audit, and outbox intent; Herdr remains authoritative for live pane and process facts.
11. A possibly delivered prompt is never replayed automatically. Restart recovery resumes observation or records an explicit uncertain state.
12. Dirty, conflicted, or unmerged worktrees are retained unless a user confirms a verified safe cleanup plan.
13. Routine operations may execute within configured scope, ordinary remote confirmations use Feishu, and privileged or destructive operations remain local-only.
14. Feishu delivery retries never repeat an agent turn, and card state is never used as workflow truth.
15. Adapter contract tests and a headless smoke test demonstrate the claimed capabilities of every adapter marked available.
16. Focused tests, the full Vitest suite, TypeScript typecheck, and production build pass for the implemented milestone.

## Delivery Slices

1. Introduce project, instance, adapter-capability, and workspace-lease domain contracts without changing current TraeX behavior.
2. Add durable instance configuration and lifecycle state, migrating current bindings as TraeX instances.
3. Extract Herdr pane hosting from the TraeX protocol and make TraeX the reference runtime driver.
4. Add human-controlled instance management and target routing in the application layer.
5. Add primary-to-existing-worker tools with project and generation fencing.
6. Add managed worker worktrees and safe removal planning.
7. Add Feishu instance directory, detail, creation, target, and control interactions.
8. Add Codex, Claude Code, and Pi drivers one at a time behind the same contract tests.
9. Package the standalone daemon and optional operator plugin, then run headless operational acceptance.

## Out of Scope

- Automatic task decomposition, worker creation, worker selection, or model selection.
- Automatically feeding a completed worker result into the primary.
- Automatic merge, cherry-pick, push, deployment, or destructive cleanup.
- Cross-project primary control or cross-host worker scheduling.
- Multi-tenant accounts, billing, or quotas.
- A general capability marketplace or complete event sourcing.
- Replacing the Herdr TUI or remotely approving every native agent prompt.
