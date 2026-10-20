# Feishu Event Visibility and Mutable Action Cards Plan

Approved specification: [2026-10-03-feishu-event-visibility-and-action-cards.md](../specs/2026-10-03-feishu-event-visibility-and-action-cards.md)

## Workspace and authorization

- Swarm workspace: `/workspace/herdr-agent-swarm`, in-place on `main`, starting revision `77fbac62154b87c80bdd84ebeb8ebdc4db0c1b24`.
- Core workspace: `/tmp/herdr-core-feishu-event-summary`, isolated branch `feat/feishu-event-summary`, starting revision `7df83467c34cd1a3457739233a49cc21c4da384d`.
- Initial user-owned changes remain excluded: Swarm `TODO.md`, `.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`, `docs/research/`, `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and `handoff.md`; Core's original-checkout `src/agent_events/journal.rs` and isolated `.zig-cache/`.
- Baseline: Swarm `npm test` passed 254 files and 3,662 tests. Core `cargo test --locked -p herdr agent_events::codec` passed 14 tests with the verified Zig 0.16.0 toolchain under `/tmp`.
- Gate 1, Gate 2, and Gate 3 implementation authorization were approved on 2026-10-03. Deployment, push, PR creation, unrelated worktree deletion, and inclusion of the separate Core journal repair remain excluded.

## Tickets

- [x] T1: Emit privacy-bounded reasoning and sub-agent lifecycle events from Core
  - **What to build:** Extend the native transcript normalizer so qualifying reasoning emits only its first safe bold Markdown heading, and supported collaboration events emit an additive bounded `agent_activity` payload. Preserve final-message identity and checkpoint recovery.
  - **Spec references:** SCN-1, SCN-3, SCN-10; INV-6; Core codec and compatibility decisions.
  - **Ownership and implementation path:** Native Event Normalization owns provider JSON parsing and safe-field selection. Update Core API schema and codec only in `/tmp/herdr-core-feishu-event-summary`; keep Swarm/Lark concepts out. The reasoning helper redacts, normalizes, and caps at 160 characters. Agent activity uses stable ID, safe label, closed state, turn/time metadata, and retains only bounded correlation state.
  - **Acceptance criteria and verification:** Codec/schema tests demonstrate heading/no-heading/redaction/length cases; reasoning does not mutate `last_message`; lifecycle start/running/completed/failed/interrupted/blocked maps deterministically; duplicate/checkpoint recovery remains stable; prompt, reasoning prose, result prose, internal messages, and absolute paths are absent. Run focused Core tests, formatting/lint checks used by the repository, and a Core build/check.
  - **Blocked by:** None.

- [x] T2: Project reasoning, waits, and agent lifecycle onto the correct Swarm surfaces
  - **What to build:** Accept additive Core events and split status visibility from Answer visibility. Show safe reasoning summaries in Answer, coalesce Wait and normal Agent lifecycle in status, and add only failed/interrupted/blocked Agent activity to Answer. Persist bounded owner-scoped `request_user_input` candidates for later Human Review episode absorption.
  - **Spec references:** SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-10; INV-5, INV-6; Swarm event-projection and pre-block-candidate decisions.
  - **Ownership and implementation path:** Conversation Projection owns visibility and stable item keys; Human Review projection owns candidate persistence. Extend normalized Herdr schemas/readers, event projector, reducers/views, and SQLite migration/store seams. Keep coordinators transport-free and preserve old-stream behavior. Candidates are keyed by fenced owner plus source event, bounded/redacted, absorbed atomically on matching episode open, never emit a card alone, and expire under bounded retention.
  - **Acceptance criteria and verification:** Protocol/projector tests cover old and new events; tool tests separately prove status versus Answer policies; repeated wait/agent events upsert stable items; normal Agent states never enter Answer; failure states do; reasoning has summary/hidden behavior only. Store tests prove candidate dedupe, bounded retention, match absorption, unmatched no-card behavior, restart round trip, and no Prompt mutation. Run affected Vitest modules, typecheck, and build.
  - **Blocked by:** T1 for the finalized cross-repository event contract. Candidate persistence can be developed only after the contract is fixed because its source identity and owner fields are contract inputs.

- [x] T3: Make each Primary Human Review episode one durable mutable action card
  - **What to build:** Replace Primary's create-plus-resolution notifications with one durable action-card surface per episode generation. Supplements update that card; resolution changes it to `已处理` without another mention or card.
  - **Spec references:** SCN-4, SCN-5, SCN-6, SCN-7; INV-1 through INV-5; Human Review projection and delivery consistency decisions.
  - **Ownership and implementation path:** Primary lifecycle remains in the binding projection owner. Shared Human Review surface helpers own snapshot revision, create/update choice, target checkpoint, and render DTO. Extend the existing Primary episode persistence and outbox projection identity/version. Episode state, snapshot version, and outbox intent change in one SQLite transaction; only a checkpointed target receives updates.
  - **Acceptance criteria and verification:** Store/integration tests prove one open episode, one initial mention, duplicate blocked observations are no-ops, absorbed and later supplements update the same snapshot, pending-create supersession avoids pre-create update, delivered identity survives restart, resolution updates the same target without mention, stale supplements cannot reopen, and uncertain delivery cannot duplicate. Card tests prove bounded/redacted content and safe identity. Run affected store, coordinator, publisher/outbox, card tests, typecheck, and build.
  - **Blocked by:** T2, which supplies the bounded supplement candidate contract used when `request_user_input` precedes blocked state.

- [x] T4: Give Worker Human Review the same mutable surface and replacement recovery
  - **What to build:** Add Worker episode persistence while preserving Worker lifecycle ownership, use the shared mutable action-card surface, and replace a permanently invalid open-episode target exactly once per generation without replaying work.
  - **Spec references:** SCN-4 through SCN-8, SCN-10; INV-1 through INV-5; Worker compatibility and expired-target recovery decisions.
  - **Ownership and implementation path:** Worker Turn lifecycle decides episode open/resolve. The shared surface projection/store owns generation and delivery convergence; outbox settlement owns target checkpoint and permanent-target classification. Replacement retires the prior generation and atomically reserves one new mention create only while the episode is open. No recovery path imports or invokes prompt/turn submission.
  - **Acceptance criteria and verification:** Worker store/supervisor tests cover open, duplicate, supplement, resolve, restart, and Primary/Worker ownership separation. Publisher/outbox tests cover create-before-update, newer snapshot convergence after create, uncertain-effect quarantine, one expired/defunct replacement, duplicate recovery idempotency, resolved-episode no replacement, and unchanged Prompt/Turn delivery state. Run affected Vitest modules, typecheck, and build.
  - **Blocked by:** T3 for the shared surface persistence and delivery contract.

- [x] T5: Raise the default Answer page size to 21,000 characters
  - **What to build:** Change only the generated/runtime default from 10,500 to 21,000 while retaining explicit overrides, the 28,000 stream ceiling, canonical source offsets, and frozen-page behavior.
  - **Spec references:** SCN-9, SCN-10; INV-7; configuration and pagination decisions.
  - **Ownership and implementation path:** Runtime configuration owns the default and validation; Answer page workflow remains the existing render-only consumer. No durable source offsets or stored page content are rewritten.
  - **Acceptance criteria and verification:** Config/setup tests assert 21,000 default and explicit override preservation; invalid values above stream limit still fail; pagination tests assert the 21,000 boundary, continuation offsets, and immutable frozen pages. Run focused config/setup/answer tests, typecheck, and build.
  - **Blocked by:** None.

## Coverage and dependency review

- SCN-1: T1, T2. SCN-2: T2. SCN-3: T1, T2. SCN-4 and SCN-5: T2, T3, T4. SCN-6 and SCN-7: T3, T4. SCN-8: T4. SCN-9: T5. SCN-10: T1, T2, T4, T5.
- INV-1 through INV-4: T3 and T4. INV-5: T2 through T4. INV-6: T1 and T2. INV-7: T5.
- Blocking graph is acyclic: `T1 -> T2 -> T3 -> T4`; T5 is independent. Each ticket delivers an observable, independently green increment and fits one implementation context.
- No load-bearing product, persistence, or recovery decision remains unresolved. Cross-repository compatibility requires Swarm to be deployed before Core, but deployment is outside this plan's current authorization.

## Final delivery checks

- Reconcile every scenario/invariant above to committed test evidence and inspect dependency direction, boundary DTOs, composition assembly, SQLite atomicity, and outbox recovery semantics.
- Run Core focused/full applicable verification with the pinned Zig toolchain and Swarm affected tests, `npm run typecheck`, `npm run build`, and `npm test` freshly.
- Inspect both repository diffs and commit ranges. Confirm every ticket has one scoped Conventional Commit, excludes user-owned/generated paths, and contains no `Trae CLI co-author attribution` trailer.
- Do not push, open a PR, install, restart, deploy, or merge the separate Core journal repair without new explicit authorization.
