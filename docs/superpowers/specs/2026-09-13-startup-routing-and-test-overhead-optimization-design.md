# Startup, Route Lookup, and Test Overhead Optimization

## Scope

This batch makes three low-risk optimizations without changing workflow, durability, or runtime authority semantics.

## Design

1. Startup workspace validation deduplicates exact `(workspaceId, expectedSpaceName)` pairs within one startup pass. Distinct workspace or space-name pairs remain independently validated and all unique checks remain concurrent.
2. `ProjectCatalog` exposes the full indexed workspace-and-cwd route bucket. Reconciliation uses that single lookup both to resolve a unique project and to classify unmatched panes as unregistered or ambiguous. Diagnostic IDs remain sorted.
3. `npm test` delegates architecture enforcement to `tests/architecture-boundaries.test.ts`, removing the duplicate pre-Vitest script execution. The standalone `npm run architecture:check` command remains available.

## Safety Boundaries

- No prompt dispatch, replay, SQLite transaction, outbox, or CardKit sequencing behavior changes.
- Startup still fails if any unique workspace assertion fails.
- Ambiguous and unregistered pane logging retains its current reason and matching-project payload.
- The architecture import check remains part of every full Vitest run.

## Verification

- Add a startup concurrency test containing a duplicate workspace/space pair.
- Add route-bucket tests for unique, missing, and ambiguous routes.
- Add a package-script contract test proving `npm test` runs Vitest without a separate architecture pre-pass.
- Run focused tests, typecheck, build, `git diff --check`, and the full suite.
