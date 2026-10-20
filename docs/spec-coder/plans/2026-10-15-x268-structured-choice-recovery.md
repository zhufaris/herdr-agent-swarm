# X268 structured choice recovery implementation plan

<!-- spec-coder:artifact-v1 plan -->

## Scope and workspace

Implement the approved specification
`docs/spec-coder/specs/2026-10-15-x268-structured-choice-recovery.md` in the
existing isolated worktree at base `05626232ed5d53346e9d9d92f6a088d43211aaf4`.
The task is one bounded vertical ticket because protocol validation and the
turn-local projector state form one atomic behavior seam.

## Wave W1: `T1`

### - [x] T1: Recover structured choice metadata across commentary and final

| Field | Content |
| --- | --- |
| What to build | Convert one valid v2 trace-end Human Review into `FinalMessageCompletionChoice` at the protocol boundary; retain it within the current `HerdrEventProjector` turn; apply native/current-message/prior-commentary precedence; clear on intent-none and new turn. |
| Spec references | SCN-1, SCN-2, SCN-3 |
| Dependencies | None |
| Delegation eligibility | Bounded pure protocol/projector change with deterministic unit-test seam. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `src/domain/completion-choice.ts`, `src/runtime/herdr-events/event-projector.ts`, and their focused tests. Keep persistence/rendering consumers unchanged. |
| Mutation ownership | src/domain/completion-choice.ts, src/runtime/herdr-events/event-projector.ts, tests/completion-choice-protocol.test.ts, tests/herdr-event-projector.test.ts |
| Exclusions | Feishu renderer, CardKit layout, mention rules, plugin installation, schema/data migration, historical x268 repair, deployment. |
| Isolation | Existing clean isolated worktree; serial mutation only. |
| Concurrency conflicts | None |
| Verification seam | Exact x268 event-sequence projector test plus protocol conversion/precedence/clearing unit tests. |
| Host capacity | Main-local or one direct worker; live capacity rechecked. |
| Direct-child boundary | `delegation_allowed = false`; no delegation, staging, commits, plan edits, installation or deployment by child. |
| Acceptance criteria and verification | Commentary fenced v2 choice plus marker-only final produces one structured completion choice and clean visible Markdown; native final metadata wins; valid intent-none and new turn clear stale choice; ordinary/invalid commentary creates no choice; focused tests, typecheck, build, architecture check and full suite pass. |
| Verification commands | `npx vitest run tests/completion-choice-protocol.test.ts tests/herdr-event-projector.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Exact x268 Red reproduced before implementation; Green passed 2 files / 62 tests. Typecheck, build (`sha256:9aff7e676e5d2515b0ed90acd7eee7a882f47d1379bc9b0c65eb31ab0a1554a6`), architecture check (544 files), and diff check passed. |
| Commits | `50864693` |

## Final delivery checks

Main integrates one atomic implementation commit, records verification evidence,
and runs the focused choice/projector suites, `npm run typecheck`,
`npm run build`, `npm run architecture:check`, `npm test`, artifact delivery
checking, and `git diff --check`. No merge, install or restart is authorized by
this plan.

## Delivery repair evidence

| Commit | Repair | Focused evidence |
| --- | --- | --- |
| `aadbcf13` | Capture eligible protocol metadata before status projection can return; reject text-derived Human Review and intent-none changes when the Core message is truncated while retaining native struct authority. | Choice/projector suites: 64/64 passed; typecheck, build (`sha256:a74679bf3e1bf4c2fc32b5387df486f1fd83e031be7aeb08a46a209fb831b5dd`), architecture check and diff check passed. |
| `89cacbf2` | Restrict text-derived choice recovery to `commentary` and `final`; status, system and progress telemetry remain non-authoritative even when they contain valid-looking protocol text. | Choice/projector suites: 67/67 passed; typecheck, build (`sha256:d620d832fa53bcff8c10a5fa0a34d08a6d2bbe82511e138789e1c93f3e9b025c`), architecture check and diff check passed. |
