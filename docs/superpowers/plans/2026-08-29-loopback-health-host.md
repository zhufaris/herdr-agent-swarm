# Loopback Health Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the documented loopback-only health server boundary at configuration load time.

**Architecture:** Narrow the existing Zod field for `BRIDGE_HTTP_HOST` to three explicit loopback spellings. Keep the health server and returned config shape unchanged.

**Tech Stack:** TypeScript, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-08-29-loopback-health-host-design.md`

## Global Constraints

- Accept exactly `127.0.0.1`, `localhost`, and `::1`.
- Keep `127.0.0.1` as the default.
- Reject wildcard and non-loopback hosts before server startup.
- Do not add a public-listener override in this change.

---

### Task 1: Validate the Health Host Boundary

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

**Interfaces:**
- Consumes: `loadConfig(environment?: NodeJS.ProcessEnv)`.
- Produces: unchanged `config.http.host`, now validated as an explicit loopback host.

- [ ] **Step 1: Write failing loopback validation tests**

Assert that `127.0.0.1`, `localhost`, and `::1` load successfully. Assert that
`0.0.0.0`, `::`, `192.168.1.10`, and `bridge.internal` throw a Zod validation
error mentioning `BRIDGE_HTTP_HOST`.

- [ ] **Step 2: Run the focused test and observe failure**

Run: `npx vitest run tests/config.test.ts -t "restricts the health server to loopback hosts"`

Expected: FAIL because arbitrary non-empty hosts are currently accepted.

- [ ] **Step 3: Implement the schema restriction**

Replace `z.string().min(1)` with `z.enum(["127.0.0.1", "localhost", "::1"])`, preserving the existing default.

- [ ] **Step 4: Verify and commit**

Run `npx vitest run tests/config.test.ts`, `npm run typecheck`, `npm test`,
`npm run build`, and `git diff --check -- src/config.ts tests/config.test.ts`.
Then commit only the two implementation files as
`fix: enforce loopback health binding`.
