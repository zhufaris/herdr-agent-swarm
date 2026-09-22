# Answer Snapshot Outbox Coalescing Plan

## Objective

Coalesce untouched revisioned Answer snapshots inside the existing projection
transaction so Lark receives only an in-flight revision and the newest desired
revision, without weakening immutable claims, recovery evidence, or lane order.

## Work packages

### 1. Characterize coalescing behavior

- Change the static Answer A -> B -> A test to require only revision 3 when all
  revisions remain untouched.
- Preserve a claimed revision 1 while requiring untouched revision 2 to be
  replaced by revision 3.
- Assert identical payload reservation remains idempotent and revision numbers
  remain monotonic after intermediate rows disappear.
- Run the focused Answer workflow test red against current behavior.

### 2. Protect immutable delivery boundaries

- Add table-driven coverage for active claims, prior attempts, card checkpoints,
  delivered, dead-lettered, and dismissed snapshots.
- Assert only `pending` rows with no claim, first claim, attempt, or checkpoint
  are eligible for deletion.
- Cover `answer_delivery_coverage` and `answer_recovery_candidates` cascading
  from an eligible deleted reply while retained evidence remains intact.

### 3. Implement transaction-local coalescing

- Keep the behavior in `SqliteProjectionStore.reserveAnswerSnapshot`.
- Read the maximum revision before deletion and derive the next revision once.
- Normalize the legacy first revision to the explicit projection key.
- Delete only eligible older rows for that exact projection key.
- Insert the new intent and allow existing delete/insert triggers to converge
  the lane head.
- Keep all mutations inside the existing reservation transaction.

### 4. Verify recovery and document authority

- Assert lane heads retain claimed/oldest ordering and select the newest revision
  when no older delivery-relevant row remains.
- Run existing uncertain-target, reopen, and recovery tests unchanged.
- Update `docs/architecture.md` with the authoritative coalescing boundary.
- Run focused tests, full Vitest, typecheck, build, architecture check, docs
  audit, public audit, and `git diff --check`.
- Review the implementation against the approved spec and repository standards.
- Archive the completed design and plan, then commit without installing,
  restarting, or pushing.
