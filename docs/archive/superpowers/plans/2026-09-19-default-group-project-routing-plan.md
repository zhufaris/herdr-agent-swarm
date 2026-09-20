# Default Group Project Routing Implementation Plan

## Goal

Route an allowed root Lark message that explicitly mentions the bot directly
into the configured default project, while retaining SQLite durability, Herdr
pane identity fencing, and the existing no-replay recovery boundary. Projects
without an explicit Space name resolve to `herdr`.

## Implementation Slices

1. Add a configuration-level test for the `herdr` Space fallback, then update
   `projectSpaceName` and ProjectCatalog expectations.
2. Add a routing test that requires the default-project provisioning entry
   point for an unbound mentioned root message, while preserving command,
   binding, Worker, and unmentioned-message precedence.
3. Add an atomic store operation that creates a processing project selection
   with its selected default project already frozen and without enqueuing a
   selector card. Cover duplicate source-message convergence at the store seam.
4. Add a provisioning integration test proving one natural-language root
   message creates one default-project pane, one thread, and one initial Prompt
   without a project-selector click. Replay the source event and prove no
   duplicate external effects.
5. Reuse the selected-project lifecycle for direct provisioning. Allow startup
   recovery to create a binding only when a processing selection has no linked
   binding, which proves pane creation never started. Preserve conservative
   recovery once a binding exists.
6. Update the operator and architecture documentation with the group default
   route, `herdr` Space fallback, immutable binding route, and recovery rules.
7. Run focused tests after each vertical slice, then the full test suite,
   typecheck, build, architecture check, docs audit, and diff review. Commit the
   implementation separately from the approved design.

## Expected Files

- `src/config.ts`
- `src/coordinator/inbound-message-routing-workflow.ts`
- `src/coordinator/binding-provisioning-workflow.ts`
- `src/coordinator/binding-provisioning/project-selection-use-case.ts`
- `src/domain/ports/binding.ts`
- `src/store/sqlite/inbound-project-store.ts`
- SQLite store adapters and test helpers that implement the binding port
- focused configuration, routing, SQLite, provisioning, and recovery tests
- `docs/feishu-group-usage.md` and `docs/architecture.md`

## Validation

The change is complete only when duplicate inbound delivery cannot create a
second selection, binding, pane, Lark thread, or Prompt; interrupted work
retains the existing fail-closed replay behavior; and all repository-required
checks pass.
