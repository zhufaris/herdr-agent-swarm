# Native Herdr Plugin Migration Design

## 1. Goal

Convert Herdr Lark Bridge from a repository-operated PM2 service into a native
Herdr plugin. Herdr becomes the installation and operator entry point, while a
user-level systemd service continues to host the long-running Node.js process.

The migration changes packaging, configuration ownership, service lifecycle,
and operational documentation. It does not redesign the bridge's Lark, queue,
card, reconciliation, or pane-control behavior.

## 2. Decisions

- The plugin ID is `herdr-lark-bridge`.
- Linux is the initial supported platform.
- `herdr-plugin.toml` is the canonical install and action manifest.
- Herdr actions and panes provide all routine setup and operations.
- A `systemd --user` unit owns the long-running bridge process.
- PM2 support and `ecosystem.config.cjs` are removed. There is no dual runtime.
- Persistent configuration and data live outside the plugin checkout.
- Existing domain behavior and SQLite safety mechanisms remain intact.
- Plugin installation never starts an unconfigured bridge automatically.

## 3. Runtime Architecture

```text
Herdr plugin registry
  |
  +-- build: install locked dependencies and compile TypeScript
  |
  +-- actions: setup, start, stop, restart, status, logs,
  |            configure-projects, uninstall-service
  |
  +-- managed panes: setup, status, logs, project configuration
  |
  +-- plugin config directory
       +-- bridge.env
       +-- projects.json
       +-- bridge.db (+ SQLite sidecars)

systemd --user
  +-- herdr-lark-bridge.service
       +-- Node.js dist/main.js
            +-- Lark long connection
            +-- SQLite lease and write fence
            +-- Herdr CLI adapter
            +-- local health server
```

Herdr actions are short-lived commands. They install or control the service;
they do not keep the bridge alive themselves. This follows the operational
shape of Herdr Mobile Relay, which exposes native plugin actions while handing
its persistent process to the user's service manager.

## 4. Plugin Layout

The repository gains the following plugin-facing files:

```text
herdr-plugin.toml
plugin/
  build.sh
  open-pane.sh
  setup.sh
  service.sh
  status.sh
  logs.sh
  configure-projects.sh
  uninstall-service.sh
  systemd/
    herdr-lark-bridge.service.template
```

The existing application remains under `src/`, with compiled output under
`dist/`. Plugin scripts use `HERDR_PLUGIN_ROOT` to locate repository assets and
`HERDR_PLUGIN_CONFIG_DIR` for user-owned configuration and state. They must not
assume that an action's current working directory is the plugin root.

### 4.1 Manifest

`herdr-plugin.toml` declares:

- `id = "herdr-lark-bridge"`;
- the minimum Herdr version actually exercised by the bridge;
- Linux platform support;
- one build command;
- actions for each supported operation;
- interactive panes used by actions that need terminal input or continuous
  output.

The first version does not add Herdr event hooks. Lark supplies the inbound
event stream, and the bridge already reconciles Herdr state. Adding broad
workspace or pane hooks would duplicate reconciliation and create extra process
starts without improving correctness.

### 4.2 Build

The manifest build step runs a checked-in script which:

1. validates the required Node.js and npm versions;
2. runs `npm ci`;
3. runs the TypeScript production build;
4. checks that `dist/main.js` exists and is readable.

The build step does not create configuration, start a service, contact Lark, or
modify existing runtime data. A failed build leaves the currently installed and
running service untouched.

## 5. Configuration and State

### 5.1 Canonical Paths

Herdr provides the plugin config directory. Runtime files are rooted there:

```text
$HERDR_PLUGIN_CONFIG_DIR/bridge.env
$HERDR_PLUGIN_CONFIG_DIR/projects.json
$HERDR_PLUGIN_CONFIG_DIR/bridge.db
```

`bridge.env` is mode `0600`; the config directory is mode `0700`. The SQLite
database and its WAL/SHM sidecars remain service-owned files in that directory.
The plugin checkout contains no credentials or mutable production state.

The generated service receives explicit absolute paths:

```dotenv
PROJECTS_CONFIG_PATH=/absolute/plugin/config/projects.json
BRIDGE_DATABASE_PATH=/absolute/plugin/config/bridge.db
HERDR_BIN=/absolute/path/to/herdr
TRAEX_BIN=/absolute/path/to/traex
```

