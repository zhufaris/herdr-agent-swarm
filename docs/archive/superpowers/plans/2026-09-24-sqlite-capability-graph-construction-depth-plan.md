# SQLite Capability Graph Construction Depth Implementation Plan

## Goal

Remove partial-object construction from `SqliteCapabilityGraph` and make every
construction cycle explicit and fail-fast while preserving store instances,
capability aliases, migrations, and transaction behavior.

## Step 1: Add the construction link

Create `src/store/sqlite/store-link.ts` with a package-private one-shot link.
Add `tests/store-link.test.ts` covering connection, early access, and duplicate
connection.

## Step 2: Replace the partial cluster

Refactor `src/store/sqlite/capability-graph.ts` to:

- construct independent stores as one complete typed object;
- create named links for outbox, prompts, instances, Worker turns, and card
  contexts;
- construct collaborating stores into local constants;
- connect each link immediately after its target exists;
- return one complete `StoreCluster` object literal;
- remove `FoundationStoreFactories`, `{} as StoreCluster`, and property-by-property
  mutation.

Do not change constructor arguments other than replacing partial-cluster reads
with link reads. Do not modify SQL or store implementations.

## Step 3: Enforce the construction rule

Extend `tests/architecture-boundaries.test.ts` to reject partial or asserted
`StoreCluster` construction and require the named construction link. Preserve
the existing capability graph tests for aliases, shared context/lease/fence, and
migration sequence.

## Step 4: Verify and commit

Run focused StoreLink, capability graph, architecture, and SQLite tests, then
`npm run typecheck`, `npm run build`, `npm test`, `npm run docs:audit`, and
`git diff --check`. Inspect the diff to confirm there are no schema, SQL, public
port, or runtime behavior changes. Commit as one refactor without installing,
restarting, or pushing.
