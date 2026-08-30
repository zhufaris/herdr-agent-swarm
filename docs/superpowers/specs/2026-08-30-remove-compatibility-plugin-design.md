# Remove the Compatibility Plugin Design

## Goal

Make Herdr Agent Swarm the repository's only supported application identity and
runtime. Remove the `herdr-lark-bridge` compatibility plugin, service lifecycle,
and active operator documentation so that every supported install, build, health
check, and lifecycle command refers to `herdr-agent-swarm`.

This design supersedes the compatibility-retention boundary in
`2026-08-30-standalone-service-cutover-design.md`. Historical documents remain
available as records of earlier decisions, but they are not operational
authority.

## Product Boundary

The canonical application has one identity and one operator surface:

- application and build identity: `herdr-agent-swarm`;
- user service: `herdr-agent-swarm.service`;
- configuration: `${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm`;
- state: `${XDG_STATE_HOME:-$HOME/.local/state}/herdr-agent-swarm`;
- lifecycle commands: `npm run swarm:setup`, `swarm:doctor`, `swarm:install`,
  `swarm:start`, `swarm:status`, `swarm:restart`, `swarm:stop`, and
  `swarm:logs`.

Herdr remains a required runtime dependency for pane and agent control. The
removed dependency is specifically the repository's old Herdr plugin wrapper
and its `herdr-lark-bridge.service`; removing it does not replace the Herdr CLI,
socket API, snapshot reconciliation, or pane ownership model.

## Repository Changes

Delete the active compatibility surface:

- `.codex-plugin/` and `plugin/`;
- plugin-mode branches in `install.sh`;
- compatibility-only service templates and lifecycle helpers;
- compatibility-to-standalone migration commands and orchestration that are no
  longer needed after the one-way removal;
- tests whose only purpose is preserving plugin installation or compatibility
  lifecycle behavior.

`install.sh` becomes a standalone installer. With no mode flag it installs a
versioned runtime release, validates the private standalone configuration, and
writes `herdr-agent-swarm.service`. It does not invoke `herdr plugin`. Obsolete
plugin flags fail with a concise migration message pointing to the standalone
commands rather than silently changing behavior.

The repository guide, README, architecture documentation, package scripts, and
current plans must stop presenting the compatibility plugin as supported.
Archived specs and plans may retain historical literals when their location and
introductory status make clear that they are not current instructions.

## Identity Migration

Generated build metadata uses `serviceId: "herdr-agent-swarm"`. Runtime identity
validation, health responses, lifecycle preflight checks, tests, fixtures, and
internal socket request identifiers use the same product identity. Domain test
fixtures may still contain a project or path named `herdr-lark-bridge` when the
literal is test data rather than a service identity.

Identity is not part of the SQLite domain schema. Existing bindings, prompts,
cards, outbox rows, audit records, and leases remain unchanged. The migration
does not rewrite durable business data or replay prompts.

## Runtime Removal

The repository change and live cleanup are separate gates. Code can be built and
tested while the current service is busy. Live cleanup begins only after these
durable and runtime counters are safe:

- no running or queued prompt that would be interrupted by the operation;
- no active prompt worker;
- no active, dispatching, observing, or uncertain instance turn;
- no pending or actively delivering outbox item;
- startup recovery is completed and SQLite quick check is healthy.

Before changing services, resolve the process listening on the configured port
to its actual PID and user systemd unit. Stop and disable every obsolete
`herdr-lark-bridge.service` or transitional Agent Swarm unit before starting the
canonical service. Never run two processes against the same SQLite database.

The live operation preserves the configured absolute database path. It does not
copy the database, because a live SQLite database must not be separated from its
WAL and SHM files. After the canonical service is verified, remove the obsolete
user-unit file and unlink the repository's old Herdr plugin registration. Keep
private configuration and runtime data until the new service is verified; any
later deletion is a separate explicit cleanup action.

There is no automatic force path. If the safety gate is not clear, report the
active work and defer live removal. Explicit user authorization is required to
interrupt active work. Even with authorization, uncertain dispatched prompts
are detached and observed again; they are never automatically replayed.

## Failure Handling

Failure before the old runtime is stopped changes no live state. If canonical
startup fails after shutdown, leave competing units stopped, preserve all
configuration and SQLite files, and report bounded recovery commands. Do not
restart the retired compatibility unit automatically, because completion of
this design makes that runtime unsupported.

The canonical service is accepted only when all of these hold:

- `herdr-agent-swarm.service` is active and enabled;
- the configured endpoint belongs to that unit's PID;
- `/status` reports the generated `herdr-agent-swarm` identity and build ID;
- startup recovery is completed;
- `/ready` reports database, projects, Herdr, Lark, lease, and instance runtime
  ready;
- SQLite quick check is healthy;
- prompt and outbox state shows no replay caused by the transition.

## Tests and Static Gates

Focused tests must prove that:

- build identity accepts only `herdr-agent-swarm`;
- health and status expose the canonical identity;
- standalone lifecycle commands target only `herdr-agent-swarm.service`;
- the installer never links or invokes a Herdr plugin;
- lifecycle status rejects an endpoint with any other service identity;
- restart safety and no-replay behavior remain intact;
- active repository code, manifests, scripts, and operator documentation contain
  no supported `herdr-lark-bridge` plugin or service entrypoint.

Final repository verification consists of affected Vitest files,
`npm run typecheck`, `npm run build`, `npm test`, `git diff --check`, and a
targeted repository scan. The scan excludes `docs/archive/` and historical
design/plan records, and classifies any remaining literal by role instead of
blindly renaming domain fixtures.

## Documentation Authority

`AGENTS.md` is updated so the repository is described only as Herdr Agent
Swarm. It must no longer say the old one-topic/one-TraeX bridge remains
available. Build and operations guidance uses only standalone commands.

`README.md`, `docs/architecture.md`, and current operator documentation remove
plugin setup, plugin lifecycle, compatibility rollback, and old unit commands.
Historical files remain under archival or explicitly dated design/plan paths and
are not linked as current operating instructions.

## Non-goals

- Removing Herdr itself or replacing Herdr pane/agent integration.
- Changing the Lark message model, prompt FIFO, steering, reconciliation,
  CardKit rendering, or SQLite schema.
- Moving or copying the live SQLite database.
- Deleting private legacy configuration or state before canonical verification.
- Rewriting archived documents to pretend the compatibility implementation
  never existed.
- Restarting or interrupting a live service as part of repository-only changes.
