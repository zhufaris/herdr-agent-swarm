# DataSage Project Registration Design

## Goal

Expose `datasage_semantic_knowledge` and `datasage_fabric2onetable` in the AgentSwarm Feishu project list without changing the default project or adding another service.

## Project mappings

The production project registry gains these routes:

| Project ID | Display name | Herdr workspace | Checkout |
| --- | --- | --- | --- |
| `datasage-semantic-knowledge` | DataSage Semantic Knowledge | `w5` | `/path/to/example-project` |
| `datasage-fabric2onetable` | DataSage Fabric2OneTable | `wD` | `/path/to/example-fabric-project` |

Both directories and workspace mappings were observed on the target host before configuration. The existing `herdr-agent-swarm` project remains the `defaultProjectId`.

## Instance policy

Each DataSage project uses the same bounded instance template as the existing AgentSwarm project:

- one `primary` TraeX instance on the main checkout;
- optional `worker` TraeX instances backed by Git worktrees from `HEAD`;
- `maxInstances` remains `8` per project.

This keeps project behavior consistent and allows isolated worker tasks without sharing a mutable checkout.

## Deployment and safety

The change applies only to the private production registry at `/home/your-user/.config/herdr-agent-swarm/projects.json`. No credentials, runtime database, or generated state enter Git. Before restart, validate the environment and registry with the repository's `config:validate` command.

Restart only `herdr-agent-swarm.service`. The obsolete `herdr-agent-swarm-multiproject.service` and `herdr-lark-bridge.service` remain inactive and disabled. If validation or readiness fails, restore the previous registry and restart the same service; no prompt is replayed.

## Acceptance criteria

- Configuration validation accepts all three unique project IDs, workspace IDs, and checkout paths.
- `herdr-agent-swarm` remains the default project.
- The service restarts with `/ready` reporting `ready` and `/status` reporting `ok`.
- The Feishu project list contains both new DataSage projects.
- Existing bindings, SQLite state, and the two disabled legacy services are unchanged.
