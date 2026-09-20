# Project Route Index Design

## Goal

Centralize the compatibility rule that maps a durable binding to its configured
project and visible space name. Today several coordinator workflows independently
build project maps, while pane closure only supports direct project-ID lookup.
Those copies can drift and render the same legacy binding differently.

## Options considered

1. Add free helper functions beside each workflow. This removes a little code but
   still lets callers construct different indexes or combine the helpers
   inconsistently.
2. Put binding resolution in `config.ts`. This is convenient, but configuration
   loading should not own compatibility policy for durable runtime bindings.
3. Add a small immutable `ProjectRouteIndex` in the coordinator layer. This keeps
   the policy near its workflow consumers, computes indexes once, and exposes a
   narrow API. This is the selected approach.

## Design

`ProjectRouteIndex` is a pure, immutable coordinator service constructed from the
validated project list. It precomputes:

- project ID to `ProjectConfig`;
- workspace ID to one project, or an explicit ambiguous marker.

It exposes three operations:

- `projectById(projectId)` performs direct configured-project lookup;
- `projectForBinding(binding)` applies the canonical binding compatibility rule;
- `spaceNameForBinding(binding)` formats the resolved project with the existing
  `projectSpaceName()` function and otherwise returns `legacy/unresolved`.

Binding resolution is deterministic:

1. If `binding.projectId` resolves to a configured project, use it.
2. If the project ID is absent, use the workspace only when exactly one
   configured project has that workspace ID.
3. If the workspace is unknown or shared by multiple projects, do not guess.

The project ID is authoritative whenever it is present. A stale project ID does
not silently retarget a durable binding through its workspace. Ambiguity and
unknown routes always fail closed.

## Integration

`InboundMessageRoutingWorkflow`, `ModelSelectionWorkflow`,
`StartupViewConverger`, and `PaneClosureWorkflow` each construct the index from
their existing configuration input and delegate space-name resolution to it. No
composition or persistence contract changes are required. The module is not a
general project registry and does not absorb project selection, authorization,
pane identity, or workspace-and-cwd routing rules owned by other workflows.

## Safety and compatibility

The change is read-only with respect to workflow state. It does not alter prompt
dispatch, exact-turn control, FIFO ordering, outbox persistence, or transaction
boundaries. Unknown and ambiguous legacy routes continue to render as
`legacy/unresolved`; pane closure becomes consistent with the other consumers for
legacy bindings that have a uniquely identifiable workspace.

## Tests

Focused unit tests cover valid project-ID precedence, unique-workspace fallback,
stale project-ID rejection, ambiguous workspaces, unknown workspaces, and space-name
formatting. Existing workflow tests then verify that integration behavior remains
unchanged. Full tests, typecheck, build, documentation audit, and diff checks run
before the implementation commit.
