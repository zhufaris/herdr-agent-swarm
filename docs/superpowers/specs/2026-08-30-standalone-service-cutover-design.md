# Standalone Agent Swarm Service Cutover Design

## Goal

Make `herdr-agent-swarm.service` the only production user service for this
repository. The running service, configuration, state ownership, lifecycle
commands, and automatic startup must no longer depend on the compatibility
`herdr-lark-bridge.service` unit or the old repository checkout.

The cutover preserves all durable Lark bindings, prompts, cards, outbox state,
leases, and audit history. It must never run two bridge processes against the
same SQLite database and must never replay a prompt that may already have
reached TraeX.

## Current State

The application code and generated entrypoint already live in this repository.
The repository also already exposes standalone `swarm:*` lifecycle commands and
renders `herdr-agent-swarm.service` when `SWARM_ROOT` is set.

Production currently runs through the compatibility unit
`herdr-lark-bridge.service`. That unit points at this repository's
`dist/main.js`, but it obtains configuration from the compatibility plugin
directory and uses an explicit database path under the old repository. Starting
the unit does not currently enable it, so it is not restored automatically by
the user systemd manager.

## Chosen Design

### Canonical ownership

The standalone service owns these paths:

- unit: `herdr-agent-swarm.service`;
- configuration: `${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm`;
- state: `${XDG_STATE_HOME:-$HOME/.local/state}/herdr-agent-swarm`;
- executable: this repository's generated `dist/main.js`;
- operator surface: `npm run swarm:<action>` and
  `scripts/swarm-service.sh`.

The Herdr compatibility plugin may remain installed temporarily, but its service
actions are no longer the production operator surface. The old service is
disabled after successful cutover. It is not deleted during this migration so a
bounded rollback remains possible.

### Configuration migration

Migration creates the standalone configuration directory with mode `0700` and
copies the existing `.env` and `projects.json` with mode `0600`. Secret values
must never be printed. Existing explicit values remain authoritative.

The first standalone release continues to use the existing absolute
`BRIDGE_DATABASE_PATH`. This is deliberate: copying or moving a live SQLite
database without its WAL and SHM companions is unsafe, and changing service
identity does not require changing database identity. Moving the database into
the standalone state directory is a separate offline maintenance operation, not
part of this cutover.

The migrated `.env` is validated with the standalone `projects.json` before any
service is stopped. The configured port must remain the current production port
so status probes prove which unit owns the live endpoint.

### Lifecycle semantics

`swarm:install` writes the standalone unit, reloads systemd, and enables it. It
does not start a second process while the compatibility service is active.

`swarm:start` refreshes the unit from the current generated build, executes
`systemctl --user enable --now herdr-agent-swarm.service`, and waits for two
consecutive `/status` observations with all of the following:

- the managed unit is active;
- `identity.serviceId` and `identity.buildId` match the generated build;
- `startupRecovery.state` is `completed`;
- `/ready` reports `ready`.

Unlike restart, start has no active-turn interruption semantics: cutover code
must prove the compatibility service has zero running prompts, zero active turn
workers, zero active or uncertain instance turns, and a drained outbox before it
stops that service. No `--force` path is used for normal migration.

`swarm:stop` stops the process but intentionally leaves the unit enabled.
`swarm:uninstall` remains the explicit operation that disables and removes the
standalone unit.

### Atomic cutover workflow

The migration command performs these ordered phases:

1. Build and validate the current repository.
2. Create and validate standalone configuration without changing either service.
3. Inspect the compatibility service `/status` and reject cutover while prompts,
   workers, instance turns, uncertainty, or pending outbox work exist.
4. Record the compatibility unit's active/enabled state for rollback.
5. Stop the compatibility service and confirm the production port is no longer
   serving it.
6. Install, enable, and start `herdr-agent-swarm.service`.
7. Require matching build identity, completed startup recovery, ready
   dependencies, a healthy SQLite quick check, and a held lease.
8. Disable the compatibility unit without deleting its unit, configuration, or
   state.
9. Report the canonical service name, build identity, readiness, configuration
   directory, and database path without exposing secrets.

SQLite's fenced instance lease is an additional safety net, not a substitute
for the explicit stop-before-start ordering.

### Failure and rollback

Failure before the old service is stopped changes no running state.

If standalone startup or verification fails after the old service is stopped,
the migration stops the standalone unit, confirms it is inactive, restores the
old unit's previous enabled state, starts the old unit when it was previously
active, and verifies its original endpoint identity. The command then exits
non-zero with a bounded diagnostic. It does not edit SQLite, replay prompts, or
delete either unit.

If rollback cannot be verified, both units remain stopped rather than risking
dual ownership, and the command reports the exact manual recovery commands.

Repeated migration is idempotent. If the standalone unit already owns the live
endpoint with the expected build and the compatibility unit is inactive, the
command only ensures the standalone unit is enabled and returns success.

## Implementation Boundaries

The existing lifecycle module remains the single unit renderer and startup
verifier. The implementation should add only the lifecycle operations needed to
make standalone start use `enable --now` and introduce a focused migration
orchestrator for compatibility-to-standalone cutover. It must not duplicate the
health, build-identity, or restart-safety rules in shell.

Expected change areas are:

- `src/cli/plugin-lifecycle.ts` for standalone start/stop enablement semantics;
- `scripts/swarm-service.sh` and package scripts for the migration command;
- a focused TypeScript cutover module for configuration and service handoff;
- `tests/plugin-lifecycle.test.ts` plus focused cutover tests;
- `README.md` and `docs/architecture.md` for the canonical operator surface.

The Lark transport, prompt FIFO, transcript selection, SQLite schema, CardKit
rendering, and Herdr reconciliation behavior do not change.

## Security and Durability

- Never log or emit `.env` contents.
- Do not copy a live SQLite database or omit WAL/SHM companions.
- Preserve the existing absolute database path during this cutover.
- Never start the new service until the old service is confirmed inactive.
- Never infer safety only from an idle pane; use durable prompt/outbox state and
  active worker metrics.
- Never use forced restart as part of normal cutover.
- Preserve the old unit and configuration until standalone verification passes.

## Verification

Automated verification covers:

- standalone start delegates to `enable --now`;
- standalone stop does not disable the unit;
- plugin compatibility lifecycle behavior remains unchanged;
- migration refuses active prompt, worker, instance-turn, uncertainty, or
  pending-outbox state;
- migration never overlaps the two services;
- failed startup rolls back to the previously active compatibility service;
- repeated migration is idempotent;
- configuration migration preserves private modes and explicit database path.

Repository verification is `npx vitest run` for focused lifecycle/cutover tests,
`npm run typecheck`, `npm run build`, and `npm test` because the change spans
shared lifecycle and production startup behavior.

Live acceptance requires all of the following:

- `herdr-agent-swarm.service` is active and enabled;
- `herdr-lark-bridge.service` is inactive and disabled;
- `/status` reports the expected generated build and completed startup recovery;
- `/ready` is `ready`, including database, projects, Herdr, Lark, lease, and
  instance runtime;
- SQLite quick check is healthy;
- no prompt or outbox item was replayed during cutover;
- a new Feishu prompt resolves the pane's canonical Herdr session UUID to one
  matching JSONL and delivers typed output.

## Non-goals

- Removing the compatibility plugin files or historical service unit.
- Moving the live SQLite database to a new filesystem path.
- Changing Lark credentials, project routes, port, or prompt behavior.
- Rebinding existing topics or restarting TraeX panes.
- Supporting non-systemd service managers.
