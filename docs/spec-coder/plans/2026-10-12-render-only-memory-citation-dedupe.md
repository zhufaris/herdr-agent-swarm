# Render-only Memory Citation Deduplication Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

- Specification: `docs/spec-coder/specs/2026-10-12-render-only-memory-citation-dedupe.md`
- Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`
- Mode: in-place inside the existing isolated deployment worktree; original checkout untouched.
- Branch: `main`
- Starting revision: `0d6d3bb29bfc04819b1e7186d7752db4617f232f`
- Initial changes: this specification and plan only.
- Baseline: 2 focused files / 66 tests and typecheck passed.
- Authority: bounded design selected under the user's current `继续完成` directive; one serial TDD ticket is authorized.

## Wave W1: `T1`

### - [x] T1: Deduplicate visible answers across terminal citation metadata

| Field | Content |
| --- | --- |
| What to build | Strip only complete terminal OAI memory-citation metadata from render copies of assistant Markdown and use that visible form for exact agent/final answer deduplication. |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, ARCH-1 |
| Dependencies | None |
| Delegation eligibility | Existing pure presentation seam, bounded reversible scope and deterministic focused tests make this eligible for one direct worker. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Answer Timeline Card presentation owns terminal metadata recognition, visible normalization and exact dedupe; canonical domain/store inputs remain read-only. |
| Mutation ownership | `src/cards/answer-timeline.ts`, `tests/answer-timeline-page.test.ts`, `tests/answer-timeline-card.test.ts`, `docs/architecture.md` |
| Exclusions | No Core/runtime/store/schema/SQLite history mutation, no generic XML removal, no pagination/source-offset changes, no staging, commit, install, deploy or indirect delegation by the worker. |
| Isolation | One serial direct worker in the prepared isolated worktree; main owns artifacts, integration and commit. |
| Concurrency conflicts | None |
| Verification seam | Public page planner and renderer assertions cover exact visible duplicate suppression, final metadata hiding, and malformed/mid-body/fenced literal preservation. |
| Host capacity | One direct-child slot; main rechecks capacity and independently verifies the returned diff. |
| Direct-child boundary | `delegation_allowed = false`; child must not spawn, stage, commit, deploy, edit spec/plan or touch production state. |
| Acceptance criteria and verification | Visible duplicate appears once; valid terminal citation markup is absent from rendered cards; incomplete, mid-body and fenced literal citation-like content remains visible; canonical item IDs/order/canonical positions/source cursors remain unchanged while presentation item fingerprints/page counts may change. Run focused renderer/page tests, typecheck, build, architecture check and docs audit. |
| Verification commands | `npx vitest run tests/answer-timeline-page.test.ts tests/answer-timeline-card.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `npm run docs:audit` |
| Verification results | Main observed exit 0: 2 focused files / 75 tests passed; typecheck, build, architecture imports and docs audit passed. Red rendered the same visible answer twice; Green suppresses the metadata-only duplicate, hides terminal metadata on final answers, preserves malformed/mid-body/fenced literals, and leaves the canonical input object unchanged. |
| Commits | `84134737`, `1c4cef42` |
| Blocked by | None |

## Final delivery checks

Main performs independent Standards and Spec reviews, runs the complete Vitest
suite, focused tests, typecheck, build, architecture check, docs audit and the
delivery artifact checker. Installation/restart and live Feishu evidence remain
operator actions after verified delivery.
