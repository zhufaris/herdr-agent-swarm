# Tool Call Card Information Hierarchy

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Answer Timeline Tool Call cards currently derive their visible summary from the
legacy `label` and sometimes re-parse command text in the renderer. This makes
the action, target, and terminal outcome difficult to scan, and makes card
policy depend on presentation-time inference rather than canonical projected
semantics.

## Solution

Extend durable Tool Timeline items with optional `action`, `target`, and
`resultSummary` fields. Project those fields at the Core/TraeX boundary,
persist them in the existing timeline JSON, and render them consistently on
Primary and Worker Answer Timelines. Normal running and successful calls render
as one compact row. Failed and explicitly timed-out calls render as expanded
diagnostic panels. Historical JSON without the new fields remains renderable
through a deterministic legacy fallback.

## User Stories

### SCN-1: A reader scans an ordinary Tool Call

When a Tool Call is running or succeeds, the Answer Timeline shows its category,
action, and target on one compact line without exposing ordinary result output.

### SCN-2: A reader investigates a failed or timed-out Tool Call

When a Tool Result is a failure or a structured timeout, the Timeline expands a
diagnostic panel with a bounded, redacted outcome summary and available command,
result, or diff detail.

### SCN-3: A nested Code Mode batch fails

When any nested Tool Call fails or times out, its aggregate parent renders as an
expanded diagnostic group while retaining each child's projected action and
target.

### SCN-4: A saved timeline is reloaded

When SQLite reloads current timeline JSON after restart, new semantic fields
retain their exact values. Historical Tool items without those fields render
through the legacy label/command fallback and are not rewritten.

## Implementation Decisions

### INV-1: Tool presentation semantics are durable optional values

The Tool Timeline variant gains optional `action`, `target`, and
`resultSummary` values. `resultSummary` has bounded display text and an outcome
of `success`, `failure`, or `timeout`. Existing `label`, `command`, `result`,
`resultPreview`, and `diff` remain durable evidence and are neither removed nor
reinterpreted.

### INV-2: The activity projector owns semantic normalization

`tool-activity-projector` maps recognized calls to an action and target exactly
once. TraeX transcript and Herdr event projectors consume that descriptor and
write it to their Tool Timeline deltas. Card renderers consume the stored fields
and must not parse legacy labels or command text when a semantic value exists.

### INV-3: Timeout requires structured evidence

An outcome is `timeout` only for an explicit structured timeout signal, such as
`timed_out: true`, a recognized timeout status/code, or an adapter-proven timeout
error. A free-text result containing the word “timeout” is not sufficient.
`isError`, a non-zero exit code, or an explicit error remains `failure`.

### INV-4: Card policy is uniform across Primary and Worker timelines

Running and succeeded items render a single Markdown row containing icon,
category/action, target, and state. Failed items use a red expanded panel;
timeouts use an orange expanded panel. Both show `resultSummary` before bounded
redacted command/result/diff detail. A grouped parent expands when one of its
children has a failure or timeout outcome.

### INV-5: JSON compatibility and frozen-page immutability are preserved

Timeline JSON is the persistence boundary, so adding optional fields needs no
SQLite column migration and no historical backfill. Legacy JSON uses a stable
fallback derived from its existing label and command. Frozen Answer pages are
not patched; new rendering is applied only to active pages and future pages.

### ARCH-1: Domain, projection, and presentation retain their boundaries

`src/domain/answer-timeline.ts` owns the durable Tool Timeline contract.
`src/runtime/tool-activity-projector.ts` owns untrusted Tool Call/Result
normalization. Transcript and Herdr event projectors translate normalized data
into domain deltas. `src/cards/answer-tool-render-ports.ts` and
`src/cards/answer-timeline.ts` own CardKit-only display decisions. SQLite stores
opaque canonical JSON and does not construct display semantics.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, SCN-4, INV-1, INV-2, INV-3, INV-4, INV-5, ARCH-1

- Add table-driven projector tests for action/target extraction and structured
  success, failure, and timeout summaries, including redaction and bounded
  text.
- Extend TraeX and Herdr event projector tests to assert the semantic fields on
  both call and result timeline deltas.
- Extend render-port and timeline-page tests to prove compact running/success
  rows, expanded failure/timeout panels, nested aggregate escalation, payload
  limits, and absence of ordinary successful output.
- Add SQLite-backed reload coverage proving new JSON round-trips and old JSON
  uses the fallback without mutation.
- Run the focused Tool Timeline suites, `npm run typecheck`, `npm run build`,
  relevant architecture checks, `git diff --check`, and the full Vitest suite
  before delivery.

## Out of Scope

- Changes to Core event ordering, ingestion cursors, submission semantics,
  outbox delivery, or Feishu CardKit transport.
- Rewriting historical timeline rows, patching frozen Answer pages, or a
  database-column migration for timeline JSON.
- Showing successful Tool Result bodies by default, or adding a generic
  expand/collapse interaction surface.
- Deployment, restart, installation, push, or production database mutation.

## Further Notes

Workspace: `./.worktrees/feat/tool-call-card-hierarchy`.
Mode: newly allocated isolated Git worktree, to preserve unrelated untracked
files in the main checkout. Branch: `feat/tool-call-card-hierarchy`. Recorded
base: `bb3b3d397d05f095e1f8f481c72dc49e7cbe93a9`. Initial changes: none.

Gate 1 approved the domain-model approach: semantic fields are projected once,
persisted as optional JSON, and rendered without changing canonical event or
page-freezing semantics.

Fresh baseline evidence for this uninterrupted request:

| Command | Result | Record |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | `7b674f6228174ee8bee72dabadad9e75` |
| `npx vitest run tests/tool-activity-projector.test.ts tests/answer-tool-render-ports.test.ts tests/traex-transcript-projector.test.ts tests/herdr-events-reader.test.ts tests/answer-timeline-page.test.ts` | 5 files / 155 tests passed | `1f4328fec4434d10b474825e7d93b457` |

The exact verification-capture records were observed in this request with the
same future artifact path, request identity, dependency observation, and
build-cache reservation; they must be retained when this specification is
updated for planning reuse.
