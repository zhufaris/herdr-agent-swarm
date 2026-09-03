# Complete Build Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the deployment build ID sensitive to compiled code, locked dependencies, and the build-time Node runtime.

**Architecture:** Move digest construction into a pure ESM helper with framed inputs. Keep the generator as the filesystem adapter that supplies repository and runtime data.

**Tech Stack:** Node.js ESM, SHA-256, Vitest

**Spec:** `docs/superpowers/specs/2026-08-29-complete-build-identity-design.md`

## Global Constraints

- Preserve the existing `build-info.json` schema and `sha256:<hex>` format.
- Hash `package-lock.json`, Node version, and Node module ABI.
- Keep hashing deterministic and independent of absolute checkout paths.
- Keep unrelated dirty files out of the commit.

---

### Task 1: Add complete build identity inputs

**Files:**
- Create: `scripts/build-id-input.mjs`
- Modify: `scripts/generate-build-info.mjs`
- Modify: `tests/build-identity.test.ts`

**Interfaces:**
- Produces: `calculateBuildId({ serviceId, version, nodeVersion, nodeModulesAbi, lockfile, files })`.
- Preserves: generated `BuildIdentity` JSON fields and runtime loader behavior.

- [ ] Add a failing test that loads the helper through Node ESM and proves lockfile, Node version, ABI, and compiled content each alter the digest.
- [ ] Run `npx vitest run tests/build-identity.test.ts` and confirm the helper is missing.
- [ ] Implement length-framed deterministic SHA-256 hashing in `scripts/build-id-input.mjs`.
- [ ] Update `generate-build-info.mjs` to pass sorted relative JS paths, file bytes, `package-lock.json`, and Node runtime fields.
- [ ] Run `npx vitest run tests/build-identity.test.ts`, `npm run typecheck`, `npm run build`, and validate the generated file with the runtime loader.
- [ ] Run the full suite; if unrelated dirty WIP tests remain red, record that separately and rerun all unaffected focused tests.
- [ ] Commit only the spec, plan, helper, generator, and build identity test as `fix: include runtime dependencies in build identity`.
