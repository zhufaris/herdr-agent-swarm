# Startup Reconciliation Isolation Implementation Plan

> **For agentic workers:** Execute inline with red-green tests at public workflow seams.

**Goal:** Isolate recoverable startup failures by stage and binding.

**Architecture:** Keep local durability and workspace validation fail-fast. Start
long-lived recovery loops before running best-effort convergence stages, and
isolate iteration failures inside the workflows that own each batch.

**Tech Stack:** TypeScript, Vitest, SQLite, Pino.

**Spec:** `docs/superpowers/specs/2026-08-26-startup-reconciliation-isolation-design.md`

## Tasks

- [ ] Add a failing Startup View test proving one binding failure does not block the next binding.
- [ ] Add a failing runtime reconciliation test proving one pane failure does not block the next pane.
- [ ] Add a failing router startup test proving recoverable stages do not block ingress.
- [ ] Implement per-unit isolation and staged startup logging.
- [ ] Run focused and full verification, commit, deploy, and inspect production evidence.
