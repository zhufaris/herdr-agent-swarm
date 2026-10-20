# Native Final Mention Signal Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification:
[Native Final Mention Signal](../specs/2026-10-14-native-final-mention-signal.md).

Gate 1 approved the domain-projection design and Gate 2 approved the written
specification on 2026-10-14. Live actor evidence invalidated exact embedded-ID
matching; reopened Gate 1 and Gate 2 approved treating the native ID as
non-authoritative syntax while keeping Submission Intent as the sole actor
authority. Revised implementation is not authorized until reopened Gate 3.
Installation, deployment, service restart, production data mutation, push,
pull-request creation, and external issue publication remain excluded.

Workspace: isolated Git worktree
`/tmp/herdr-agent-swarm-final-mention-signal`, branch
`fix/final-trace-mention-signal`, starting revision
`203e83758a40a5c8f67310dcde3175a60e2619a1`. The workspace had no initial
tracked or untracked changes. It was selected because the original checkout
contains unrelated user files and the deployed per-pane branch has unrelated
baseline failures and overlapping uncommitted delivery changes.

Dependencies were prepared with `npm ci` and `npm run build`. Main observed a
fresh green baseline in this uninterrupted request: build record
`f176a4fa62374b56a846f60603b20731`, full-test record
`e8e8e9681ff74adfaa60a686b86bcc2c` with 298 files and 4,459 tests,
typecheck record `d53ef43050b241558359c854896da376`, and architecture-check
record `4cd43d6362614924befa0041a6f7e3be` with 531 source files checked.

## Wave W1: `T1`

This is one serialized capability slice. It cannot be split into parser-only
and persistence-only commits without temporarily accepting an untrusted signal
that has no authoritative actor fence or adding dead code with no observable
behavior.

### - [x] T1: Accept a trusted native final mention signal

| Field | Content |
| --- | --- |
| What to build | Recognize one exact terminal native `<at id=ou_...></at>` line as a Final Request Mention signal, remove it from visible Markdown, ignore its embedded ID for recipient selection, resolve the exact Submission Intent actor as the sole notification recipient and callback authority, and reuse the existing ACK-gated completion obligation and durable outbox lifecycle. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, INV-1, INV-2, INV-3, INV-4, INV-5, ARCH-1, ARCH-2, ARCH-3, ARCH-4 |
| Dependencies | None |
| Delegation eligibility | Grounded existing TypeScript and temporary-SQLite seams; bounded and reversible behavior; no credentials, live service action, production database, or main-only authority; main can independently inspect focused Red-Green evidence and the complete diff. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Conversation Projection owns Markdown-aware request projection and Submission Intent actor resolution inside the existing Segment completion transaction. Extend the Final Request Mention domain module with a discriminated request operation that never authorizes or persists the embedded native ID; use that interface from canonical completion evidence and completion-notice persistence; leave CardKit, outbox, ACK, retry, schema, and Core ingestion interfaces unchanged. |
| Mutation ownership | src/domain/final-request-mention.ts, src/store/sqlite/conversation-segment-store.ts, tests/final-request-mention.test.ts, tests/herdr-event-projector.test.ts, tests/conversation-segment-store.test.ts, docs/spec-coder/specs/2026-10-14-native-final-mention-signal.md, docs/spec-coder/plans/2026-10-14-native-final-mention-signal.md |
| Exclusions | No raw HTML passthrough, Worker behavior, direct-Herdr owner-less notification, schema migration, Core event rewrite, Human Review option change, deployment, restart, push, or unrelated refactor. |
| Isolation | One direct worker uses the prepared isolated worktree serially at wave base `203e83758a40a5c8f67310dcde3175a60e2619a1`; no parallel mutation or additional worktree is required. |
| Concurrency conflicts | None |
| Verification seam | First demonstrate focused failure through the real temporary-SQLite Conversation Segment workflow: a syntactically valid native signal whose embedded ID differs from the Submission Intent actor must still notify only the Submission actor. Then prove visible event projection, malformed/ambiguous fail-closed behavior, forged-tag Human Review independence, duplicate projection, reopen behavior, structural imports, type safety, build output, diff hygiene, and the full suite. |
| Host capacity | One direct-child slot; main rechecks live capacity before dispatch and waits rather than mutating concurrently if no slot is available. |
| Direct-child boundary | delegation_allowed = false; main supplies the complete worker brief. The worker must not spawn, stage, commit, deploy, restart, access production state, or edit outside ticket ownership. Main owns Red acceptance, diff integration, plan checkbox update, explicit staging, verification, and the atomic commit. |
| Acceptance criteria and verification | Any syntactically valid terminal native line requests exactly one trusted completion presentation for the Submission Intent actor and disappears from visible Markdown, regardless of the embedded `ou_...` value; malformed, multiple, non-terminal, inline-code, and fenced-code candidates fail closed; `@_user_1` remains accepted as input compatibility but its literal text never appears in Answer or Turn Card output and is not required in new standard finals; a forged or stale embedded ID cannot change the recipient, valid Human Review actor, callbacks, or actions; repeated projection and database reopen remain idempotent. Run `npx vitest run tests/final-request-mention.test.ts tests/herdr-event-projector.test.ts tests/conversation-segment-store.test.ts`, `npm run typecheck`, `npm run architecture:check`, `npm run build`, `git diff --check`, and `npm test`. |
| Blocked by | None |
| Verification commands | `npx vitest run tests/final-request-mention.test.ts tests/herdr-event-projector.test.ts tests/conversation-segment-store.test.ts`; `npm test`; `npm run typecheck`; `npm run architecture:check`; `npm run build`; `git diff --check` |
| Verification results | Main observed the revised actor-authority Red fail for the intended missing obligation, then Green; 3 focused files and 93 tests passed; full suite 298 files and 4,469 tests passed; typecheck passed; architecture imports valid for 531 source files; build passed; diff check passed. |
| Commits | `cca20e8f`, `302c1763` |

Suggested atomic commit: `fix(feishu): authorize native final mention signals`.

## Final delivery checks

Main reviews the complete `203e8375..HEAD` diff against the approved
specification, verifies that raw HTML remains blocked and no delivery or schema
surface widened, and records ticket verification commands, results, and commit
after accepting the implementation.

Delivery then runs the focused suite, `npm run typecheck`, `npm run
architecture:check`, `npm run build`, `git diff --check`, and the full `npm test`
suite freshly. Independent Standards and Specification reviews report findings
before the terminal completion claim. No installation, restart, deployment, or
push is implied by successful delivery.
