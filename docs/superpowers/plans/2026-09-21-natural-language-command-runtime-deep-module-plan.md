# Natural-Language Command Runtime Deep-Module Implementation Plan

## Objective

Replace the separately composed Controller manager, tool gateway, and fallback
interpreter with one lifecycle-owned natural-language runtime, then reorganize
the deterministic parser into explicit ordered rule groups without changing any
observable command, durability, permission, or recovery behavior.

## Work packages

### 1. Characterize the external interface

- Add focused tests for deterministic-first interpretation, unresolved fallback,
  disabled mode, degraded Controller startup, and idempotent lifecycle.
- Reuse the existing in-memory Controller store and Herdr adapter fakes so tests
  assert durable outcomes rather than private implementation state.
- Preserve direct MCP protocol and SQLite store tests at their real seams.

### 2. Introduce the deep runtime

- Add one `NaturalLanguageCommandRuntime` interface and production constructor.
- Move deterministic selection, Controller endpoint ownership, Controller Agent
  ownership, job execution, and safe lifecycle ordering behind that interface.
- Make disabled mode satisfy the same interface without Controller resources.
- Replace the three Controller values in bridge composition and managed lifecycle
  with one runtime value.
- Pass only the interpretation interface into Ingress.

### 3. Reorganize deterministic rules

- Introduce one normalized interpretation context.
- Extract ordered internal rule groups for unsupported controls, exact queries,
  ambiguity, project and Primary commands, Worker commands, current-session
  mutations, and task classification.
- Keep result constructors and project resolution private.
- Convert parser coverage into grouped table-driven compatibility cases without
  changing expected results.

### 4. Remove shallow wiring and synchronize docs

- Remove the fallback interpreter and any composition-facing Controller manager
  or gateway lifecycle fields that are no longer needed.
- Replace duplicate orchestration tests with tests at the runtime interface while
  retaining Herdr, MCP, and SQLite seam tests.
- Update the architecture guide and active engineering index to describe the
  implemented deep module.

### 5. Verify and commit

- Run focused natural-language runtime, parser, Controller MCP, manager-equivalent,
  Ingress, managed-runtime, and architecture tests.
- Run `npm run docs:audit`, `npm run typecheck`, `npm run build`,
  `npm run architecture:check`, `npm run public:audit`, and the full test suite.
- Confirm no SQLite schema, migration, SQL, CardKit, or user-visible behavior
  changed.
- Commit the refactor separately from the already committed engineering-skills
  setup and design documents.
