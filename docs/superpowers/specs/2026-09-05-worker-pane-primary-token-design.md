# Worker pane Primary token naming

## Status

Approved design. This document refines the Worker pane-title portion of the
Primary-scoped Worker identity design.

## Problem

Operators need to identify a Worker's Primary pane directly from the Herdr pane
list. Primary panes created by the Lark workflow carry a visible four-character
base36 token, for example `lark_task-ilcs`, but Worker naming currently derives a
general cleaned label. The relationship is therefore implicit and can be lost
when a Primary label has additional text or a historical naming shape.

## Decision

A newly allocated Worker pane uses this complete semantic title:

```text
lark_<primary-token>-<worker-name>
```

For example, Primary pane label `lark_task-ilcs` and Worker name `reviewer`
produce `lark_ilcs-reviewer`. The four-character token is shared verbatim with
the Primary pane; it is not rehashed when the Primary label already contains a
canonical token.

The coordinator extracts the token using these rules, in order:

1. Normalize the observed Primary pane label by trimming surrounding whitespace
   and comparing case-insensitively.
2. Accept the exact canonical shapes `lark_task-<token>` and `task-<token>`, where
   `<token>` is exactly four ASCII lowercase base36 characters (`[a-z0-9]{4}`).
   Preserve the token after normalizing it to lowercase.
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

- This changes only pane titles for Workers allocated after deployment.
- Existing Worker panes are not renamed.
- Existing workspace lease paths and Git branch names keep the current
  binding-and-pane scope token; they are not coupled to the display token.
- Persisted Worker names, Primary ownership, capacity, routing, and lifecycle
  semantics do not change.
- `sourcePrimaryPaneLabel` remains display metadata. The immutable parent pane ID
  remains the fallback authority when the label is not canonical.

## Error handling

Token derivation is total for every valid parent identity. A missing or malformed
Primary label does not block Worker creation because the immutable pane ID yields
a deterministic fallback. Missing parent identity remains an existing fail-closed
Worker-creation error and is not weakened by this naming rule.

## Verification

Focused tests must prove:

- `lark_task-ilcs` plus `reviewer` produces exactly `lark_ilcs-reviewer`;
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
- Changing Primary pane generation.
- Changing Worker worktree or Git branch names.
- Treating the four-character display token as a durable ownership or security
  boundary.
