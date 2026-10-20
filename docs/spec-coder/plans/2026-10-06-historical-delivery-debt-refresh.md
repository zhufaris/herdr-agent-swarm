# Historical Delivery Debt Refresh Plan

Specification: `docs/spec-coder/specs/2026-10-06-historical-delivery-debt-refresh.md`

Workspace: in-place on `main` at `/workspace/herdr-agent-swarm`, starting from `f6661cd86086278bfc6812d681e943495389f01e`. The user-owned modified/untracked files named in the specification are excluded. The starting revision passed 3,961 tests, typecheck, and build and is deployed.

- [x] **T1: Refresh historical classification after retired lane advancement**
  - **What to build:** make stale-selection use the same lane-wide source revision that is persisted, so a later reply triggers one bounded idempotent classification refresh.
  - **Spec references:** SCN-1, SCN-2, SCN-3; INV-1, INV-2, INV-3.
  - **Ownership and implementation path:** keep the rule in `SqliteOutboxRetentionStore`; use the existing state-leading lane index for both the persisted lane maximum and the equivalent newer-reply freshness check; preserve the existing transaction, unresolved-recovery guard, and conflict update. No schema, dispatcher, or delivery executor change.
  - **Acceptance criteria and verification:** a Red-Green SQLite integration test proves stale detection and refresh while quarantine remains active, recovery unresolved, and replies untouched. Run focused SQLite tests, typecheck, build, complete-diff review, and one atomic Conventional Commit.
  - **Blocked by:** None.

## Final Delivery Checks

- [ ] Standards/spec review has no unresolved finding.
- [ ] Full suite, typecheck, and build pass freshly.
- [ ] Immutable install and supported restart succeed.
- [ ] Live `outbound_prompt_reference` count converges without manual data mutation or replay.
