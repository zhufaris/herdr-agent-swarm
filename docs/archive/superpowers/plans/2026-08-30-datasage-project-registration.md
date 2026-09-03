# DataSage Project Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register two existing DataSage Herdr workspaces in the production AgentSwarm project list.

**Architecture:** Extend only the private `projects.json` registry with two unique project routes. Reuse the existing primary/worker instance policy, validate against the production environment, restart the sole supported service, and verify both health and visible project data.

**Tech Stack:** JSON, Node.js configuration validation, Herdr 0.7.5, user systemd, Feishu/Lark CardKit.

**Spec:** `docs/superpowers/specs/2026-08-30-datasage-project-registration-design.md`

## Global Constraints

- Keep `herdr-agent-swarm` as `defaultProjectId`.
- Map semantic knowledge to workspace `w5` and Fabric2OneTable to workspace `wD`.
- Do not commit private production configuration or runtime state.
- Restart only `herdr-agent-swarm.service`; legacy services remain inactive and disabled.

---

### Task 1: Update and validate the private registry

**Files:**
- Modify: `/home/feiyu.zhu/.config/herdr-agent-swarm/projects.json`
- Read: `/home/feiyu.zhu/.config/herdr-agent-swarm/.env`

**Interfaces:**
- Consumes: the project schema loaded by `src/config.ts`.
- Produces: three unique project routes accepted by `npm run config:validate -- <env-file> <projects-file>`.

- [ ] Back up the current registry to a temporary file.
- [ ] Add `datasage-semantic-knowledge` with workspace `w5`, its absolute checkout, and the existing primary/worker instance template.
- [ ] Add `datasage-fabric2onetable` with workspace `wD`, its absolute checkout, and the existing primary/worker instance template.
- [ ] Run `npm run config:validate -- /home/feiyu.zhu/.config/herdr-agent-swarm/.env /home/feiyu.zhu/.config/herdr-agent-swarm/projects.json` and require a successful exit.

### Task 2: Deploy and verify the project list

**Files:**
- Read: `/home/feiyu.zhu/.config/herdr-agent-swarm/projects.json`

**Interfaces:**
- Consumes: the validated production registry.
- Produces: healthy AgentSwarm startup with the two new projects available through project selection.

- [ ] Restart with `bash scripts/swarm-service.sh restart`.
- [ ] Verify `/ready` is `ready`, `/status` is `ok`, and the running build identity is unchanged.
- [ ] Verify the private registry contains exactly the intended three IDs and default project.
- [ ] Verify `herdr-agent-swarm.service` is active/enabled and both legacy services are inactive/disabled.
- [ ] If any deployment check fails, restore the temporary backup, restart AgentSwarm, and repeat health verification.
