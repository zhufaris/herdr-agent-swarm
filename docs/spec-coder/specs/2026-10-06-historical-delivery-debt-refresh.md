# Historical Delivery Debt Refresh

## Problem Statement

Historical delivery-debt classification for retired `conversation-turn` lanes records a `source_updated_at` fence that includes the newest reply in the lane. When a newer reply is later added to that quarantined lane, integrity correctly treats the old classification as stale. The maintenance selector, however, decides that the old classification is still current because its anti-join compares only recovery and quarantine timestamps, not the same lane-wide source timestamp. The classification can therefore never refresh.

Live aggregate evidence after deploying `f6661cd8` showed 4,273 `outbound_prompt_reference` findings: 4,111 dismissed rows and 162 pending rows in retired conversation-turn lanes. All 162 pending rows had historical classifications whose `source_updated_at` predated the newer lane reply; none lacked a classification or recovery row.

## Solution

Use one authoritative delivery-recovery revision definition for candidate projection and stale-classification selection. Candidate rows persist the lane-wide maximum timestamp. The freshness anti-join compares recovery/quarantine timestamps and uses an indexable, short-circuiting `NOT EXISTS` check for any lane reply newer than the persisted fence. When a retired conversation-turn lane advances, the old classification becomes eligible, maintenance rewrites its historical fence to the lane maximum, and integrity can again recognize every covered row as historical.

## User Stories

- **SCN-1 — Lane advancement:** a retired conversation-turn lane is classified historical, then receives a newer sibling reply; integrity temporarily reports the stale reference until maintenance refreshes the classification.
- **SCN-2 — Refresh convergence:** the next bounded maintenance pass refreshes the same classification and integrity no longer reports any rows covered by that lane.
- **SCN-3 — Safety:** refreshing the fence does not delete replies, release quarantine, settle unresolved recovery, execute delivery, or change current non-retired prompt-orphan findings.

## Implementation Decisions

### Domain Model

Historical delivery-debt classification is a projection fence over its source evidence. For a retired conversation-turn recovery, the source revision is the maximum of recovery, active quarantine, and every reply timestamp in the quarantined lane.

**INV-1:** the selector and persisted `source_updated_at` must use equivalent revision semantics; otherwise a stale classification can be mistaken for current. Freshness selection must not recompute the lane-wide aggregate for every joined recovery row.

**INV-2:** maintenance remains bounded and idempotent. Re-running without newer evidence produces no candidate; newer evidence refreshes the same `(debt_kind, debt_id)` row through the existing conflict update.

**INV-3:** classification is metadata only. It must not manufacture delivery success or mutate effect certainty.

### Architecture

`SqliteOutboxRetentionStore` remains the owner. A SQL expression inside that module defines the persisted delivery-recovery source revision. Its lane-wide maximum and the `delivery_debt_classifications` anti-join both enumerate the complete reply-state domain and force the existing `(state, lane_key, delivery_order)` index, so each operation is bounded to the target lane. The anti-join applies equivalent recovery/quarantine fences plus `NOT EXISTS` newer-lane-reply semantics. No schema or public interface changes are required.

### Behavior & Failure Modes

- A stale historical classification is selected even when recovery/quarantine rows themselves did not change but a lane sibling did.
- The existing unresolved-recovery check and `ON CONFLICT` update refresh the fence atomically in the current transaction.
- Current prompt orphans and classifications for non-retired debt retain their existing semantics.

### Compatibility & Migration

No migration is required. Existing stale rows converge during ordinary startup/hourly retention maintenance after deployment.

## Testing Decisions

Extend the SQLite store integration seam with a retired conversation-turn recovery that is classified, receives a later pending lane reply, becomes visible to integrity, and is cleared by a second maintenance pass. Assert the quarantine remains active, recovery remains unresolved, both replies remain present, and no delivery state is invented. Preserve the existing true-orphan integrity tests. Run focused store tests, typecheck, build, full suite, and live aggregate verification.

## Out of Scope

- Deleting or manually repairing production history.
- Releasing quarantines or replaying delivery.
- Changing the retention window or treating current prompt orphans as historical.
- Resolving the two canonical recovery ambiguities.

## Further Notes

- Workspace: in-place `/workspace/herdr-agent-swarm` on `main`.
- Starting revision: `f6661cd86086278bfc6812d681e943495389f01e`.
- Pre-existing user changes preserved: modified `TODO.md`; untracked `docs/research/2026-10-02-session-message-jsonl-dependencies.md`, `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and `handoff.md`.
- Fresh baseline: 274 files / 3,961 tests passed; typecheck and build passed; the same commit is live with matching build identity.
- The user authorized continued autonomous optimization, testing, commits, installation, restart, and live verification without per-step confirmation.
