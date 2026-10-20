# Edit Tool Code Diff Plan

Specification:
`docs/spec-coder/specs/2026-10-02-edit-tool-code-diff.md`

Workspace: in place on `main`, starting from
`dc4f170097900f552129fcbe67eac0c5309dcb26`. The tracked tree was clean at
selection. Preserve the user-owned untracked paths recorded in the
specification.

Baseline: 125 tests across the affected projector/render suites,
`npm run typecheck`, and `npm run build` passed before artifact creation.

Approval status: Gate 1 design, Gate 2 specification, and Gate 3 implementation
authorization approved.

- [x] **T1: Show the recorded code diff inside Edit tool panels**

  **What to build:** Carry an attributable, sanitized `apply_patch` body from
  direct and Code Mode transcript inputs into the shared Answer timeline and
  render it as `**Diff**` in a `diff` fence inside the existing Edit tool
  panel. Preserve summary-only fallback when no trustworthy diff exists and
  keep Primary Answer and Worker Task behavior identical.

  **Spec references:** SCN-1 through SCN-5; INV-1 through INV-5; Domain Model;
  Architecture; Behavior & Failure Modes; Compatibility & Migration.

  **Ownership and implementation path:** Conversation Projection owns the
  historical timeline DTO. `tool-activity-projector` owns extraction and
  earliest redaction of external tool arguments. The Herdr Core and legacy
  TraeX projectors translate the optional bounded value into the domain DTO.
  The shared answer-tool render projection and timeline renderer own CardKit
  formatting and defense-in-depth truncation. Reuse the existing interfaces;
  introduce no database migration, composition dependency, live filesystem
  query, or execution behavior.

  **Acceptance criteria and verification:**

  - A direct or single attributable nested `apply_patch` produces one Edit
    timeline item whose expanded detail contains the patch in source order
    under `**Diff**` and a `diff` fence.
  - Multi-file patches retain file/hunk order. Tool ID, ordering, grouping,
    state, summary, and success/failure classification do not change.
  - Secret-bearing content is redacted before timeline persistence; long
    content is bounded with the established truncation marker and remains
    inside CardKit payload limits.
  - Malformed, non-patch, and ambiguously attributable inputs omit `diff`
    without inventing content. Historical items without `diff` retain their
    existing summary-only or command/result rendering.
  - Focused tests cover extraction, both transcript projectors, shared
    rendering, and Primary/Worker integration. Observe the new behavior fail
    before implementation, then pass after the minimum change.
  - Run affected Vitest suites, `npm run typecheck`, `npm run build`,
    `git diff --check`, and the complete `npm test` suite. Review the complete
    ticket diff against the specification before the atomic Conventional
    Commit.

  **Blocked by:** None.

## Final Delivery Checks

- Map SCN-1 through SCN-5 and INV-1 through INV-5 to implemented tests and
  source evidence.
- Review extraction attribution, pre-persistence redaction, DTO compatibility,
  and shared renderer dependency direction findings-first.
- Confirm the ticket commit contains no unrelated user-owned files and no
  `Trae CLI co-author attribution` trailer.
- Do not install, restart, push, open a pull request, or publish an external
  ticket without separate authorization.
