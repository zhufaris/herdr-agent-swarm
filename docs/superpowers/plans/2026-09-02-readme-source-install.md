# README Source Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a fresh internal operator one canonical, executable path for installing Herdr Agent Swarm from source.

**Architecture:** Keep `README.md` as the user-facing entry point and retain the existing standalone section as the detailed operator reference. Add a small Vitest documentation contract that guards the canonical heading, command sequence, readiness check, and safe restart boundary against later drift.

**Tech Stack:** Markdown, Bash command examples, Vitest, Node.js

---

### Task 1: Lock the README installation contract

**Files:**
- Create: `tests/readme-source-install.test.ts`

- [ ] **Step 1: Write the failing documentation test**

Read `README.md` and assert that it contains exactly one `## Install from source` heading, the ordered commands `npm ci`, `npm run build`, `npm run swarm:setup`, `./install.sh`, `npm run swarm:start`, and `npm run swarm:status`, a loopback `/ready` check, the statement that install enables but does not start the unit, and both safe and forced restart commands.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run tests/readme-source-install.test.ts`

Expected: FAIL because `README.md` does not yet contain the canonical heading and complete contract.

- [ ] **Step 3: Commit only after Task 2 makes the test pass**

Do not commit a permanently failing documentation test separately.

### Task 2: Add the canonical source installation guide

**Files:**
- Modify: `README.md`
- Test: `tests/readme-source-install.test.ts`

- [ ] **Step 1: Add `Install from source` after Lark configuration**

Write one ordered first-install flow that covers tool checks, entering the checkout, locked dependency installation, build, Herdr status, guided setup, immutable install, explicit start, status, and `curl -fsS http://127.0.0.1:8787/ready`. State that the expected JSON has `status: ready`.

- [ ] **Step 2: Document state and permissions**

State the default config and state roots, mode `0600` for `.env` and `projects.json`, and that the installer enables but deliberately does not start the unit.

- [ ] **Step 3: Document source upgrades**

Add the sequence `git pull --ff-only` (or switch to the intended commit), `npm ci`, `npm run build`, `./install.sh`, `npm run swarm:status`, and `npm run swarm:restart`. Explain that ordinary restart refuses active work and `npm run swarm:restart -- --force` is only an intentional detached-observer handoff with no prompt replay.

- [ ] **Step 4: Remove duplicate first-install command blocks**

Retain detailed setup, non-interactive configuration, shim, migration, and recovery explanations, but replace repeated default first-install sequences with a reference to `Install from source`.

- [ ] **Step 5: Run the focused test**

Run: `npx vitest run tests/readme-source-install.test.ts`

Expected: PASS.

### Task 3: Cold-read and verify

**Files:**
- Verify: `README.md`
- Verify: `tests/readme-source-install.test.ts`

- [ ] **Step 1: Cold-read the installation path**

Confirm a new operator can identify prerequisites, configuration creation, immutable installation, explicit startup, readiness verification, safe upgrade, and the force boundary without searching another file.

- [ ] **Step 2: Check Markdown and command consistency**

Run `git diff --check`, verify every documented npm script exists in `package.json`, and check that fenced code blocks in the edited section are balanced.

- [ ] **Step 3: Run documentation and architecture tests**

Run: `npx vitest run tests/readme-source-install.test.ts tests/architecture-boundaries.test.ts`

Expected: both files pass.

- [ ] **Step 4: Commit the README guide**

```bash
git add README.md tests/readme-source-install.test.ts
git commit -m "docs: add source installation guide"
```
