# Herdr Agent Swarm Repository Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an independent, history-preserving repository whose active product and standalone service identity is Herdr Agent Swarm.

**Architecture:** Clone the completed `solo-app` branch into a normal repository, remove its generated remote, and rename the branch to `main`. Apply a compatibility-aware rename only to current product/package/standalone surfaces, retaining `/swarm`, durable identifiers, historical documents, and the legacy plugin ID.

**Tech Stack:** Git, Node.js 22.5+, npm, TypeScript, Vitest, systemd user units, Herdr, TraeX

**Spec:** `docs/superpowers/specs/2026-08-28-herdr-agent-swarm-repository-extraction-design.md`

## Global Constraints

- Preserve the complete reachable Git history and the source `solo-app` head.
- Destination path is the selected standalone repository checkout.
- Destination branch is `main` and `git remote -v` must be empty.
- Do not copy private configuration, credentials, databases, WAL/SHM files, logs, generated runtime state, `node_modules`, or tracked `dist`.
- Keep `/swarm`, durable compatibility identifiers, and the legacy Herdr plugin ID unchanged.
- Do not create a hosted remote, push, restart, or migrate an installed service.

---

### Task 1: Create the independent history-preserving repository

**Files:**
- Create the standalone repository checkout.

**Interfaces:**
- Consumes: source branch `solo-app` at the commit containing this plan.
- Produces: independent Git repository on branch `main`, with no configured remotes.

- [x] **Step 1: Assert the destination does not exist and source is clean**

Run `git status --short` in the new checkout.
Expected: destination assertion succeeds and source status is empty.

- [x] **Step 2: Clone the selected branch with history**

Clone the source repository's standalone branch into the selected checkout.
Expected: clone succeeds and destination HEAD equals source `solo-app` HEAD.

- [x] **Step 3: Detach repository ownership**

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

- [x] **Step 1: Update lifecycle expectations in tests**

Change standalone expectations from `solo-agent.service`, `.config/solo-agent`, and `.local/state/solo-agent` to their `herdr-agent-swarm` equivalents. Keep plugin-mode expectations unchanged.

- [x] **Step 2: Run the focused test and observe the old defaults fail**

Run `npx vitest run tests/plugin-lifecycle.test.ts`.
Expected: standalone naming assertions fail before implementation.

- [x] **Step 3: Update package and standalone lifecycle identity**

Set the npm package name in both package manifests. Update the standalone shell defaults, rendered unit description, checked-in service template, and active `.env.example` comments. Do not rename npm script commands in this extraction.

- [x] **Step 4: Run focused lifecycle tests**

Run `npx vitest run tests/plugin-lifecycle.test.ts`.
Expected: all lifecycle tests pass.

- [x] **Step 5: Commit the standalone identity change**

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

- [x] **Step 1: Rename active product prose and examples**

Use `Herdr Agent Swarm` for the active product, update standalone paths/service examples, and make the example Primary and Worker both use TraeX. Preserve `/swarm` commands and label the old plugin ID as compatibility-only.

- [x] **Step 2: Audit remaining old names**

Run scoped `rg` searches over active docs and operational files. Classify remaining matches as compatibility identifiers, historical references, or errors; fix only errors.

- [x] **Step 3: Check Markdown and patch whitespace**

Run `git diff --check`.
Expected: exit code 0.

- [x] **Step 4: Commit documentation changes**

Commit as `docs: document herdr agent swarm`.

### Task 4: Verify repository integrity and ship the extraction

**Files:**
- Modify: `docs/superpowers/plans/2026-08-28-herdr-agent-swarm-repository-extraction.md`

**Interfaces:**
- Consumes: Tasks 1-3 repository and naming changes.
- Produces: a clean local repository with recorded verification evidence.

- [x] **Step 1: Install locked dependencies**

Run `npm ci`.
Expected: dependency installation succeeds without changing tracked manifests.

- [x] **Step 2: Run complete automated verification**

Run `npm test`, `npm run typecheck`, and `npm run build`.
Expected: all tests pass, typecheck exits 0, and the production build emits a build identity.

- [x] **Step 3: Validate sanitized configuration**

Create temporary `.env` and project registry files from examples using a real accessible project directory and Herdr workspace ID, then run `npm run config:validate -- <env> <projects>`. Remove only those temporary files afterward.
Expected: validation reports `status=valid`.

- [x] **Step 4: Audit Git history, ownership, and tracked artifacts**

Verify destination HEAD ancestry contains the source extraction commits, branch is `main`, remotes are empty, ignored build/dependency directories are untracked, and `git ls-files` finds no `.env`, live `projects.json`, SQLite/WAL/SHM, or log artifacts.

- [x] **Step 5: Record verification and commit**

Mark this plan complete with exact test/build evidence, run `git diff --check`, and commit as `docs: complete repository extraction`.

- [x] **Step 6: Confirm final clean state**

Run `git status --short`, `git branch --show-current`, `git remote -v`, and `git log -5 --oneline`.
Expected: clean status, branch `main`, no remotes, and extraction commits at HEAD.

## Verification record

- Locked dependency install: 117 packages installed; npm audit reported 0 vulnerabilities.
- Focused lifecycle test: 12 of 12 tests passed after the expected pre-change failure.
- Complete suite: 84 test files and 874 tests passed.
- TypeScript typecheck: passed.
- Production build: passed with build ID `sha256:a28349f238f4772e833cb6aa2b833251a95945975dec5e1f2338adf828572f7c`.
- Sanitized config: `status=valid`, one project, one workspace, loopback `127.0.0.1:8787`.
- Repository audit: branch `main`, no remotes, source commit `be1a71b` is an ancestor, and no live secret/runtime artifact is tracked. `.env.example` is the only environment-name match and is intentionally sanitized.