This avoids dependence on the service manager's working directory or interactive
shell `PATH`. Existing optional environment settings retain their current names
and validation rules.

### 5.2 Setup Flow

The `setup` action opens a managed, zoomed Herdr pane. The script:

1. resolves and validates `HERDR_PLUGIN_ROOT` and
   `HERDR_PLUGIN_CONFIG_DIR`;
2. checks Node.js, `herdr`, `traex`, and systemd user-service availability;
3. prompts for required Lark identifiers and secrets without echoing secrets;
4. writes `bridge.env` atomically with restrictive permissions;
5. creates or preserves `projects.json`;
6. validates configuration using application-owned validation code;
7. installs or refreshes the systemd user unit;
8. reloads systemd and starts or restarts the service;
9. waits for `/health` and `/ready`, then reports actionable diagnostics.

Setup is idempotent. Existing values are retained unless the user replaces
them. A temporary file is validated before replacing `bridge.env` or
`projects.json`. Failed validation does not damage the last working config.

### 5.3 Legacy Import

If canonical plugin configuration is absent, setup may offer a one-time import
from a user-selected existing checkout. It recognizes `.env` and
`config/projects.json`, validates them, copies their values into the canonical
plugin config directory, and leaves the source files untouched.

Legacy import is explicit, not automatic path discovery. It never copies the
SQLite database unless the user supplies its exact path and confirms the move.
This prevents an apparently fresh installation from silently adopting unrelated
credentials or bridge history.

## 6. Service Lifecycle

### 6.1 Unit Definition

The installed unit is `herdr-lark-bridge.service` under the user's systemd unit
directory. It includes:

- `EnvironmentFile=` pointing to `bridge.env`;
- an absolute `ExecStart` using the selected Node binary and current plugin
  `dist/main.js`;
- `WorkingDirectory` set to the plugin root;
- restart-on-failure with a bounded delay;
- a stop timeout compatible with the bridge's graceful shutdown window;
- journal-backed stdout and stderr;
- no root privileges.

The setup or restart action regenerates the unit atomically so an upgraded or
newly linked plugin root is reflected before restart. The script runs
`systemctl --user daemon-reload` only after the replacement unit is valid.

### 6.2 Existing Runtime Safeguards

The SQLite instance lease and write fence remain. systemd normally provides one
process, but the database guard still protects against manual starts, stale
service instances, and accidental duplicate units. `/health`, `/ready`, and
`/status` remain available on loopback for diagnostics and smoke tests.

SIGTERM continues through the existing bounded shutdown sequence: stop intake,
settle or abort active work according to current policy, flush projections and
outbox work, close health serving, release the write fence and lease, and close
SQLite.

## 7. Native Actions and Panes

### 7.1 `setup`

Opens the interactive setup pane described above. It is the primary entry point
after `herdr plugin install` or `herdr plugin link`.

### 7.2 `start`, `stop`, and `restart`

These actions are non-interactive service controls. They validate that setup is
complete before starting. Repeated calls are idempotent. `restart` refreshes the
unit first so it also activates a newly built plugin version.

### 7.3 `status`

Opens an overlay pane and reports, without exposing secrets:

- plugin and application version;
- resolved plugin root and config directory;
- presence and permissions of required config files;
- systemd unit load/enable/active state;
- bounded recent journal errors;
- `/health`, `/ready`, and operational `/status` results;
- the next exact action when a check fails.

The status command has a finite timeout and must still render useful output when
the service is down or a health endpoint is unreachable.

### 7.4 `logs`

Opens a split pane running a follow-mode user journal view scoped to the bridge
unit. Closing the pane stops only `journalctl`; it does not stop the bridge.

### 7.5 `configure-projects`

Opens a managed pane that copies the current registry to a temporary file, opens
the user's terminal editor, validates the result, atomically installs it, and
restarts the service only after successful validation. The default editor is
`$EDITOR`, falling back to `vim` on this headless Linux host.

### 7.6 `uninstall-service`

