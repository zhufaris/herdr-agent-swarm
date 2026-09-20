# Primary-scoped Worker identity and pane naming

## Status

Approved design. This document complements the pane-scoped Worker lifecycle
design by defining Worker namespace, routing, resource identity, and display
naming.

## Problem

The current implementation records a Worker's parent binding and pane, but it
still treats Workers as project-scoped in several important places:

- SQLite enforces `UNIQUE(project_id, name)`.
- Worker listing and name-based command routing enumerate all project Workers.
- worktree directories and Git branches use only the Worker name.
- the coordinator constructs a title containing `lark_task`, while the Herdr
  adapter also adds `lark_`, allowing duplicated `lark` and `task` segments.

Consequently, two Primary panes in one project cannot independently own a
Worker with the same human-facing name, and a command originating in one
Primary can resolve a Worker owned by another Primary.

## Decision

A Worker belongs to one immutable Primary scope. The scope key is the exact
pair `(parent_binding_id, parent_pane_id)`. Within that scope, the Worker name
must be unique. The same Worker name may exist under another Primary scope in
the same project.

Every operation that discovers a Worker by name or presents a collection of
Workers must first establish the current active Primary binding and pane, then
operate only on Workers whose persisted parent identity exactly matches that
scope. An instance ID remains globally unique, but possession of an instance ID
does not bypass the current Primary-scope fence for Lark commands or callbacks.

## Considered approaches

### Full Primary scope — selected

Apply the parent scope consistently to persistence, lookup, routing, resources,
cards, and lifecycle operations. This removes cross-Primary ambiguity and
supports same-named Workers safely.

### Presentation-only naming fix — rejected

Removing duplicated title prefixes would improve Herdr tabs but leave database,
routing, worktree, and branch collisions intact.

### Query filtering without resource/schema changes — rejected

Filtering cards and commands could hide other Primary Workers, but the old
unique constraint and name-only worktree/branch paths would still prevent two
Primary panes from owning the same Worker name.

## Persisted identity and uniqueness

For active pane-scoped Workers, logical uniqueness is:

```text
(parent_binding_id, parent_pane_id, name)
```

The SQLite migration must replace `UNIQUE(project_id, name)` with a partial
unique index over those three columns for rows whose role is `worker` and whose
parent fields are non-null. IDs remain primary keys. Legacy rows with no parent
identity remain readable and do not block creation of active scoped Workers.
They cannot be resolved by scoped name routing or adopted into a Primary scope.

The configured project Worker limit remains project-wide unless a separate
product decision changes it. Creating same-named Workers under different
Primary panes consumes two slots.

Concurrent creation in the same Primary scope is serialized by the database
constraint. A duplicate is reported as an already-existing Worker in that
Primary, not as an internal SQLite error.

## Primary-scope resolution

The canonical scope resolver accepts a binding identity and verifies all of the
following before returning a scope:

- the binding exists and belongs to the requested project and Herdr workspace;
- its lifecycle and state are active and its attachment is attached;
- it records a pane ID;
- a fresh Herdr observation confirms that pane in the configured workspace and
  project directory;
- the native runtime identity matches when SQLite has one.

Worker creation, listing, `/to`, `/steer`, instance-card actions, removal
planning, removal confirmation, and other Lark-facing Worker controls use this
scope. Callback payloads carry the binding ID, binding generation, parent pane
ID, Worker ID, and Worker generation. The handler reloads all records and fails
closed if any fence is stale or mismatched.

Direct internal APIs may address an instance by ID for reconciliation and
recovery, but user-originated operations never infer scope from project ID
alone.

## Routing and listing behavior

- `/instances` and the instance directory show only Workers belonging to the
  current Primary binding and exact pane.
- `/to <name> <task>` resolves `<name>` only inside the current Primary scope.
- `/steer <name> <instruction>` follows the same scoped lookup and then applies
  the existing exact-active-turn fences.
- Replies to Worker task cards verify that the card's Worker belongs to the
  current Primary scope before accepting an action.
- A Worker from another Primary is treated as absent; the response must not
  disclose its existence or state.
- Closing a Primary continues to cascade only to Workers with the exact stored
  binding-and-pane parent identity.

