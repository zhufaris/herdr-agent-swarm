# Swarm command naming migration

## Goal

Make `swarm` the only active standalone operations and runtime integration
name. Remove the transitional `solo` command surface in one release instead of
maintaining aliases or fallback environment variables.

## Public operations surface

`package.json` exposes only these standalone lifecycle commands:

```text
npm run swarm:init
npm run swarm:install
npm run swarm:start
npm run swarm:status
npm run swarm:restart
npm run swarm:stop
npm run swarm:logs
```

They invoke `scripts/swarm-service.sh`. The old `solo:*` scripts are removed,
not redirected, and do not print compatibility guidance. `install.sh
--standalone` invokes the new script and describes the installed unit as
`herdr-agent-swarm.service`. Configuration and state remain in the existing
canonical `herdr-agent-swarm` directories, so the naming migration does not
move or discard runtime data.

## Runtime integration names

Active internal identifiers also use the product name consistently:

- standalone lifecycle variables become `SWARM_ROOT`, `SWARM_CONFIG_DIR`, and
  `SWARM_STATE_DIR`;
- the Primary capability becomes `SWARM_PRIMARY_CAPABILITY`;
- the injected TraeX MCP server key becomes `herdr_agent_swarm`;
- the MCP server reports the name `herdr-agent-swarm-primary-tools`;
- newly issued approval records use policy version `herdr-agent-swarm-v1`;
- temporary smoke-test and generated Worker branch prefixes use `swarm`.

There are no runtime fallbacks for the old names. Existing approval records
with the old policy version are intentionally no longer reusable; users must
approve a matching high-risk action again. Existing service configuration and
SQLite workflow state remain usable because their paths and schemas do not
change. Existing running agent processes must be restarted so TraeX receives
the new MCP key and capability environment variable.

## Service and file naming

Rename `service/solo-agent.service` to `service/herdr-agent-swarm.service` and
`scripts/solo-agent.sh` to `scripts/swarm-service.sh`. The lifecycle renderer,
tests, documentation, and installation messages refer only to the canonical
service name. Plugin mode remains `herdr-lark-bridge` because it is a distinct
installation surface and is not a `solo` compatibility name.

Historical design, plan, ticket, and audit documents retain their filenames
and historical wording as records of the implementation that existed at that
time. Active code, tests, package commands, scripts, service templates, README,
operator documentation, and current plans must not contain active `solo`
identifiers. Links to historical documents may retain their existing paths.

## Failure handling and deployment

Lifecycle validation continues to reject missing directories, invalid config,
unsafe restart during active turns, and build-identity mismatch exactly as it
does today. The migration adds no fallback lookup because silent use of an old
environment variable would make deployments ambiguous.

Deployment order is build, install the canonical user unit, restart the
service, and verify status. Removing an obsolete user-unit file from a live
machine is an explicit deployment cleanup operation, not a repository install
side effect.

## Verification

- Every `swarm:*` npm command resolves to `scripts/swarm-service.sh`.
- No `solo:*` npm command exists.
- Standalone lifecycle tests render and operate on
  `herdr-agent-swarm.service` using only `SWARM_*` variables.
- Agent-driver tests prove TraeX receives the `herdr_agent_swarm` MCP server and
  `SWARM_PRIMARY_CAPABILITY`.
- Secret redaction covers the new capability name.
- Searches across active source, tests, scripts, service templates, package
  metadata, README, and operator documentation find no active `solo` naming.
- Focused lifecycle, driver, gateway, command-runner, policy, and smoke tests
  pass, followed by typecheck, build, and the full Vitest suite.
