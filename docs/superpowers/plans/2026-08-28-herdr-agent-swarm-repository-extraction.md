# Herdr Agent Swarm Repository Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `/data00/home/feiyu.zhu/work/herdr-agent-swarm` as an independent, history-preserving repository whose active product and standalone service identity is Herdr Agent Swarm.

**Architecture:** Clone the completed `solo-app` branch into a normal repository, remove its generated remote, and rename the branch to `main`. Apply a compatibility-aware rename only to current product/package/standalone surfaces, retaining `/swarm`, durable identifiers, historical documents, and the legacy plugin ID.

**Tech Stack:** Git, Node.js 22.5+, npm, TypeScript, Vitest, systemd user units, Herdr, TraeX

**Spec:** `docs/superpowers/specs/2026-08-28-herdr-agent-swarm-repository-extraction-design.md`

## Global Constraints

- Preserve the complete reachable Git history and the source `solo-app` head.
- Destination path is exactly `/data00/home/feiyu.zhu/work/herdr-agent-swarm`.
- Destination branch is `main` and `git remote -v` must be empty.
- Do not copy private configuration, credentials, databases, WAL/SHM files, logs, generated runtime state, `node_modules`, or tracked `dist`.
- Keep `/swarm`, durable compatibility identifiers, and the legacy Herdr plugin ID unchanged.
- Do not create a hosted remote, push, restart, or migrate an installed service.

---

### Task 1: Create the independent history-preserving repository

**Files:**
- Create repository: `/data00/home/feiyu.zhu/work/herdr-agent-swarm`

**Interfaces:**
- Consumes: source branch `solo-app` at the commit containing this plan.
- Produces: independent Git repository on branch `main`, with no configured remotes.

- [ ] **Step 1: Assert the destination does not exist and source is clean**

Run `test ! -e /data00/home/feiyu.zhu/work/herdr-agent-swarm && git status --short`.
Expected: destination assertion succeeds and source status is empty.

- [ ] **Step 2: Clone the selected branch with history**

Run `git clone --branch solo-app --single-branch /data00/home/feiyu.zhu/work/herdr-lark-bridge /data00/home/feiyu.zhu/work/herdr-agent-swarm`.
Expected: clone succeeds and destination HEAD equals source `solo-app` HEAD.

- [ ] **Step 3: Detach repository ownership**

In the destination, run `git remote remove origin` and `git branch -m main`.
Expected: `git remote -v` is empty and `git branch --show-current` prints `main`.

### Task 2: Rename active standalone product surfaces

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/solo-agent.sh`
- Modify: `service/solo-agent.service`
- Modify: `src/cli/plugin-lifecycle.ts`
- Modify: `.env.example`
- Test: `tests/plugin-lifecycle.test.ts`

**Interfaces:**
- Consumes: current lifecycle environment variables and compatibility plugin ID.
- Produces: package `herdr-agent-swarm`, default service `herdr-agent-swarm.service`, and default XDG directories named `herdr-agent-swarm`.

- [ ] **Step 1: Update lifecycle expectations in tests**

Change standalone expectations from `solo-agent.service`, `.config/solo-agent`, and `.local/state/solo-agent` to their `herdr-agent-swarm` equivalents. Keep plugin-mode expectations unchanged.

- [ ] **Step 2: Run the focused test and observe the old defaults fail**

Run `npx vitest run tests/plugin-lifecycle.test.ts`.
Expected: standalone naming assertions fail before implementation.

- [ ] **Step 3: Update package and standalone lifecycle identity**

Set the npm package name in both package manifests. Update the standalone shell defaults, rendered unit description, checked-in service template, and active `.env.example` comments. Do not rename npm script commands in this extraction.

- [ ] **Step 4: Run focused lifecycle tests**

Run `npx vitest run tests/plugin-lifecycle.test.ts`.
Expected: all lifecycle tests pass.

- [ ] **Step 5: Commit the standalone identity change**

Commit as `refactor: rename standalone product to herdr agent swarm`.

### Task 3: Update active product documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/feishu-group-usage.md`
- Modify: `config/projects.example.json`

**Interfaces:**
- Consumes: new package, service, and XDG path defaults from Task 2.
- Produces: installation and operation documentation for Herdr Agent Swarm while retaining compatibility commands and historical records.

- [ ] **Step 1: Rename active product prose and examples**

Use `Herdr Agent Swarm` for the active product, update standalone paths/service examples, and make the example Primary and Worker both use TraeX. Preserve `/swarm` commands and label the old plugin ID as compatibility-only.

- [ ] **Step 2: Audit remaining old names**

Run scoped `rg` searches over active docs and operational files. Classify remaining matches as compatibility identifiers, historical references, or errors; fix only errors.

- [ ] **Step 3: Check Markdown and patch whitespace**

Run `git diff --check`.
Expected: exit code 0.

- [ ] **Step 4: Commit documentation changes**

Commit as `docs: document herdr agent swarm`.

### Task 4: Verify repository integrity and ship the extraction

**Files:**
- Modify: `docs/superpowers/plans/2026-08-28-herdr-agent-swarm-repository-extraction.md`

**Interfaces:**
- Consumes: Tasks 1-3 repository and naming changes.
- Produces: a clean local repository with recorded verification evidence.

- [ ] **Step 1: Install locked dependencies**

Run `npm ci`.
Expected: dependency installation succeeds without changing tracked manifests.

- [ ] **Step 2: Run complete automated verification**

Run `npm test`, `npm run typecheck`, and `npm run build`.
Expected: all tests pass, typecheck exits 0, and the production build emits a build identity.

- [ ] **Step 3: Validate sanitized configuration**

Create temporary `.env` and project registry files from examples using a real accessible project directory and Herdr workspace ID, then run `npm run config:validate -- <env> <projects>`. Remove only those temporary files afterward.
Expected: validation reports `status=valid`.

- [ ] **Step 4: Audit Git history, ownership, and tracked artifacts**

Verify destination HEAD ancestry contains the source extraction commits, branch is `main`, remotes are empty, ignored build/dependency directories are untracked, and `git ls-files` finds no `.env`, live `projects.json`, SQLite/WAL/SHM, or log artifacts.

- [ ] **Step 5: Record verification and commit**

Mark this plan complete with exact test/build evidence, run `git diff --check`, and commit as `docs: complete repository extraction`.

- [ ] **Step 6: Confirm final clean state**

Run `git status --short`, `git branch --show-current`, `git remote -v`, and `git log -5 --oneline`.
Expected: clean status, branch `main`, no remotes, and extraction commits at HEAD.
