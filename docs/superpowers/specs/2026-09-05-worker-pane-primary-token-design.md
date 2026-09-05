# Primary and Worker pane token naming

## Status

Approved design. This document refines the Primary and Worker pane-title
portions of the Primary-scoped Worker identity design.

## Problem

Operators need to identify a Worker's Primary pane directly from the Herdr pane
list. Primary panes created by the Lark workflow currently carry a redundant
`task` segment, for example `lark_task-ilcs`, while Worker naming derives a
general cleaned label. The relationship is therefore less direct than the
intended shared-token form.

## Decision

A newly created Primary pane uses this title:

```text
lark_<primary-token>
```

The existing four-character base36 generator remains the token source. The
semantic Primary title passed to the Herdr adapter is `<primary-token>`; the
adapter's default Primary title policy adds exactly one `lark_` prefix. New,
reset, and replacement Primary creation all use this rule.

A newly allocated Worker pane uses this complete semantic title:

```text
lark_<primary-token>-<worker-name>
```

For example, new Primary pane `lark_ilcs` and Worker name `reviewer` produce
`lark_ilcs-reviewer`. The four-character token is shared verbatim with the
Primary pane; it is not rehashed when the Primary label already contains a
canonical token.

The coordinator extracts the token using these rules, in order:

1. Normalize the observed Primary pane label by trimming surrounding whitespace
   and comparing case-insensitively.
2. Accept the new canonical shape `lark_<token>` and the compatibility shapes
   `lark_task-<token>` and `task-<token>`, where `<token>` is exactly four ASCII
   base36 characters (`[a-z0-9]{4}`). Preserve the token after normalizing it to
   lowercase.
3. If the label is absent or does not match either canonical shape exactly,
   derive a deterministic fallback token from the immutable parent pane ID.

The fallback token is the first four base36 characters of an unsigned value
derived from the SHA-256 digest of the UTF-8 parent pane ID. Its implementation
must be deterministic across processes and Node versions and must left-pad with
zeroes when necessary. The fallback exists only for historical or externally
named Primary panes; it does not alter the Primary pane label.

The Worker name keeps the existing validated `[a-z][a-z0-9_-]{0,31}` value. The
Herdr adapter receives the complete Worker title with `titlePolicy: complete` and
must not add another `lark_` prefix.

## Boundaries

- This changes Primary titles only for panes created after deployment, including
  reset and replacement panes.
- Existing Primary and Worker panes are not renamed by startup or reconciliation.
- Existing workspace lease paths and Git branch names keep the current
  binding-and-pane scope token; they are not coupled to the display token.
- Persisted Worker names, Primary ownership, capacity, routing, and lifecycle
  semantics do not change.
- Explicit user-driven Primary rename behavior remains unchanged; a custom name
  may replace the generated token title. Workers created afterward use the
  deterministic parent-pane fallback unless that custom label itself exactly
  matches a supported token shape.
- `sourcePrimaryPaneLabel` remains display metadata. The immutable parent pane ID
  remains the fallback authority when the label is not canonical.

## Error handling

Token derivation is total for every valid parent identity. A missing or malformed
Primary label does not block Worker creation because the immutable pane ID yields
a deterministic fallback. Missing parent identity remains an existing fail-closed
Worker-creation error and is not weakened by this naming rule.

## Verification

Focused tests must prove:

- a newly created Primary with token `ilcs` is titled exactly `lark_ilcs`;
- reset and replacement Primary creation use the same title form;
- `lark_task-ilcs` plus `reviewer` produces exactly `lark_ilcs-reviewer`;
- `lark_ilcs` plus `reviewer` produces exactly `lark_ilcs-reviewer`;
- `task-ilcs` produces the same Worker prefix;
- canonical matching is case-insensitive and the emitted token is lowercase;
- labels with extra prefix/suffix text do not accidentally donate a token;
- missing and noncanonical labels use the deterministic parent-pane fallback;
- two Workers under one Primary reuse the same Primary token;
- the Herdr adapter receives one complete `lark_` prefix;
- existing worktree and branch naming assertions remain unchanged.

Run the focused instance-control and Herdr-adapter tests, then `npm run typecheck`
and `npm run build`.

## Non-goals

- Renaming existing Primary or Worker panes.
- Changing the random four-character Primary token generator.
- Changing Worker worktree or Git branch names.
- Treating the four-character display token as a durable ownership or security
  boundary.
