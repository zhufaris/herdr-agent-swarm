# Herdr-Native Runtime Architecture Design

## 1. Goal

Make Herdr Lark Bridge a native Herdr plugin with clear ownership boundaries:

- Herdr owns plugin discovery, build entry points, actions, panes, and event hooks.
- The user service manager owns the long-running bridge process.
- The bridge owns Lark delivery, durable workflow state, and reconciliation policy.
- Herdr's current snapshot is authoritative for pane and agent state.
- Plugin events are bounded wake-up hints, not a second durable event log.

The migration preserves existing Lark commands, topic and pane bindings, prompt
queues, cards, SQLite state, and operator approval boundaries.

## 2. Architectural Decisions

### 2.1 Production process ownership

On Linux, `systemd --user` is the only supported production process manager.
The plugin manifest does not use a `[[startup]]` command to detach a process.
Plugin actions invoke a thin service adapter which installs, starts, stops,
restarts, and inspects `herdr-lark-bridge.service`.

The application does not read or write PID files and does not know about
systemd. The existing SQLite lease and fencing token remain as protection
against accidental manual or duplicate starts.

Direct foreground execution remains available for development and diagnosis,
but is not a second production deployment mode.

### 2.2 Health and readiness

The endpoints have separate contracts:

- `/health` returns success when the process and its internal event loop can
  serve requests. It does not require Lark or Herdr connectivity.
- `/ready` returns success only when SQLite lease ownership, project paths,
  Herdr access, and Lark connectivity are usable.
- `/status` returns the complete sanitized diagnostic snapshot even when one or
  more dependencies are degraded.

Service startup waits only for `/health`. A failed `/ready` check is reported as
degraded state and never causes the service adapter to terminate an otherwise
healthy bridge.

### 2.3 Plugin event contract

The manifest subscribes only to events that can affect bridge-visible state:

- `pane.agent_status_changed`;
- `pane.agent_detected`;
- `pane.created`;
- `pane.closed`;
- `pane.exited`; and
- `workspace.closed`.

Broad layout-only events such as `tab.moved` and `pane.moved` are excluded.
`workspace.updated` is excluded unless acceptance testing proves a required
state transition is otherwise unavailable.

The event command sends one bounded datagram to a loopback UDP listener owned by
the bridge. The payload contains only the event name, event timestamp, and
bounded identifiers extracted from Herdr's event context. It never contains
terminal output or Lark content.

The hook has a short fixed deadline. If the bridge is stopped or the datagram is
lost, the hook exits without creating durable backlog. Periodic reconciliation
is the recovery mechanism.

### 2.4 Herdr observation

A deep `HerdrObservation` module hides CLI response schemas and compatibility
fallbacks behind a small interface:

```ts
interface HerdrObservation {
  snapshot(scope?: { workspaceIds?: readonly string[] }): Promise<HerdrSnapshot>;
  readOutput(paneId: string, lines: number): Promise<string>;
}
```

The primary adapter parses `herdr api snapshot`, which supplies pane identity,
workspace, current directory, terminal identity, agent kind, agent state, and
state-change sequence in one command. Filtering to configured workspaces occurs
inside the module.

If the installed Herdr version lacks required snapshot fields, the adapter may
fall back to `pane list` and `pane process-info`. This compatibility behavior is
private and observable through structured diagnostics. Callers never decide
which CLI path to use.

Reconciliation reads terminal output only for bound panes or newly discovered
TraeX panes. The last observed `state_change_seq` and terminal identity are used
to skip unchanged panes. A periodic full snapshot remains enabled as protection
against missed event hints.

### 2.5 Herdr command execution

Normal agent operations use Herdr's agent facade:

- start TraeX through `herdr agent start`;
- submit a new turn through `herdr agent prompt`;
- wait for lifecycle changes through Herdr agent state and plugin events; and
- read terminal output through the supported Herdr read interface.

Raw pane text and key injection remain an internal compatibility adapter only
for operations without an equivalent agent command, including active-turn
steering and TraeX-local slash commands. This fallback is explicit in logs and
is not exposed as a separate domain interface.

## 3. Module Shape

```text
Herdr plugin control plane
  manifest
    actions and managed panes
    bounded event hooks
  service adapter
    systemd user unit installation and control
  configuration transaction
    edit, validate, atomic replace

Bridge application
  composition root
  Lark ingress and durable outbox
  session application module
  Herdr observation module
    snapshot parser
    compatibility adapter
    targeted terminal reader
  Herdr command module
    native agent commands
    explicit terminal fallback
  event wake-up receiver
  SQLite state, lease, and fencing
  health and diagnostics
```

The bridge application receives dependencies at its composition root. Runtime
modules do not read plugin paths directly. A bootstrap configuration object
contains the resolved config, state, database, event-listener, and executable
paths.

## 4. Service Installation and Lifecycle

Setup performs the following transaction:

1. Verify Linux, Node.js, Herdr, TraeX, and user-systemd availability.
2. Create private plugin config and state directories.
3. Edit temporary copies of the environment and project registry.
4. Validate both files through application-owned validation code.
5. Atomically replace the canonical files only after validation succeeds.
6. Write the systemd unit atomically with absolute paths.
7. Run `systemctl --user daemon-reload` and enable the unit.
8. Start or restart it and wait for `/health`.
9. Print `/ready` and `/status` diagnostics without treating degradation as a
   process-start failure.

