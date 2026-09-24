# Consumer-Shaped Runtime Seams Implementation Plan

## Goal

Make runtime and child-composition dependencies point at consumer-shaped domain
interfaces without changing the production object graph or observable behavior.

## Step 1: Worker card display port

Files:

- `src/domain/ports/worker-card-display.ts`
- `src/coordinator/worker-card-display-workflow.ts`
- `src/runtime/primary-tool-broker.ts`
- `src/runtime/primary-tool-gateway.ts`
- Primary-tool tests

Add named input and callable port types. Make the workflow satisfy that port and
replace runtime imports of the workflow implementation with the domain port.
Run the Primary-tool broker and gateway tests.

## Step 2: Explicit composition capability sets

Files:

- `src/composition/create-outbound-runtime.ts`
- `src/composition/create-primary-runtime.ts`
- `src/composition/create-worker-runtime.ts`
- `src/composition/create-binding-session-runtime.ts`
- `src/composition/create-command-control-runtime.ts`
- `src/composition/create-ingress-recovery-runtime.ts`
- `src/composition/create-application-runtime.ts`

Replace each `Pick<SqliteStoreBundle, ...>` type with an interface built from
the existing domain ports. Preserve property names and runtime construction.
Compose the aggregate application capability set from the three child sets.
Run TypeScript type checking after the mechanical migration to catch missing or
over-broad capabilities.

## Step 3: Architecture guards

File: `tests/architecture-boundaries.test.ts`

Replace the guard that requires `Pick<SqliteStoreBundle, ...>` with guards that
forbid child composition imports of the bundle and require exported store
interfaces. Add a guard preventing runtime modules from importing coordinator
implementations for callable dependencies. Run the architecture test.

## Step 4: Verification

Run:

1. `npx vitest run tests/primary-tool-broker.test.ts tests/primary-tool-gateway.integration.test.ts tests/architecture-boundaries.test.ts`
2. `npm run typecheck`
3. `npm run build`
4. `npm test`
5. `git diff --check` and inspect the final diff

Confirm that no SQLite implementation, schema, migration, transaction, command
protocol, rendering, or lifecycle behavior changed. Commit the implementation as
one independently verifiable refactor. Do not install, restart, or push.
