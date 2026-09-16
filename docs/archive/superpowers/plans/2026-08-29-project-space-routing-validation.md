# Project Space Routing Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute inline; do not delegate this bounded production routing fix. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure `/swarm new` creates panes in the selected project's actual Herdr Space and rejects drifted project-to-workspace mappings at startup.

**Architecture:** Preserve configured workspace IDs as routing authority, but validate each against the live Herdr workspace label before accepting Lark traffic. Correct the private deployment registry independently from tracked source.

**Tech Stack:** TypeScript ESM, Zod, Vitest, Herdr CLI, JSON configuration.

**Spec:** `docs/superpowers/specs/2026-08-29-project-space-routing-validation-design.md`

## Global Constraints

- Do not move or close existing panes.
- Do not infer a workspace by cwd during creation.
- Do not start Lark ingress when project-to-Space validation fails.
- Do not expose private Lark credentials or persist runtime state in Git.

### Task 1: Add live workspace identity validation

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/adapters/herdr-adapter.ts`
- Modify: `src/coordinator/inbound-router.ts`
- Test: `tests/herdr-adapter.test.ts`
- Test: `tests/concurrency-controls.integration.test.ts`

- [ ] Add failing tests for label mismatch and per-project expected labels.
- [ ] Extend `assertWorkspace` with an optional expected label and validate the live response.
- [ ] Pass each project's derived Space name during startup.
- [ ] Run focused tests and typecheck.

### Task 2: Correct and deploy the production registry

**Files:**
- Modify outside Git: `/home/your-user/.config/herdr-agent-swarm/projects.json`

- [ ] Change `herdr-agent-swarm.workspaceId` from `wH` to `wN` without changing project cwd or instance definitions.
- [ ] Run `npm run config:validate` against the private files.
- [ ] Run the full suite, build, and diff checks; commit tracked changes.
- [ ] Confirm workers/outbox are idle, restart without force, and verify readiness.
- [ ] Verify a new project selection routes to `wN`; leave historical `wH` panes untouched.
