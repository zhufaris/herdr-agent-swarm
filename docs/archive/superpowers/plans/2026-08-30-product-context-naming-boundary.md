# Product Context Naming Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make active agent-facing and user-facing documentation identify this repository as Herdr Agent Swarm while preserving every compatibility identifier required by installed bridge deployments.

**Architecture:** Treat human-readable product identity and stable compatibility identifiers as separate namespaces. Update only active prose that currently presents `Herdr Lark Bridge` as the product; retain literal plugin, service, path, build identity, socket request, and archived-history references.

**Tech Stack:** Markdown, ripgrep, Git

**Spec:** `docs/superpowers/specs/2026-08-30-product-context-naming-boundary-design.md`

## Global Constraints

- Use **Herdr Agent Swarm** for the repository, standalone service, current architecture, multi-agent product, and agent-facing project identity.
- Use **Herdr Lark Bridge** only for compatibility bridge mode or historical design.
- Preserve every literal `herdr-lark-bridge` plugin, systemd unit, configuration/state path, stable service identity, command target, and protocol/request identifier.
- Do not modify files under `docs/archive/`.
- Do not change runtime behavior, configuration, routing, prompts, CardKit, SQLite, or instance handling.
- Do not include the separately tracked Feishu `创建实例` callback failure.
- Preserve unrelated working-tree changes and stage only files owned by each task.

---

### Task 1: Correct the agent-facing repository identity

**Files:**
- Modify: `AGENTS.md:1-23`

**Interfaces:**
- Consumes: the naming rule from the approved spec.
- Produces: the repository instructions loaded by agents, with Herdr Agent Swarm as the current product and the single-topic bridge described as compatibility behavior.

- [ ] **Step 1: Capture the current misleading identity as a red check**

Run:

```bash
sed -n '1,25p' AGENTS.md | rg -n '^# Herdr Lark Bridge: Agent Guide$|^Herdr Lark Bridge connects one Lark topic'
```

Expected before the edit: two matches. These exact phrases incorrectly frame the current repository as the legacy bridge.

- [ ] **Step 2: Rewrite the title and overview**

Replace the title with:

```markdown
# Herdr Agent Swarm: Agent Guide
```

Replace the opening paragraph with prose that states all of the following explicitly:

```markdown
Herdr Agent Swarm is a durable, human-controlled multi-agent workflow
coordinator. It manages project-scoped Primary and Worker instances in real
Herdr panes and projects their work into Lark CardKit cards through a retryable
outbox. The original one-topic/one-TraeX Herdr Lark Bridge remains available as
a compatibility workflow; it is not the identity of this repository.
```

Keep the source-of-truth list and invariants unchanged. Do not replace operational command arguments containing `--plugin herdr-lark-bridge`.

- [ ] **Step 3: Label compatibility plugin commands without renaming them**

In the build-and-operations table, change only the human-readable purpose labels for plugin setup, restart, status, and logs so they say `compatibility Herdr plugin`. Keep the command strings byte-for-byte unchanged.

- [ ] **Step 4: Verify the agent-facing identity and compatibility literals**

Run:

```bash
rg -n '^# Herdr Agent Swarm: Agent Guide$|compatibility workflow|compatibility Herdr plugin' AGENTS.md
rg -n -- '--plugin herdr-lark-bridge' AGENTS.md
! sed -n '1,25p' AGENTS.md | rg -q '^Herdr Lark Bridge connects one Lark topic'
```

Expected: the new title and compatibility wording are present, all three plugin commands still target `herdr-lark-bridge`, and the obsolete opening sentence is absent.

- [ ] **Step 5: Commit the isolated agent-context change**

```bash
git add AGENTS.md
git diff --cached --check
git commit -m "docs: identify agent swarm in repository guidance"
```

### Task 2: Correct active architecture and usage introductions

**Files:**
- Modify: `docs/architecture-reference.md:1-20`
- Modify: `docs/feishu-group-usage.md:1-8`

**Interfaces:**
- Consumes: the product identity established in Task 1.
- Produces: active maintainer and user documentation that distinguishes the current multi-agent product from its compatibility bridge workflow.

- [ ] **Step 1: Capture the remaining misleading active prose**

Run:

```bash
rg -n '^# Herdr Lark Bridge 架构参考$|面向第一次维护 Herdr Lark Bridge|^Herdr Lark Bridge 不是消息转发器' docs/architecture-reference.md
```

Expected before the edit: three matches.

- [ ] **Step 2: Rewrite the architecture reference identity**

Use `Herdr Agent Swarm` in the title and maintainer introduction. Start section 1 with this distinction:

```markdown
Herdr Agent Swarm 不是简单的消息转发器，而是一个持久化、多项目、多 Agent
工作流协调器。它管理项目级 Primary 和 Worker 实例。原有的一话题一 TraeX
Herdr Lark Bridge 是兼容工作流：它把 Lark 话题绑定到真实 Herdr Pane 中的
TraeX 进程，同时保留 Herdr 作为本地观察、接管和高风险审批入口。
```

Keep the authority model, flow diagram, invariants, and module descriptions unchanged.

- [ ] **Step 3: Clarify the user guide compatibility sentence**

Replace the opening compatibility wording in `docs/feishu-group-usage.md` with:

```markdown
兼容的一话题一 TraeX 工作流仍以 Herdr Lark Bridge 模式提供，可将飞书话题
绑定到 Herdr pane 中运行的 TraeX；该名称不代表当前多 Agent 产品或项目。
```

Do not change command examples or behavior descriptions.

- [ ] **Step 4: Audit active prose and protected identifiers**

Run:

```bash
rg -n "Herdr Lark Bridge|herdr-lark-bridge" AGENTS.md README.md docs/architecture.md docs/architecture-reference.md docs/feishu-group-usage.md package.json src plugin config -g '!dist/**'
git diff -- src package.json plugin config
git diff -- docs/archive
```

Expected:

- prose occurrences of `Herdr Lark Bridge` in the edited active documents are explicitly compatibility-scoped;
- README occurrences remain attached to compatibility setup, plugin, service, or migration instructions;
- runtime/configuration files and `docs/archive/` have no diff.

- [ ] **Step 5: Verify documentation quality**

Run:

```bash
rg -n "TBD|TODO|implement later|fill in details" AGENTS.md docs/architecture-reference.md docs/feishu-group-usage.md
git diff --check -- AGENTS.md docs/architecture-reference.md docs/feishu-group-usage.md
```

Expected: the placeholder search returns no newly introduced matches and `git diff --check` exits zero. No build or service restart is required because this task changes Markdown only.

- [ ] **Step 6: Commit the active-documentation change**

```bash
git add docs/architecture-reference.md docs/feishu-group-usage.md
git diff --cached --check
git commit -m "docs: clarify bridge compatibility naming"
```
