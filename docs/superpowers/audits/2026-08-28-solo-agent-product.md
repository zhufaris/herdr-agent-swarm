# Solo Agent Product Completion Audit

## Objective and evidence boundary

Ship a standalone, human-controlled multi-project agent service on Herdr's
headless runtime. Each project has at most one Primary and explicitly created
Workers. The implementation supports TraeX, Codex, Claude Code, and Pi driver
contracts, uses Feishu as the gateway, and preserves SQLite durability,
generation fencing, no-replay, and local-only high-risk approval. Automatic
worker creation/selection, automatic Primary continuation, merge, push, deploy,
and destructive cleanup remain out of scope.

Live evidence in this audit is intentionally narrower than executable
discovery. The user-selected production acceptance is TraeX Primary plus TraeX
Worker. Codex and Claude Code executables are present on this host, but Codex is
affected by unrelated global hook/MCP configuration and Claude Code is not
authenticated. Pi is not installed. None is claimed as live-verified.

## Prompt-to-artifact matrix

| # | Requirement | Implementation | Tests and live evidence | Result |
|---|---|---|---|---|
| 1 | Headless daemon; TUI/plugin optional | `scripts/solo-agent.sh`, `src/cli/plugin-lifecycle.ts`, `service/solo-agent.service` | `plugin-lifecycle.test.ts`; smoke ran from CLI against Herdr 0.7.5 | Complete |
| 2 | Multiple projects; one Primary and named Workers | `config.ts`, `agent-instance.ts`, `sqlite-store.ts` | `config.test.ts`, `sqlite-store.test.ts`, `instance-control.integration.test.ts` | Complete |
| 3 | Human-controlled create/start/stop/select/promote/remove | `instance-control-workflow.ts`, `instance-interaction-workflow.ts`, Feishu cards/router | `instance-control.integration.test.ts`, `instance-routing.integration.test.ts`, `instance-cards.test.ts` | Complete |
| 4 | TraeX, Codex, Claude Code, Pi with honest availability | `runtime/agents/*-driver.ts`, `agent-availability.ts` | `agent-driver-contract.test.ts`; live status documented above | Complete |
| 5 | Primary main checkout; writable Worker worktree | `instance-control-workflow.ts`, `worktree-manager.ts` | control and worktree manager tests; live dirty worktree retention assertion | Complete |
| 6 | FIFO turns plus explicit steer/interrupt | `instance-messaging-workflow.ts`, `instance-work-scheduler.ts` | `instance-messaging.integration.test.ts`, `steering-integration.test.ts` | Complete |
| 7 | Primary controls existing same-project Workers without per-call confirmation | `primary-tool-broker.ts`, `primary-tool-gateway.ts`, `primary-tools-mcp.ts` | broker, gateway, MCP tests; live `primaryCalledExistingWorker=true` | Complete |
| 8 | No topology tools or cross-project calls for Primary | Fixed seven-tool MCP surface and broker identity fences | `primary-tools-mcp.test.ts`, `primary-tool-broker.test.ts`, gateway forged-identity test | Complete |
| 9 | Worker completion never triggers Primary | Scheduler only drains target instance; no callback edge | messaging integration test; live `workerCompletionDidNotTriggerPrimary=true` | Complete |
| 10 | SQLite/Herdr/Git/Feishu authority split | Store, runtime reconciler, worktree manager, projection/outbox modules | store, reconciler, worktree, publisher suites | Complete |
| 11 | Possibly delivered work is never replayed | Dispatch receipts, uncertain state, recovery fences | driver and scheduler tests; live `restartDidNotReplay=true` | Complete |
| 12 | Unsafe worktrees retained | `WorktreeManager.planRemoval`, confirmation fingerprint/generation | worktree and control tests; live `dirtyWorktreeRetainedAfterStop=true` | Complete |
| 13 | Routine, remote-confirmation, local-only tiers | `approval-policy.ts`, durable approval grants | approval/store tests; live single-use confirmation and `gitPushLocalOnly=true` | Complete |
| 14 | Outbox retries do not repeat turns; cards are projections | outbox/projector architecture unchanged; instance messages are separate durable turns | existing publisher/outbox/store suites plus scheduler tests | Complete |
| 15 | Driver contracts plus selected live deployment | four drivers and capability registry; TraeX MCP launch quoting | `agent-driver-contract.test.ts`, `herdr-adapter.test.ts`; real TraeX/TraeX smoke | Complete |
| 16 | Full verification | Commands and pass criteria recorded below | Full suite, typecheck, build, validation, smoke | Complete when the final gate below passes without further edits |

## Explicit user decisions

- Worker creation and all topology changes remain explicit human actions.
- Primary calls to an existing same-project Worker do not require confirmation.
- Primary cannot create, delete, promote, retarget, auto-select, or cross-project
  call a Worker.
- Worker completion updates durable state only and does not create a Primary turn.
- Primary and Worker live acceptance uses TraeX for both roles.
- Mission-style autonomous orchestration is not implemented.

## Live headless acceptance

`npm run smoke:headless-multi-agent -- --execute` completed through real product
components: SQLite store, control workflow, worktree manager, Primary capability
gateway, stdio MCP shim, Herdr panes, and TraeX processes. Evidence:

- Herdr `0.7.5`; TraeX `0.201.6` internal edition.
- Primary instance `4952a73d-904b-47c6-af5f-32b12bd702af`, pane `wH:p5E`,
  turn `d29944c5-0c99-4d5a-bee5-79ed407f9475`: completed.
- Worker instance `74251acc-4fa1-4857-8c48-835d29d4854e`, pane `wH:p5F`,
  turn `1da6375f-f276-4768-bb93-4a8a23890837`: completed.
- Primary called the existing Worker through the fixed MCP surface.
- Worker completion did not trigger a Primary turn.
- Reopening SQLite and resubmitting the same idempotency key did not replay work.
- Remote confirmation was consumed once; Git push remained local-only.
- Stopping instances retained a deliberately dirty Worker worktree.
- The smoke created and removed only temporary panes/repository state; no Herdr
  TUI interaction was required.

## Adapter status

| Adapter | Contract | Executable on audit host | Live verified | Notes |
|---|---|---:|---:|---|
| TraeX | Yes | Yes | Yes | Primary and Worker product path passed |
| Codex | Yes | Yes | No | Host has unrelated invalid global hooks and a missing global MCP executable |
| Claude Code | Yes | Yes | No | CLI reports not logged in |
| Pi | Yes | No | No | Reported unavailable |

## Final verification gate

The completion gate is a fresh run after the final documentation edit:

- validate `.env.example` plus `projects.example.json` after replacing its
  intentional placeholder `cwd` with an accessible temporary path;
- run the focused packaging/runtime suite and the complete `npm test` suite;
- run `npm run typecheck` and `npm run build`;
- run `npm run smoke:headless-multi-agent -- --execute` and require
  `productPath=true` with every safety assertion true;
- run `git diff --check`, inspect `git status`, and verify no tracked secret,
  database, WAL/SHM, log, or live `config/projects.json` artifact.

The delivery report and commit record carry the exact fresh counts and build ID;
this audit records the durable acceptance mapping rather than a mutable test log.

## Residual non-goals

No autonomous task decomposition, worker provisioning/selection, automatic
Primary callback, merge/cherry-pick/push/deploy, destructive cleanup,
cross-project control, cross-host scheduling, or remote approval of native
unstructured agent prompts is included. These are intentional boundaries, not
incomplete acceptance criteria.
