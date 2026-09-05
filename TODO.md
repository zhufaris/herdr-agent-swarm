# TODO

## Swarm command context boundaries

- [ ] Refactor swarm command handling into an explicit context boundary.
- [ ] Add a swarm command that creates a new Worker pane directly inside a specified Primary pane context.
  - Resolve and persist the exact Primary binding, pane, and generation before provisioning.
  - Keep Worker ownership scoped to that Primary pane; do not fall back to project-level Worker creation.
  - Preserve idempotency, authorization, worker limits, same-name session semantics, and durable operation recovery.

## Release version

- [ ] Bump `herdr-agent-swarm` to `0.3.0` and synchronize package lock and generated build metadata.

## Feishu instance creation card callback failure

- [ ] Diagnose and fix the failure shown after clicking `创建实例` on the `/instances` card.
  - Confirmed: the `/instances` directory card is delivered successfully.
  - Confirmed: clicking the button does not create an `agent_instances` or `instance_operations` record, so the failure occurs before instance/worktree provisioning.
  - Add redacted structured logging at the `card.action.trigger` boundary. Record the action name, message ID, elapsed time, and result or safe error; never record form values.
  - Distinguish whether the callback is not received, exceeds Lark's response deadline, or returns a card payload rejected by CardKit.
  - Add a regression test at the Lark adapter and instance interaction boundary using the captured failure shape.
  - Verify the fix with focused tests, typecheck, build, and one live `创建实例` interaction.
  - Do not restart the service until the code change has been built and the existing active/uncertain work has been checked.
