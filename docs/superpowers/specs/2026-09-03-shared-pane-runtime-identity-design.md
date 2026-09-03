# Shared Pane Runtime Identity Design

## Purpose

Remove duplicate runtime pane identity validation from
`BindingProvisioningWorkflow`. `SessionAdministrationWorkflow` already uses
`pane-runtime-identity.ts` for the same workspace, project path, terminal,
native Agent session, and TraeX-process checks. Keeping separate copies risks
one attach/recovery path accepting a pane another session operation rejects.

## Scope

Make `pane-runtime-identity.ts` the shared deep module for validated runtime
pane identity. `BindingProvisioningWorkflow` will call its `requireMatchingPane`
instead of maintaining a local implementation.

When a binding has an exact persisted native Agent session but an otherwise
matching Herdr observation omits `agentSession`, the shared module returns the
verified pane with that persisted session restored. This preserves the existing
attach/recovery behavior: an omitted optional runtime field must not erase a
durable identity; a present mismatching identity still fails closed.

## Boundaries and invariants

- The module reads one runtime observation but performs no SQLite mutation,
  provisioning action, event publication, or Lark delivery.
- Callers retain workflow decisions and durable identity writes.
- A pane must match workspace and configured project `cwd`, run TraeX, and not
  conflict with a durable terminal or native Agent session identity.
- A non-null observed native session must exactly match a durable native
  session. Missing observed session data may use the durable identity only
  after all other checks pass.
- The change does not relax failed-reset recovery, replacement, or attach
  generation fences.

## Verification

Extend pane identity tests for durable-session restoration and mismatches, then
run provisioning/attach/session administration integration tests, typecheck,
build, and `git diff --check`. Commit the implementation separately.
