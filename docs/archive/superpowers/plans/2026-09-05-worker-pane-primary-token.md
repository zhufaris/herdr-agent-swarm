# Primary and Worker pane token naming implementation plan

**Goal:** Name newly created Primary panes `lark_<token>` and their Worker panes
`lark_<same-token>-<worker>`, while preserving compatibility with historical
Primary labels.

**Spec:** `docs/superpowers/specs/2026-09-05-worker-pane-primary-token-design.md`

## Slice 1: Lock the naming contract with tests

- Extend provisioning tests to assert new, reset, and replacement Primary pane
  titles no longer contain `task`.
- Extend instance-control tests for canonical new and legacy Primary labels,
  case normalization, deterministic noncanonical fallback, and shared tokens
  across sibling Workers.
- Preserve existing worktree and branch naming assertions.

## Slice 2: Centralize Primary token rules

- Add a small domain naming module for four-character Primary tokens.
- Keep the current random base36 token generation, but expose it without the
  obsolete `task-` semantic prefix.
- Extract canonical tokens from `lark_<token>`, `lark_task-<token>`, and
  `task-<token>`; derive the documented SHA-256/base36 fallback from pane ID.

## Slice 3: Apply the rules at creation boundaries

- Route new, reset, and replacement Primary creation through the shared token
  generator so the adapter produces exactly `lark_<token>`.
- Route Worker pane title construction through the shared extractor and retain
  `titlePolicy: complete`.
- Do not alter persisted worktree paths, branches, or existing panes.

## Slice 4: Verify and review

- Run the focused provisioning, instance-control, and Herdr-adapter tests.
- Run `npm run typecheck` and `npm run build`.
- Run `git diff --check` and inspect the final diff for accidental persistence
  or migration changes.
