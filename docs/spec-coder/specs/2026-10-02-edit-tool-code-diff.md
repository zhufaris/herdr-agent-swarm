# Edit Tool Code Diff Specification

## Problem Statement

The shared Answer timeline already recognizes `apply_patch` activity as an
Edit tool and shows the affected file names plus added/removed line counts.
However, the patch body is discarded during transcript projection, so expanding
the Edit panel cannot show what changed. A manually constructed timeline item
can place patch text in `command`, but that labels the content as a Bash command
and is not the runtime contract.

The desired behavior is to show the code diff carried by the exact Edit tool
call in both Primary Answer and Worker Task cards. It must not inspect the live
working tree because that could mix unrelated edits or drift from the recorded
tool call.

## Solution

Add an optional, semantically distinct `diff` field to the shared Answer
timeline Edit item. Extract an unambiguous `apply_patch` payload at the
transcript adapter boundary, redact it before it can enter durable projection
state, bound it through the existing transcript limits, and render it inside the
Edit panel as `**Diff**` followed by a `diff` fenced block.

The change applies to direct `apply_patch` calls and Code Mode wrappers that
contain one attributable patch. Existing Edit summaries, state, grouping,
pagination, CardKit limits, and Primary/Worker shells remain unchanged. If a
patch is missing, malformed, or ambiguous, the timeline retains the current
summary-only behavior.

## User Stories

- **SCN-1 — Inspect one edit:** When a recorded `apply_patch` changes one or
  more files, a Feishu user can expand its Edit tool row and see the sanitized
  unified patch in source order.
- **SCN-2 — Shared surfaces:** The same Edit item renders identically in a
  Primary Answer timeline and a Worker Task timeline because both consume the
  shared renderer.
- **SCN-3 — Safe bounded detail:** A patch containing a recognized secret or
  exceeding display limits is redacted and/or truncated without exposing the
  unsafe remainder or exceeding CardKit payload constraints.
- **SCN-4 — Fail closed:** A non-`apply_patch` Edit, malformed payload, or Code
  Mode wrapper with multiple patches that cannot be attributed reliably keeps
  its existing Edit summary and omits diff detail.
- **SCN-5 — Historical compatibility:** Persisted timeline items without the
  optional field continue to render exactly as before.

## Implementation Decisions

### Domain Model

The affected bounded context is Conversation Projection. Its persisted
`AnswerTimelineItem` is authoritative for what a historical Answer or Worker
Task card may render. An Edit tool's `diff` means the sanitized patch text
supplied by that exact tool invocation; it does not mean the repository's
current diff.

The proposed model change is one optional immutable DTO field,
`AnswerTimelineItem.diff`. No new entity, aggregate, domain service, state
transition, or database table is justified for this display-only capability.

- **INV-1:** Diff content originates only from the corresponding recorded
  `apply_patch` invocation. No filesystem or Git query may synthesize it.
- **INV-2:** Uncertain attribution omits detail rather than associating one
  patch with the wrong Edit row.
- **INV-3:** Diff extraction and rendering do not affect tool identity, order,
  parent/child grouping, execution state, or success/failure classification.
- **INV-4:** Secret redaction occurs before the diff crosses into timeline
  projection state; rendering applies defense-in-depth redaction and limits.
- **INV-5:** Absence of `diff` remains valid for historical and non-patch Edit
  items.

### Architecture

`src/runtime/tool-activity-projector.ts` owns external tool-argument
interpretation. It will expose the extracted safe patch as optional data on the
existing projected tool-call descriptor. Direct and nested Code Mode parsing
share this implementation. One unambiguous patch is accepted; ambiguous
multiple-patch input returns no diff.

`HerdrEventProjector` and `TraexTranscriptProjector` remain the adapter-to-domain
translation seams. They copy only bounded safe diff text into the optional
domain DTO field. No CardKit type or renderer is imported by these adapters or
the domain.

`src/cards/answer-tool-render-ports.ts` maps the optional domain field into the
existing render model. `src/cards/answer-timeline.ts` owns presentation and
renders Edit detail as `**Diff**` plus a `diff` fence. It continues to apply
redaction, ANSI removal, fence escaping, truncation, and serialized payload
limits. The shared renderer supplies both Primary and Worker surfaces without
duplicated shell logic.

Source dependencies remain:

```text
external transcript -> runtime projection -> domain timeline DTO
                                           -> card render projection -> CardKit
```

No new port or composition dependency is introduced.

### Behavior & Failure Modes

Patch extraction preserves the recorded patch's file-section and hunk order.
The `*** Begin Patch` / `*** End Patch` transport envelope may be omitted from
the displayed diff, while file headers, hunk markers, and changed lines remain
visible. Display formatting never mutates the recorded tool outcome.

If extraction cannot prove one patch belongs to one Edit item, it emits no
`diff`. Existing label and line-count projection continues. If CardKit space is
insufficient, the diff is truncated with the existing explicit “view the Herdr
Pane for complete content” behavior; the card remains valid.

Projection replay uses the existing stable tool item ID and upsert semantics.
Repeated transcript observations replace the same running item with its terminal
form rather than creating duplicate Edit rows.

### Compatibility & Migration

The optional DTO field is additive and stored inside existing timeline JSON.
No SQLite schema migration or historical backfill is required. Historical rows
without `diff` use the current rendering path. Public commands, callbacks,
CardKit actions, and Agent execution contracts do not change.

## Testing Decisions

- Extend `tool-activity-projector` tests for direct and nested single-patch
  extraction, multi-file ordering, secret redaction, and ambiguous/malformed
  omission (SCN-1, SCN-3, SCN-4; INV-1, INV-2, INV-4).
- Extend Herdr Core event and TraeX transcript projector tests to prove the
  optional field crosses both adapter paths, keeps the stable tool identity and
  state, and is absent when unavailable (SCN-1, SCN-4; INV-2, INV-3).
- Extend shared Answer timeline rendering tests for `**Diff**`, a `diff` fence,
  truncation, fence escaping, and legacy summary-only items. Exercise both
  Primary and Worker card integration seams as needed to demonstrate reuse
  rather than duplicate rendering (SCN-2, SCN-3, SCN-5; INV-4, INV-5).
- Run affected Vitest files, `npm run typecheck`, `npm run build`,
  `git diff --check`, and the complete `npm test` suite before delivery.

## Out of Scope

- Running `git diff`, reading edited files, or reconstructing diffs after the
  tool call.
- Showing before/after full-file content or adding a separate diff card.
- Adding diff support for arbitrary write/edit tools whose transcript does not
  carry an attributable patch.
- Changing Edit execution, approval, tool state, pagination ownership, or
  frozen-card semantics.

## Further Notes

- Workspace mode: in place.
- Rationale: the tracked tree was clean at selection, the change is focused,
  and the known user-owned untracked paths do not overlap the target files.
- Branch: `main`.
- Starting revision: `dc4f170097900f552129fcbe67eac0c5309dcb26`.
- Initial user-owned untracked paths preserved:
  `.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- Fresh baseline: 125 tests across the five affected projector/render suites,
  `npm run typecheck`, and `npm run build` all passed on the starting revision.
- Gate 1 design approval: approved in conversation on 2026-10-02.
- Unresolved decisions or blockers: none.
