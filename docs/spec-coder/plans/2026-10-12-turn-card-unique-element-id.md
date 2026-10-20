# Turn Card Unique Element ID Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification:
`docs/spec-coder/specs/2026-10-12-turn-card-unique-element-id.md`

Workspace: `/tmp/herdr-agent-swarm-main-merge-20261012`, branch
`fix/turn-card-duplicate-element-id`, starting revision
`3c342d930e4ff817746b17d759bffa7ababfc23c`. The workspace was clean before
planning and has no unrelated changes. The user approved the bounded design and
approved the written specification at Gate 2 on 2026-10-12.

Fresh baseline:

- `npx vitest run tests/turn-card.test.ts tests/gateway-view.test.ts` passed
  2 files / 37 tests.
- `npm run typecheck` passed.

No authority is granted for unrelated latency work, TraeX/Core changes, push,
deployment, restart, or external publication.

## Wave W1: `T1`

### - [x] T1: Bind the page element ID to one Turn Card markdown node

| Field | Content |
| --- | --- |
| What to build | Make Primary Turn Card recursive element-ID attachment stop after the first markdown across the whole rendered tree, preserving every timeline item and producing one unambiguous CardKit update target. |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-2, ARCH-1, ARCH-2 |
| Dependencies | None |
| Delegation eligibility | Eligible: one deterministic pure-rendering defect, fixed literals, an existing correct Worker Turn Card precedent, and public render/materialization test seams. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Turn Card rendering owns recursive identity attachment; the existing `renderTurnCard` interface remains unchanged, and the Feishu adapter continues translating the single Gateway `slot` to CardKit `element_id`. |
| Mutation ownership | src/cards/turn-card.ts, tests/turn-card.test.ts, tests/gateway-view.test.ts |
| Exclusions | Segment and outbox persistence, pagination policy, canonical item deduplication, worker cards, choice-list and mention behavior, latency optimization, TraeX, Herdr Core, install, restart, deploy, push |
| Isolation | Serial mutation in the prepared fix branch at `3c342d930e4ff817746b17d759bffa7ababfc23c`; no parallel writer. |
| Concurrency conflicts | None |
| Verification seam | Public `renderTurnCard` output and provider-neutral-to-CardKit materialization; count the exact page ID recursively and preserve nested/top-level content order. |
| Host capacity | One direct-child slot; recheck live capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; worker may not spawn, stage, commit, merge, install, restart, deploy, push, or touch files outside mutation ownership. |
| Acceptance criteria and verification | Red proves nested thinking plus top-level assistant markdown currently emits the same page `element_id` twice. Green emits it exactly once in both Turn Card and materialized CardKit payloads, retains both visible contents in order, preserves top-level-only and no-markdown behavior, and passes focused tests, typecheck, build, architecture checks, full Vitest, review, and diff checks. |
| Blocked by | None |
| Verification commands | `npx vitest run tests/turn-card.test.ts tests/gateway-view.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `npm test`; `npm run docs:audit`; `npm run public:audit`; `git diff --check` |
| Verification results | Red failed with 2 duplicate IDs versus expected 1. Green and review-fix focused suites passed 2 files / 40 tests; typecheck, build and architecture checks passed; full Vitest passed 301 files / 4,643 tests; documentation and public audits passed. Gateway conversion proves one slot and materialized `element_id`; content count/order and top-level/no-markdown cases are explicit. |
| Commits | `bf7e322efade05041140ce22ef8bc49e0813e688`, `9f927905a1dfbd78420f2dad3ba4a5b241206d75` |

## Final delivery checks

- [x] Red failure demonstrates two page `element_id` occurrences through the public rendering seam.
- [x] Green focused tests prove exactly one occurrence without removing content.
- [x] Typecheck, build, architecture check and full Vitest pass freshly; independent delivery review remains before merge.
- [x] One atomic implementation commit contains only the approved source, tests, specification and plan evidence.
- [x] Merged to `main`, installed release `bb3b0a40c8dafbe4a07eeb02d0b164681859507ea3051a3e2e4637b1d2b4b457-10cd833adf25`, reached ready state, and 21 post-restart Gateway plans contained zero duplicate slots.
