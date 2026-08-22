# Attach Existing Herdr Pane Design

## Goal

Allow a user to attach an existing Herdr pane to the configured Feishu group
without creating a new pane or restarting TraeX.

## Command

```text
/herdr attach <space> <pane-id>
```

Example:

```text
/herdr attach datasage_semantic_knowledge w5:p3G
```

Both arguments are required. `space` must exactly match a configured project
`spaceName`. `pane-id` is passed as an opaque Herdr pane identifier. Missing or
extra arguments show the help card instead of guessing.

## Validation

The bridge resolves the space to exactly one configured project, lists that
project's Herdr workspace, and requires the requested pane to be present there.
The pane must pass the bridge's existing TraeX process eligibility check. A pane
from another workspace, a non-TraeX pane, an unknown space, or an ambiguous
space is rejected with a user-visible card.

## Binding flow

For an eligible unbound pane, the bridge creates a normal binding and project
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

`/herdr help` documents the new command. Tests cover parsing, missing arguments,
unknown and ambiguous spaces, pane/workspace mismatch, non-TraeX panes,
successful attachment without pane mutation, and idempotent repeated attach.
