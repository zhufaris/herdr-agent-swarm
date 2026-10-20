# Group Orchestrator Rollout

This runbook is for the operator preparing the fixed Feishu-group Orchestrator.
It deliberately stops before installation, private configuration mutation,
service restart, and live smoke testing unless each operational action receives
a separate explicit approval.

## Candidate identities

- Swarm candidate: the repository commit that includes the completed group
  Orchestrator tickets and passes the gates below.
- Core candidate: commit `e71415fc`, which includes the exact-token creation,
  Pane identity reconciliation, same-Pane rotation contracts, and the stabilized
  legacy bootstrap test; or a later release containing those capabilities.
  Version text alone does not prove those capabilities.
- Private registry target: `${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm/projects.json`,
  unless `SWARM_CONFIG_DIR` or `PROJECTS_CONFIG_PATH` selects another location.
- Intended Orchestrator directory: the deployment-approved absolute directory.

Do not commit or print the live registry or `.env`; inspect only the fields
needed for the change.

## Gated procedure

Run these stages in order. Stop on any mismatch.

1. Verify the candidate Core before installing anything:

   ```bash
   /path/to/candidate/herdr --version
   /path/to/candidate/herdr tab create --help
   /path/to/candidate/herdr pane identity-reconcile --help
   /path/to/candidate/herdr agent session-rotate --help
   ```

   `tab create` must include `--expected-workspace-label` and `--token`.
   `pane identity-reconcile` must include `--operation-id`, all four
   `--expected-*` source fences, `--target-workspace`,
   `--expected-workspace-label`, and `--token`. `agent session-rotate` must
   include `--operation-id` and `--expected-state-change-seq`. Run the Core
   repository's complete gate and record its commit and binary checksum. Do not
   replace the active Herdr binary yet.

2. Build and audit the Swarm candidate without touching the service:

   ```bash
   npm ci
   npm run typecheck
   npm run build
   npm test
   npm run public:audit
   ```

3. After a separate install approval, install the compatible Core through its
   supported release process, then stage the Swarm release:

   ```bash
   ./install.sh
   ```

   Staging enables the user unit but does not start or restart it. Record the
   Core binary checksum and Swarm build identity before continuing.

4. Prepare the private registry edit only after the compatible binaries are in
   place. In the existing `herdr-agent-swarm` project object, preserve every
   current field and add exactly:

   ```json
   "orchestrator": {
     "enabled": true,
     "cwd": "/absolute/path/to/orchestrator/root"
   }
   ```

   Validate the complete private pair without exposing its contents:

   ```bash
   npm run config:validate -- \
     "$HOME/.config/herdr-agent-swarm/.env" \
     "$HOME/.config/herdr-agent-swarm/projects.json"
   ```

5. Inspect `npm run swarm:status`, the candidate/current build identities, the
   active-work restart gate, and pending prompt/outbox work. Obtain explicit
   approval for the live registry edit, restart, and smoke test. That approval
   is separate from code or documentation approval.

6. Only after that explicit approval, apply the validated private edit and run:

   ```bash
   npm run swarm:restart
   npm run swarm:status
   ```

7. Smoke-test with an allowed user in the configured group:

   - exactly one current Herdr Space has label `herdr`; a missing or duplicate
     exact label is a stop condition;
   - the existing Orchestrator converges in place to native token `orch`; record
     the Core receipt-defined Pane ID if a cross-Space move changes it, and
     verify terminal ID, Binding generation, fixed Thread, Workers, project,
     creator, and history are unchanged;
   - no Prompt dispatches while identity migration is `accepted`, `applying`,
     or `uncertain`; queued Prompt rows remain queued;
   - a first group-root `@Bot` message creates one Orchestrator Pane at the
     configured Orchestrator directory in the unique `herdr` Space with native
     token `orch`, and one fixed Thread;
   - a second group-root mention shares the same Thread and creates no Pane;
   - ordinary messages in that Thread reach the same TraeX Agent;
   - Orchestrator topology tools list only server-owned project scope;
   - after identity convergence, a newly issued `/swarm clear` requires the
     initiating administrator's confirmation,
     preserves Pane ID/token/name, Binding, Thread, Workers, and SQLite history,
     and reports exact withdrawal counts, including `partial` when applicable;
   - previously rejected clear records remain terminal and are not replayed;
   - task Primary, Worker, and alias Threads reject `/swarm clear`.

Capture only IDs, versions, checksums, state names, and count summaries needed
for evidence. Do not capture prompts, answers, credentials, or the registry.

## Current handoff state

本文件未修改 live 配置、未安装、未重启，也未执行 live smoke。完成候选构建后，下一步仍是
独立的运维显式批准，而不是自动继续上线。
