# Native Herdr Plugin Migration Implementation Plan

## Objective

Implement the approved design in
`docs/superpowers/specs/2026-08-23-native-herdr-plugin-migration-design.md`.
Make Herdr the installation and operations entry point, use a user-level
systemd unit for the persistent Node.js bridge, move production state into the
Herdr plugin config directory, and remove PM2 without changing bridge domain
behavior.

## Task 1: Add application-owned configuration validation

Refactor configuration parsing only as needed to expose a side-effect-free
validation command. Add `src/cli/validate-config.ts` and package scripts that
load an environment file supplied by the plugin scripts, parse the existing
project registry through `loadConfig`, validate project directories, and exit
with concise diagnostics without opening SQLite, Lark, Herdr, or HTTP services.
Add focused tests for plugin-owned absolute paths and validation failures.

## Task 2: Add the Herdr plugin manifest and launchers

Create `herdr-plugin.toml` for Linux and the then-supported Herdr release+. Declare the build step,
service-control actions, and managed setup/status/logs/project-configuration
panes. Add a shared shell library that resolves and validates
`HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, binaries, config files, and
service paths without relying on the action working directory. Add a generic
pane-opening action wrapper patterned after native Herdr plugins.

## Task 3: Implement safe build, setup, and configuration flows

Add a build script that validates Node/npm, runs `npm ci` and the production
build, and checks the compiled entry point. Implement interactive setup with
secret-safe prompts, atomic `bridge.env` writes, restrictive permissions,
project registry creation/preservation, optional explicit legacy import, and
application-owned validation before any service restart. Implement project
editing through a temporary file with `$EDITOR`/`vim`, validation, atomic
replacement, and restart only on success.

## Task 4: Implement systemd lifecycle and diagnostics

Add an input-safe unit renderer and service controller for install/start, stop,
restart, and uninstall-service. Render absolute Node, plugin root, config, and
database paths; enable journal logging, restart-on-failure, and graceful stop.
Add bounded status checks for config permissions, systemd state, `/health`,
`/ready`, and `/status`, plus a logs pane scoped to the unit. Preserve all
configuration and SQLite files when removing the service.

## Task 5: Remove PM2 and update operational documentation

Delete `ecosystem.config.cjs`. Rewrite README installation, configuration,
startup, upgrade, status, logs, and troubleshooting instructions around
`herdr plugin install/link` and plugin actions. Keep direct npm commands only as
developer workflows. Update `.env.example` to make repository-relative values
explicitly development-only and document canonical plugin-owned paths.

## Task 6: Add automated plugin lifecycle coverage

Add shell integration tests using temporary plugin/config/systemd directories
and fake `systemctl`, `journalctl`, `herdr`, and health endpoints as appropriate.
Cover manifest/action wiring, unit rendering, idempotent service operations,
config validation, secret permissions, project-edit rollback, stopped/unhealthy
status, and service removal preserving data. Keep tests hermetic: do not touch
the real user service, plugin registry, Lark credentials, or production SQLite.

## Task 7: Verify and perform local plugin acceptance

Run shell syntax checks, focused config/plugin tests, the full Vitest suite,
typecheck, production build, and `git diff --check`. Then link this worktree with
`herdr plugin link <worktree> --enabled`, verify every action is discoverable,
and exercise only non-destructive/status paths with isolated configuration. Do
not replace or stop any existing bridge service without explicit confirmation.
Record any real Lark credential smoke test as a separate manual acceptance step.
