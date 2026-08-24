# Herdr Plugin Runtime Design

## Goal

Make Herdr Lark Bridge installable and operable as a native Herdr plugin. Herdr
becomes the primary deployment surface: enabling the plugin starts the bridge,
and plugin actions expose its lifecycle and diagnostics. The existing Node.js
bridge, SQLite state model, health server, and graceful-shutdown behavior remain
the service core. PM2 is removed from the supported deployment path.

## Scope

The plugin supports Linux, matching the bridge's current runtime requirements.
It adds a repository-root `herdr-plugin.toml`, a build/install entrypoint, and a
single lifecycle controller used by startup and actions. It updates runtime
configuration defaults and operator documentation for Herdr-managed paths.

This change does not rewrite the bridge as a Herdr pane, add a graphical pane,
change Lark behavior, or change the topic-to-pane domain model. It does not
promise that exiting Herdr stops the bridge because the installed Herdr plugin
protocol has no shutdown hook.

## Plugin Contract

The manifest declares:

- a Linux platform and the minimum locally supported Herdr version;
- a build command that installs locked npm dependencies and compiles TypeScript;
- a `[[startup]]` command that idempotently ensures the service is running; and
- globally unique `start`, `status`, `restart`, `stop`, and `logs` actions.

The actions are operational commands rather than panes. They print concise,
human-readable results and return non-zero for invalid configuration or failed
operations. `status` reports whether the managed PID is alive and, when alive,
queries the bridge's local `/status` endpoint without exposing secrets. `logs`
prints a bounded recent tail instead of following forever.

## Runtime Layout

Herdr-provided directories are authoritative:

- `$HERDR_PLUGIN_ROOT` contains the manifest, compiled application, and scripts.
- `$HERDR_PLUGIN_CONFIG_DIR/.env` contains operator-owned configuration and Lark
  credentials.
- `$HERDR_PLUGIN_CONFIG_DIR/projects.json` contains the project allowlist unless
  `PROJECTS_CONFIG_PATH` explicitly overrides it.
- `$HERDR_PLUGIN_STATE_DIR/bridge.db` stores durable bridge state unless
  `BRIDGE_DATABASE_PATH` explicitly overrides it.
- `$HERDR_PLUGIN_STATE_DIR/bridge.pid` identifies the managed process.
- `$HERDR_PLUGIN_STATE_DIR/bridge.log` receives stdout and stderr.

The controller creates the config and state directories with private-friendly
permissions where possible. It never copies, prints, or rewrites credentials. A
checked-in `.env.example` remains the configuration template.

## Lifecycle Controller

One POSIX shell script owns all lifecycle operations so startup and manual
actions cannot drift. It resolves plugin directories, loads `.env` without
depending on an interactive shell, validates required files and the compiled
entrypoint, and launches Node detached from the invoking plugin command.

PID handling is defensive:

1. Read the PID file only if it contains a positive integer.
2. Treat the process as managed only when it is alive and its command line
   identifies this plugin's compiled `dist/main.js`.
3. Remove an invalid or stale PID file without signaling an unrelated process.
4. Start at most one candidate process from the controller.
5. Retain the existing fenced SQLite lease as the final cross-process guard.

`start` launches the process, then waits for a bounded readiness interval. A
successful start requires `/ready` to respond successfully. If the child exits
or readiness times out, the action fails and points to the bounded log location.
An already ready managed process is success and performs no restart.

`stop` sends `SIGTERM` only to a verified managed PID and waits for the bridge's
existing graceful shutdown interval. If it does not exit in the bounded window,
the action fails without escalating to `SIGKILL`; operators retain control over
destructive termination. `restart` is a successful stop followed by start.

Herdr startup must not hang indefinitely. Its startup command invokes the same
bounded `start` operation. Configuration or readiness failures are recorded in
the plugin command log and bridge log and returned as failures for diagnosis.

## Application Configuration

The application continues to consume normal process environment variables. The
controller supplies plugin-native defaults only when the corresponding variable
is unset:

- `PROJECTS_CONFIG_PATH=$HERDR_PLUGIN_CONFIG_DIR/projects.json`
- `BRIDGE_DATABASE_PATH=$HERDR_PLUGIN_STATE_DIR/bridge.db`

All current explicit environment overrides remain supported. The application
does not gain knowledge of PID files or process management; those concerns stay
in the plugin controller. Foreground `npm start` remains available for local
development and diagnosis.

## Build and Upgrade Behavior

The manifest build step runs `npm ci` and `npm run build` from the plugin root.
Linking a development checkout therefore validates the locked dependency graph
and creates `dist/main.js`. Updating source does not silently replace a live
process; the operator invokes the plugin's `restart` action after a successful
build.

The PM2 ecosystem file is deleted. Historical design documents remain
historical; active README instructions and troubleshooting no longer direct
operators to PM2.

## Failure Handling and Observability

Lifecycle failures name the failed phase: configuration, build artifact, launch,
readiness, stop, or status probe. Output includes safe paths to the config, state,
and log locations but never environment values. The Node service keeps its
structured Pino logs, correlation identifiers, health endpoints, lease status,
and graceful-shutdown logging.

A dead process with a stale PID is recoverable by `start`. A live unrelated PID
is never signaled. A second service process that bypasses the controller is
rejected by the existing SQLite lease. Missing `.env` or `projects.json` fails
before launch with a direct setup instruction.

## Verification

Automated verification covers:

- manifest fields and action declarations;
- plugin-directory default resolution and explicit override precedence;
- missing configuration and missing build output;
- successful start and readiness;
- idempotent repeated start;
- stale and malformed PID recovery;
- refusal to signal an unrelated PID;
- bounded status and log output; and
- graceful stop and restart.

Repository acceptance runs the full test suite, typecheck, and build. Native
acceptance links this checkout with `herdr plugin link <path> --enabled`, verifies
the plugin appears in `herdr plugin list --json`, and invokes the real `status`,
`start`, `restart`, `logs`, and `stop` actions against isolated temporary plugin
config/state where feasible. Live Lark connectivity is required only when valid
credentials are present; otherwise readiness failure must be safe and
diagnosable.

## Documentation and Migration

The README documents link, configure, start, inspect, restart, stop, update, and
unlink workflows using Herdr commands. It explains that disabling or exiting
Herdr is not a shutdown signal and directs operators to invoke `stop` first when
they want the bridge process terminated. The existing `.env.example` documents
plugin-native defaults without committing secrets.

Existing PM2 operators stop and remove the PM2 process before enabling the
plugin so that only one process owns the database lease. Existing database and
project configuration can be moved into the plugin directories or retained via
explicit absolute environment overrides during migration.