Stops, disables, and removes only the user service and its unit file. It keeps
`bridge.env`, `projects.json`, `bridge.db`, and Lark/Herdr history. Plugin
unregistration remains a separate `herdr plugin uninstall herdr-lark-bridge`
operation.

Destructive data removal is deliberately outside this action. A future purge
action would require explicit confirmation and path validation.

## 8. Upgrade and Rollback Behavior

Plugin installation or linking builds code but does not restart a live bridge.
The operator invokes `restart` after a successful build. That action rewrites the
unit to the current plugin root, reloads systemd, restarts the service, and checks
readiness.

If readiness fails, the action reports the failing unit and journal evidence. It
does not modify or delete configuration or the database. Source rollback is
performed through Herdr's plugin install/link mechanism, followed by the same
restart action. SQLite schema changes must therefore remain forward-safe under
the repository's existing migration policy.

## 9. Application Changes

The application receives a thin bootstrap refactor so scripts can validate
configuration without starting Lark or acquiring the database lease:

- preserve `loadConfig` as the authoritative parser;
- expose a CLI validation entry point for `bridge.env` plus `projects.json`;
- keep `src/main.ts` as the service entry point;
- resolve all production paths from explicit environment variables;
- include the application/plugin version in operational status output.

No coordinator, domain event, card, prompt queue, or reconciliation semantics
change as part of this migration. Herdr access may continue through the existing
typed CLI adapter; being a native plugin does not require bypassing supported
Herdr commands or using undocumented sockets.

## 10. Removed Surfaces

The migration removes:

- `ecosystem.config.cjs`;
- PM2 installation, startup, restart, save, and log instructions;
- repository-local `.env` as the documented production configuration;
- repository-relative production database and project-registry defaults from
  operational examples.

Developer commands such as `npm run dev`, `npm test`, and `npm run build` remain.
Direct foreground execution remains a development/debugging technique, not a
second supported production deployment method.

## 11. Failure Handling

- Missing configuration: refuse start and direct the user to the setup action.
- Invalid project registry: preserve the previous file and show validation
  errors in the managed pane.
- Missing binaries: report the exact unresolved dependency before writing a
  service unit.
- Busy health port: leave the service failed, show the owning-port diagnostic,
  and preserve all state.
- Duplicate process: SQLite fencing rejects the second writer.
- Build failure: do not restart the current service.
- Restart/readiness failure: show bounded journal and endpoint evidence; do not
  roll back or delete data automatically.
- Plugin uninstall with a live service: documentation requires running
  `uninstall-service` first so the unit never points at a removed plugin root.

## 12. Testing and Acceptance

### 12.1 Automated Checks

- Existing unit and integration tests continue to pass.
- Type checking and production build pass.
- Shell scripts pass syntax checks.
- Manifest structure is validated by linking the plugin with Herdr.
- Config-path tests prove that secrets, registry, and SQLite resolve under the
  plugin config directory rather than the repository.
- Setup helpers are tested against temporary config and unit directories.
- Service rendering tests assert absolute paths, restrictive config permissions,
  restart policy, and graceful stop timeout.
- Status tests cover running, stopped, missing-config, and unhealthy-service
  states without leaking secrets.

### 12.2 Local Plugin Acceptance

From this worktree:

1. run the plugin build;
2. link it with `herdr plugin link <worktree> --enabled`;
3. verify all actions are discoverable;
4. use an isolated plugin config directory to validate setup and service-unit
   generation;
5. start the service with test-safe configuration or controlled adapter fakes;
6. verify status and logs panes launch through Herdr;
7. verify stop and uninstall-service leave configuration and SQLite intact.

Real Lark credentials are never embedded in automated tests. The existing
real-user smoke observer remains an explicit final acceptance step after the
operator supplies valid credentials.

## 13. Completion Criteria

The migration is complete when:

- the repository links as an enabled Herdr plugin on Herdr 0.7.5 or newer;
- setup can create valid private configuration and a working user service;
- start, stop, restart, status, logs, project configuration, and service removal
  are reachable as plugin actions;
- the bridge becomes healthy and ready under systemd with valid configuration;
- plugin upgrades preserve config and SQLite state;
- PM2 and its documentation are absent;
- all existing behavior tests and new plugin lifecycle tests pass.