Project-wide Worker enumeration remains available only to internal
reconciliation, health/diagnostic code, and the project-wide capacity check.
Its name must make that broader scope explicit.

## Worktree and branch identity

Human Worker names are not sufficient filesystem or Git identifiers once names
are scoped per Primary. New Worker resources use a stable, bounded Primary
scope token derived from persisted non-secret identity, not from a mutable pane
label.

The canonical resource forms are:

```text
.worktree/lark-<scope-token>-<worker-name>
swarm/lark-<scope-token>-<worker-name>
```

`scope-token` is a deterministic short token derived from the parent binding ID
and parent pane ID. Sanitization and length limits apply before filesystem or Git
use, and a hash suffix preserves uniqueness after truncation. These canonical
names are persisted in the workspace lease when the Worker is created; later
pane-label changes do not rename resources. Existing and legacy workspace leases
keep their recorded paths and branches.

## Herdr pane naming

The user-visible Worker pane title is:

```text
lark_<primary>-<worker>
```

The coordinator owns the semantic title. Before composing it:

- the Primary label is normalized by repeatedly removing leading `lark_`,
  `lark-`, `task_`, or `task-` segments;
- the Worker name is normalized with the same rule;
- whitespace and unsupported characters become a single hyphen;
- empty segments fall back to stable non-empty identifiers;
- truncation retains a deterministic hash suffix to prevent collisions.

For example, Primary label `lark_task-alpha` and Worker name `reviewer` produce
`lark_alpha-reviewer`.

The Herdr adapter receives this complete title and passes it through unchanged
apart from transport-level validation. It must not add `lark_`, `task`, or any
other semantic prefix. Primary-tab naming, if it still requires a default
prefix, uses a separate adapter entry point or an explicit title policy rather
than applying Worker naming rules implicitly.

## Migration and compatibility

SQLite table migration is transactional:

1. Create the replacement `agent_instances` table without the project/name
   unique constraint while preserving foreign keys and checks.
2. Copy all rows without inventing parent identity for legacy Workers.
3. Replace the table and recreate existing indexes and the new scoped unique
   index.
4. Run foreign-key integrity checks in migration tests.

Existing active Workers that already have parent identity become scoped under
that exact identity. Existing rows lacking parent identity remain `legacy` as
defined by the pane-scoped lifecycle design. Existing workspace paths, branch
names, pane IDs, and historical card data are never rewritten.

## Error handling

- Duplicate name in the same Primary: reject with a user-facing scoped-name
  conflict and make no external Herdr or Git call.
- Missing/stale Primary scope: reject before creating a Worker record or
  resource.
- Cross-Primary Worker ID or callback: return the same not-found/stale response
  used for an unavailable Worker and perform no mutation.
- Worktree or branch collision despite canonical naming: retain the durable
  failed provisioning checkpoint and report the bounded, redacted error; never
  silently adopt an unrelated worktree.
- Invalid or overlong pane title input: normalize deterministically; do not let
  the adapter apply a second naming transformation.

## Verification strategy

Focused tests must prove:

- two Primary panes in one project can each create a Worker named `reviewer`;
- a second `reviewer` under the same Primary is rejected atomically;
- same-named Workers receive distinct worktree paths, branches, pane IDs, and
  persisted parent identities;
- `/instances`, `/to`, `/steer`, card callbacks, and removal operations cannot
  see or mutate a sibling Primary's Worker;
- project-wide capacity still counts Workers across all Primary scopes;
- parent labels containing repeated `lark` and `task` prefixes produce exactly
  one canonical prefix and no repeated segment;
- the adapter passes a complete Worker title without adding a prefix;
- migration preserves active parented Workers and keeps unparented rows legacy;
- Primary closure affects exact-scope children only.

Because the change spans persistence, routing, workflow, and shared runtime
behavior, verification includes the focused store and integration suites,
`npm run typecheck`, `npm run build`, and the full `npm test`.

## Non-goals

- Changing the project-wide `maxInstances` policy.
- Reparenting a Worker to another Primary pane.
- Renaming existing worktrees, branches, or historical panes.
- Allowing Lark to discover Workers owned by another Primary.
- Rehydrating a terminated Worker in a replacement pane.
