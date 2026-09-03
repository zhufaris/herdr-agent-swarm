# Herdr Reconciliation Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent overlapping Herdr event hints from keeping runtime reconciliation in a self-sustaining CPU loop.

**Architecture:** `HerdrRuntimeReconciler` records the active pass coverage and absorbs event hints already covered by that pass. Broader requests still merge into the existing pending follow-up pass, preserving eventual convergence.

**Tech Stack:** TypeScript, Vitest, Herdr native events, SQLite-backed bridge runtime

**Spec:** `docs/superpowers/specs/2026-08-29-herdr-reconciliation-feedback-loop-design.md`

## Global Constraints

- Do not replay prompts or alter durable prompt state.
- Keep periodic full reconciliation unchanged.
- Preserve follow-up reconciliation when a concurrent hint broadens workspace coverage.
- Keep the production service on the stable build until verification passes.

---

### Task 1: Coverage-aware event coalescing

**Files:**
- Modify: `src/coordinator/herdr-runtime-reconciler.ts`
- Test: `tests/herdr-runtime-reconciler.test.ts`

**Interfaces:**
- Consumes: `requestReconciliation(workspaceIds?: readonly string[]): Promise<void>`
- Produces: unchanged public interface with bounded same-scope follow-up behavior

- [ ] Add a test that blocks a `w1` scan, requests `w1` again, releases the scan, and asserts one scan.
- [ ] Run the focused test and observe the existing implementation fail with two scans.
- [ ] Track active reconciliation coverage and absorb only fully covered requests.
- [ ] Run reconciler and native-event focused tests.
- [ ] Run the isolated production-snapshot health loop.
- [ ] Run typecheck, full tests, and build.
- [ ] Commit the verified fix.
- [ ] Deploy through the Herdr plugin and verify identity, readiness, CPU, workers, and outbox.
