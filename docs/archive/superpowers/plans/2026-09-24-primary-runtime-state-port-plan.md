# Primary Runtime State Port Implementation Plan

1. Add `src/domain/ports/primary-runtime-state.ts` with the active-turn snapshot
   and the two read-only queries.
2. Make `PromptRunWorkflowPort` extend the new port and remove its local snapshot
   type.
3. Export `primaryState` from Primary composition and route read-only composition
   wiring through it. Keep full `promptRun` only where command or lifecycle
   methods are required.
4. Add architecture assertions for the domain port and named seam.
5. Run focused Prompt, command, pane, reconciliation, and inbound-routing tests,
   then typecheck, build, full tests, docs audit, and diff audit.
6. Commit the refactor. Do not install, restart, or push.
