<!-- spec-coder:artifact-v1 spec -->

# Minimal Compatible Choice Fence

## Problem Statement

Trae JSONL records an assistant response as a generic typed `message` whose
`output_text` content is one Markdown string.  That string may contain ordinary
`json` examples as well as the actual terminal `herdr-choice-list` protocol.
The JSONL is immutable and is not a safe place to repair or rewrite the
response.  A response such as `msg_62370` can therefore show a valid-looking
v3 example in prose while its actual terminal protocol is `{"version":3}`.

The Swarm already has the correct compatibility boundary: native Core
`completion_choice` metadata is authoritative; text parsing is only a bounded
fallback and recognizes the dedicated terminal fence.  This change makes that
boundary explicit to the producer and locks the observed mixed-message shape
with a regression test.  It must not change Core JSONL, the Core event schema,
SQLite, CardKit rendering, or native metadata precedence.

## Solution

1. Keep `message`/`output_text` and the existing Core JSONL unchanged.
2. Treat only one exact terminal `herdr-choice-list` fence as compatibility
   protocol.  Ordinary `json`/`text` fences and prose examples are visible
   answer content and never candidates.
3. Preserve existing fail-closed behavior for a missing, duplicate,
   non-terminal, malformed, or nested protocol fence.
4. Preserve native typed `completion_choice` precedence over text recovery.
5. Strengthen producer guidance in the owned Skill and Stop/submit Hook context:
   emit one terminal protocol fence and do not include other choice-shaped JSON
   examples in the final answer.

## User Stories

### SCN-1: Mixed ordinary examples do not become a choice

Given one assistant `output_text` containing a valid-looking ordinary `json`
example, an invalid-looking ordinary `json` example, and a terminal
`herdr-choice-list` fence with `{"version":3}`, recovery returns valid v3
`intent=none` and no `ChoicePrompt`.

### SCN-2: The terminal dedicated fence is authoritative for text fallback

Given ordinary examples followed by one terminal dedicated fence containing a
valid nested v3 choice, recovery returns that choice and ignores the examples.

### SCN-3: Native metadata remains authoritative

Given a native `completion_choice` and a later text fence with another choice,
the native choice remains selected and the source remains `native`.

### SCN-4: Invalid fence structures fail closed

Duplicate, nested, non-terminal, malformed, oversized, or unterminated
dedicated fences do not produce a choice.  No arbitrary JSON search is added.

### INV-1: No JSONL mutation

No implementation path rewrites, annotates, or repairs the source JSONL.

### INV-2: One protocol boundary

Only the exact dedicated fence is a transport protocol.  The first or last
JSON-looking object in ordinary Markdown is never selected heuristically.

### INV-3: Native-before-compatibility precedence

Typed native metadata wins over all text compatibility evidence.

## Implementation Decisions

- `src/domain/completion-choice.ts` and
  `src/domain/final-trace-envelope.ts` remain the compatibility parser owners;
  no parser redesign or Core schema change is in scope.
- `src/runtime/herdr-events/event-projector.ts` remains the native-versus-text
  precedence owner.
- `src/runtime/completion-choice-hook.ts` and
  `plugins/herdr-choice-list/skills/herdr-choice-list/SKILL.md` own producer
  guidance.
- `tests/completion-choice-protocol.test.ts`,
  `tests/final-trace-envelope.test.ts`,
  `tests/herdr-event-projector.test.ts`, and
  `tests/completion-choice-hook.test.ts` provide the focused seams.

## Testing Decisions

Use the existing parser/projector seams and add the observed mixed-message
fixture before any implementation change:

- ordinary `json` examples containing valid-looking and invalid-looking choice
  objects remain visible and do not become protocol candidates;
- a terminal dedicated fence with `{"version":3}` yields valid v3 none and no
  `ChoicePrompt`;
- a terminal dedicated fence with nested v3 choice yields the nested choice;
- native metadata wins over a later text fence;
- duplicate, nested, non-terminal and malformed dedicated fences remain
  fail-closed;
- Skill and Hook guidance contain the single-fence rule.

Run the focused choice/projector suites, typecheck, build, architecture check,
diff check, and then the full Vitest suite during delivery.

## Out of Scope

- Any Core JSONL rewrite or Core event schema change.
- Any SQLite migration or production database repair.
- Any CardKit renderer or Feishu delivery change.
- Any installation, restart, deployment, live message, or push.
- Inferring a choice from ordinary prose or arbitrary JSON.

## Further Notes

The implementation is intentionally limited to producer guidance and regression
coverage because the existing parser already enforces the dedicated terminal
fence and native metadata precedence.

## Baseline and Workspace Evidence

Workspace: existing isolated worktree, used serially.

Authoritative workspace:
`<repo-root>/.trae/worktrees/fix-ring-delivery-recovery`

Branch: `fix/ring-delivery-recovery`

Starting revision: `d73277fe84ad850b6390875275b994eefa69d3a`

Initial changes: none; worktree was clean.

Fresh baseline for request `01a158af-e8fe-7113-90a0-cb4ae602f60e-fence`:

- focused choice/projector suites: 3 files / 110 tests passed;
  capture `d916dee990fe4215b3c2563ab04cb20d`;
- `npm run typecheck`: passed; capture `f8f16713b695434ab4bae147c459b50f`;
- `npm run build`: passed; capture `ee469b12d333450fb2908c04581dfbfa`;
- Node `v24.14.1`, npm `11.11.0`, Python `3.12.13`;
- existing `node_modules`, no dependency installation, external state `none`;
- build cache:
  `<repo-root>/.cache/fix/ring-delivery-recovery/target`.

Gate 1 decision: adopt the minimal compatible dedicated-fence scheme while
preserving native typed metadata precedence and all existing fail-closed parser
behavior.  Gate 2 specification approval and Gate 3 implementation
authorization remain required.  No product files have been changed by this
specification.
