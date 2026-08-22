# Attach Existing Herdr Pane Design

## Goal

Allow a user to attach an existing Herdr pane to the configured Feishu group
without creating a new pane or restarting TraeX.

## Command

```text
/herdr attach <space> <pane>
```

Example:

```text
/herdr attach datasage_semantic_knowledge w5:p3G
```

Both arguments are required. `space` must exactly match a configured project
`spaceName`. `pane` accepts either an opaque Herdr pane identifier or an exact
pane label. Missing or extra arguments show the help card instead of guessing.

Pane resolution is deliberately narrow:

1. Prefer an exact pane-ID match in the selected project's workspace.
2. Otherwise, match the pane label exactly within that workspace.
3. Accept a label only when it identifies exactly one pane.
4. Reject an ambiguous label and list the matching pane IDs so the user can
   retry explicitly.

The bridge does not perform partial, case-insensitive, terminal-title, or cwd
matching. Terminal titles are dynamic and may be truncated, so they are not a
stable user-facing identifier.

## Validation

The bridge resolves the space to exactly one configured project, lists that
project's Herdr workspace, and resolves the requested pane by ID or unique
label. The pane must pass the bridge's existing TraeX process eligibility
check. A pane from another workspace, a missing or ambiguous pane reference, a
non-TraeX pane, an unknown space, or an ambiguous space is rejected with a
user-visible card.

## Binding flow

For an eligible unbound pane, the bridge stores the resolved stable pane ID and
creates a normal binding and project
entry card using the same path as Herdr discovery. The card becomes the root of
the Feishu topic. The bridge does not create, rename, restart, or send input to
the pane. Subsequent ordinary messages in that topic use the standard durable
prompt queue and the separate task and answer cards.

If the pane already has a healthy binding in the same Feishu group, the command
is idempotent: it creates no second binding or project card and returns a small
status card identifying the existing space and pane. A pane bound elsewhere is
rejected rather than silently moved.

## Failure and recovery

Validation happens before any binding is created. If Feishu topic creation
fails after the binding record is created, the existing provisioning recovery
path remains responsible for completing or surfacing that partial operation.
Every outcome is audited without logging message bodies or credentials.

## Help and verification

`/herdr help` documents the command and its ID-or-label argument. Tests cover
parsing, missing arguments, unknown and ambiguous spaces, exact ID precedence,
unique label resolution, ambiguous labels with candidate IDs, pane/workspace
mismatch, non-TraeX panes, successful attachment without pane mutation, and
idempotent repeated attach.
