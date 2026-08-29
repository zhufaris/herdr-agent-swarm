# Safe Run Card View Migration Implementation Plan

> **For agentic workers:** Implement this plan inline and preserve the existing agent-swarm database; all production-data validation must use a copied database.

**Goal:** Make startup schema migration tolerate legacy `run_cards` columns while an existing `run_cards_view` references the newer schema.

**Architecture:** Treat `run_cards_view` as a derived schema object. Drop it before incremental table migrations, avoid recreating it during intermediate schema states, and recreate it once after all run-card columns are present.

**Tech Stack:** TypeScript, Node.js SQLite, Vitest, user systemd

**Spec:** Approved in the 2026-08-29 service-restart diagnosis.

## Global Constraints

- Do not edit or replace the live SQLite database during development or migration testing.
- Preserve all existing binding, prompt, card, and outbox data.
- Do not modify unrelated uncommitted work.

---

### Task 1: Lock down legacy-view migration

**Files:**
- Modify: `tests/sqlite-store.test.ts`
- Modify: `src/store/sqlite-store.ts`

- [ ] Add a regression fixture with a legacy `run_cards` table and a stale view that references newer columns.
- [ ] Run the focused test and confirm the current migration fails with `no such column: steering_origin`.
- [ ] Drop the derived view before table migrations and recreate it only after all run-card migrations complete.
- [ ] Run the focused SQLite store test, typecheck, and build.

### Task 2: Validate and restore the service

**Files:**
- Read: `/home/feiyu.zhu/.local/state/herdr-agent-swarm/bridge.db`

- [ ] Copy the live SQLite database together with its WAL/SHM state using SQLite's backup mechanism.
- [ ] Open the copy with the rebuilt store and confirm schema migration plus integrity checks succeed.
- [ ] Start `herdr-agent-swarm.service`.
- [ ] Verify service readiness and observed Build ID match the rebuilt artifact.