The generated unit includes:

- `Type=simple`;
- an absolute Node executable and application entry point;
- an explicit environment/config path;
- `Restart=on-failure` with a bounded delay;
- a stop timeout compatible with graceful bridge shutdown; and
- journal-backed stdout and stderr.

The routine actions are `setup`, `start`, `stop`, `restart`, `status`, `logs`,
`configure-projects`, and `uninstall-service`. Action identifiers are local to
the plugin namespace and do not repeat the plugin ID. Interactive actions open
manifest-declared panes; non-interactive service controls invoke the adapter
directly.

`uninstall-service` stops, disables, and removes only the generated unit. It
preserves credentials, projects, the SQLite database, and logs. Data purge is
outside this design.

## 5. Configuration and Upgrade Safety

Canonical mutable files remain outside the checkout:

```text
$HERDR_PLUGIN_CONFIG_DIR/.env
$HERDR_PLUGIN_CONFIG_DIR/projects.json
$HERDR_PLUGIN_STATE_DIR/bridge.db
```

Configuration editing always uses temporary files in the destination
filesystem followed by validation and atomic rename. A failed edit leaves the
last working configuration untouched. `.env` is parsed as data and is never
sourced by plugin scripts.

For a linked development checkout, the service may point directly to the built
checkout. Packaged production installation creates immutable release directories
under plugin state and atomically switches a `current` symlink only after build
and verification. The health response includes application version and build
identity so an upgrade can verify that the expected release is running. A failed
cutover restores the previous symlink and service definition.

Release packaging is isolated from the initial runtime migration. The service
and observation seams must not depend on whether code came from a linked checkout
or an immutable packaged release.

## 6. Event and Reconciliation Flow

```text
Herdr event
  -> bounded loopback datagram
  -> merge pane/workspace dirty identifiers
  -> debounce burst
  -> fetch authoritative Herdr snapshot once
  -> compare terminal identity and state_change_seq
  -> read output only where required
  -> emit bridge domain events
  -> update durable views and Lark cards
```

Event hints never mutate bindings directly. Reconciliation owns all decisions
about discovery, orphaning, agent-state changes, queue wake-up, and local output.
This preserves one path for both event-driven and periodic recovery behavior.

The receiver applies fixed limits to datagram size, identifier count, debounce
window, and pending dirty set. Invalid payloads are logged in sanitized form and
cause at most one full reconciliation request.

## 7. Error Handling and Observability

- Missing or invalid configuration prevents the service from becoming healthy
  and names the exact configuration phase without printing values.
- Temporary Lark or Herdr unavailability marks readiness degraded while systemd
  keeps the process alive and applies restart policy only if the process exits.
- UDP notification failure is non-fatal because periodic reconciliation is the
  recovery path.
- Snapshot compatibility fallback records which adapter path was used and why.
- Service status reports unit state, process health, dependency readiness, build
  identity, database lease, snapshot age, last successful reconcile, and bounded
  recent failures.
- Logs remain structured in the Node process and are collected by journald.
  Plugin command logs remain available for action and hook failures.

## 8. Migration

Existing plugin-managed processes are migrated as follows:

1. Wait for no running prompts and an empty Lark outbox.
2. Stop the verified legacy PID-managed process.
3. Preserve the existing plugin config and state directories in place.
4. Install the user unit pointing at the current build.
5. Start it and verify `/health`, build identity, SQLite lease, and `/ready`.
6. Remove stale PID, lifecycle-lock, file-log, and event-inbox artifacts only
   after the systemd service is confirmed healthy.

The migration never copies a live SQLite database and never starts two bridge
instances against the same database intentionally.

## 9. Verification and Acceptance

Automated verification covers:

- manifest action, pane, and narrow event declarations;
- absence of a plugin startup hook;
- systemd unit generation and command delegation;
- atomic configuration success and rollback on validation failure;
- `/health`, `/ready`, and `/status` separation;
- bounded UDP payload parsing, coalescing, and malformed input handling;
- snapshot parsing and compatibility fallback;
- one snapshot command per reconciliation pass rather than per-pane process
  inspection;
- state-change sequence filtering and targeted terminal reads;
- native agent command argument construction;
- explicit raw-terminal fallback behavior;
- graceful SIGTERM shutdown and SQLite lease release; and
- preservation of existing queue, card, binding, and recovery tests.

Repository acceptance runs the full test suite, typecheck, production build,
shell syntax checks, and manifest registration. Native acceptance uses isolated
temporary config/state and a temporary user unit name where possible. It then
checks action invocation, event wake-up, degraded readiness, service restart,
journal output, and clean service removal. Live Lark acceptance remains a
separate real-user smoke test and does not bypass bot filtering or approval
boundaries.

## 10. Explicit Non-Goals

- Redesigning Lark commands, cards, prompt ordering, or topic semantics.
- Moving approval decisions out of Herdr.
- Replacing SQLite or removing the lease and fencing mechanism.
- Making Herdr event payloads authoritative business events.
- Supporting macOS or Windows service managers in this migration.
- Purging user data during plugin or service removal.
- Refactoring unrelated card rendering or store methods solely to reduce file
  size.
