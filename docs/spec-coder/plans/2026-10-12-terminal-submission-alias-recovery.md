# Terminal Submission Alias Recovery Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

- Specification: `docs/spec-coder/specs/2026-10-12-terminal-submission-alias-recovery.md`
- Workspace: `/tmp/herdr-agent-swarm-main-ring-stability-20261012`
- Mode: in-place inside the existing isolated deployment worktree; the original checkout remains untouched.
- Branch: `main`
- Starting revision: `9bc26cbb69b05a6170c85d18648bdfb86502f653`
- Initial changes: this specification and plan only.
- Baseline: 2 focused files / 135 tests and `npm run typecheck` passed.
- Authority: bounded design selected under the user's current continuation directive; one ticket and one serial wave are authorized for TDD implementation.

## Wave W1: `T1`

### - [x] T1: Recover exact terminal-turn submission aliases

| Field | Content |
| --- | --- |
| What to build | Permit a changed Human Message submission ID only when two immutable intents and durable terminal receipts prove the same exact Core turn, then atomically align the canonical event ledger and existing Segment correlation without replay or new presentation. |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, INV-4, ARCH-1 |
| Dependencies | None |
| Delegation eligibility | The production evidence, equality fence, store seams and focused Red-Green tests are grounded, bounded, reversible and independently inspectable; no credentials or operator mutation are needed. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Core Event Inbox owns terminal-turn alias evidence and canonical rebinding inside the existing ingest transaction. Conversation Segment persistence accepts correlation repair only after the canonical ledger names the incoming submission for the same Human event, preserving all presentation identity and content. |
| Mutation ownership | `src/store/sqlite/core-event-inbox-store.ts`, `src/store/sqlite/conversation-segment-store.ts`, `tests/core-event-inbox-store.test.ts`, `tests/conversation-segment-store.test.ts` |
| Exclusions | No schema, adapter, Core, production database, outbox, card renderer, service lifecycle, spec or plan mutation by the worker. No staging, commit, deployment or indirect delegation. |
| Isolation | One serial direct worker in the prepared isolated worktree; main owns integration, plan updates and commit. |
| Concurrency conflicts | None |
| Verification seam | Focused store tests exercise exact alias acceptance, monotonic newer-intent convergence with older-alias preservation, rejection on incomplete/malformed/different evidence, alias-specific atomic rollback, and stable Segment/card/outbound identity; existing generic conflict tests remain green. |
| Host capacity | One direct-child slot; main rechecks live capacity before dispatch and validates all returned changes. |
| Direct-child boundary | `delegation_allowed = false`; the child must not spawn, stage, commit, deploy, edit artifacts or touch production state. |
| Acceptance criteria and verification | Exact same-turn terminal aliases converge monotonically to the newer immutable intent and advance ingestion; older/equal aliases settle as ignored duplicates; any evidence mismatch remains fail-closed; an existing Segment changes only correlation; no Input is replayed and no new Lark effect is reserved. Run `npx vitest run tests/core-event-inbox-store.test.ts tests/conversation-segment-store.test.ts`, `npm run typecheck`, `npm run build`, and `npm run architecture:check`. |
| Verification commands | `npx vitest run tests/core-event-inbox-store.test.ts tests/conversation-segment-store.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check` |
| Verification results | Main observed final repair exit 0: 2 focused files / 144 tests passed; typecheck, build, architecture imports and docs audit passed. Coverage proves newer-alias convergence, older/equal replay preservation as an ignored lane item, malformed immutable intent creation time rejection, alias-specific rollback, and stable Segment/page/card/timeline/outbound identity. |
| Commits | `82d790c6`, `5240c46c`, `c5b14f86`, `9ebd8387`, `ed67d9ce` |
| Blocked by | None |

## Final delivery checks

Main inspects the complete diff and commit, runs independent Standards and Spec
reviews, the focused tests, complete Vitest suite, typecheck, build,
architecture check, docs audit and delivery artifact checker. Installation and
force restart remain separately authorized operator actions. Live verification
must show the target build, checkpoint advancement, recovered Agent Input
readiness and unchanged terminal Submission Intent attempt evidence.
