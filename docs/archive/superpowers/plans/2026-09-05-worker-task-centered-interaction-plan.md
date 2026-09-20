# Worker Task-Centered Interaction Implementation Plan

**Goal:** Make Worker Task Cards the state-aware surface for supplementing or
continuing work, add an unambiguous new-task entry on Worker Main, and restore a
real Primary-to-Worker acceptance run for the current Thread Primary model.

**Architecture:** Keep `InstanceInteractionWorkflow` as the Lark routing boundary
and `InstanceMessagingWorkflow` / exact-turn steering as the durable execution
boundaries. Add pure state-to-interaction policy used by renderers and routing.
Do not change queue, transcript, lifecycle, approval, or replay authority.

## Task 1: Centralize Worker task interaction policy

- Add a pure domain policy mapping each task phase to reply intent, guidance, and
  legal actions.
- Cover active, terminal, queued, and uncertain states with unit tests.
- Use this policy in direct Task Card reply routing so state changes reject
  instead of silently changing intent.

## Task 2: Add state-aware Task Card controls

- Render `补充当前任务` for running/blocked tasks, `继续这个任务` for terminal
  tasks, and `停止当前任务` only for running tasks.
- Render guidance without a mutating action for queued and dispatch-uncertain.
- Bind callbacks to Worker generation, session generation, task, Primary binding,
  and the initiating operator where required.
- Test action visibility, stale-card rejection, exact steering, follow-up FIFO,
  and idempotency.

## Task 3: Add Worker Main new-task form

- Render `发起新任务` only for an active, usable Worker session.
- Submit an independent `kind: turn` through `InstanceMessagingWorkflow`; never
  infer steer or follow-up.
- Return whether the task started or its FIFO queue position.
- Test authorization, stale generation/session/binding rejection, empty input,
  duplicate submission, and busy-worker queue feedback.

## Task 4: Update operator documentation

- Document the three prompt meanings and state-dependent Task Card reply rules in
  `docs/feishu-group-usage.md`.
- Keep `/to`, `/steer`, and `/stop` as explicit shortcuts.
- Run the docs audit.

## Task 5: Repair the real product smoke

- Replace obsolete Primary instance creation with an isolated Herdr pane plus an
  active SQLite binding that represents the Thread Primary.
- Start and verify real TraeX in that pane, issue a Primary prompt with the MCP
  capability, create a derived Worker through `createWorker`, and exercise the
  real Primary MCP delegation path.
- Verify completion, no automatic Primary turn, idempotent restart, and cleanup
  of only owned panes/worktrees.

## Task 6: Verification and delivery

- Run focused interaction and Primary/Worker integration tests.
- Run `npm run typecheck`, `npm run build`, and `npm test`.
- Run smoke preflight and `npm run smoke:headless-multi-agent -- --execute`.
- Inspect the final diff and worktree, map each design acceptance item to evidence,
  and commit implementation in thematic batches.
