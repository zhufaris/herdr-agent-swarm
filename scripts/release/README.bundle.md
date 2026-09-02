# Herdr Agent Swarm Private Offline Bundle

This private Linux x86-64 archive contains Herdr 0.7.5 and the compiled Herdr
Agent Swarm runtime. It does not contain Node.js, TraeX, credentials, project
configuration, databases, logs, sessions, or optional Worker runtimes.

The target requires Node.js 22.12 or newer, TraeX, and a working user-systemd
session. Codex, Claude Code, and Pi are optional Worker runtimes. npm and
network access are not required on the target.

## Verify and install

Verify the adjacent archive checksum before extraction:

```bash
sha256sum -c herdr-agent-swarm-<version>-linux-x64.tar.gz.sha256
tar -xzf herdr-agent-swarm-<version>-linux-x64.tar.gz
cd herdr-agent-swarm-<version>-linux-x64
./scripts/swarmctl verify
./scripts/swarmctl install
```

`install` copies the verified payload beneath
`${XDG_STATE_HOME:-$HOME/.local/state}/herdr-agent-swarm/releases`, atomically
updates `current`, initializes missing private configuration, and enables two
user units. `herdr-headless.service` runs `bin/herdr-real server` directly;
`herdr-agent-swarm.service` requires and starts after it. Installation
deliberately does not start either service. Existing configuration, SQLite
state, logs, Herdr configuration, and older releases are preserved.

## Configure and start

Edit the mode-`0600` `.env` and `projects.json` files under
`${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm`. Replace all Lark,
workspace, and project-path placeholders, and keep the HTTP host loopback-only.

`HERDR_BIN` in `.env` is the command used by Swarm inside managed panes. For
TraeX it may point to a separately generated shim whose `realHerdr` is the
immutable installed `bin/herdr-real`. The headless unit never uses that shim and
always invokes the original binary directly.

```bash
./scripts/swarmctl start
./scripts/swarmctl status
```

## Operate

```bash
./scripts/swarmctl logs
./scripts/swarmctl logs herdr
./scripts/swarmctl logs swarm
./scripts/swarmctl restart
./scripts/swarmctl stop
```

An ordinary restart refuses active prompts, instance work, delivery work, or an
uncertain ownership state. Only use `./scripts/swarmctl restart --force` for an
intentional observer handoff. Force detaches observers and recovers durable work
without replaying prompts; it does not bypass build ownership or database
integrity checks. Logs return at most the final 100 lines and 1 MiB.

## Upgrade and rollback

Extract and verify the new archive, then run its installer. A stopped deployment
is staged and selected without being started. A running deployment uses the same
safe restart gate and verifies the replacement identity/readiness. A failed
handover restores the previous `current` link and unit files, then attempts to
restore the prior service.

```bash
./scripts/swarmctl install
# Only for an intentional detached-observer handoff:
./scripts/swarmctl install --force
```

## Uninstall

```bash
./scripts/swarmctl stop
./scripts/swarmctl uninstall
```

The default removes only package-owned units and preserves configuration,
SQLite/WAL/SHM state, logs, Herdr configuration, sessions, and releases. The
explicit `./scripts/swarmctl uninstall --purge-releases` additionally removes
only the package-owned immutable releases.
