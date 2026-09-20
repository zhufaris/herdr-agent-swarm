# Worker Human-Review Feishu Notification Implementation Plan

**Goal:** Send exactly one durable Feishu card notification, mentioning the
Primary creator when possible, for each Worker blocked episode while preserving
SQLite authority, Worker identity fences, and local-only approval.

**Design:**
`docs/superpowers/specs/2026-09-18-worker-human-review-feishu-notification-design.md`

## Task 1: Add the pure notification card

- Add a bounded domain input and a pure CardKit renderer beside the Worker card
  presentation code.
- Render the Primary-style orange hierarchy, Worker/task/Pane context, redacted
  notice, local-only handling guidance, optional canonical Worker Main action,
  and optional Feishu `<at id=OPEN_ID></at>` mention.
- Validate and attribute-escape the opaque Open ID; omit the mention when it is
  missing or unsafe.
- Add focused renderer tests for mentioned and fallback cards, content bounds,
  redaction, action identity, and absence of remote approval/input actions.

## Task 2: Reserve one notification per durable blocked episode

- Extend the projected Worker-turn transition input with the pure notification
  renderer dependency.
- Detect only an actual non-`blocked` to `blocked` state transition.
- Insert `turn.blocked`, capture its SQLite row id, and use it as the blocked
  episode identity.
- Within the same transaction, resolve and fence the Worker instance, Worker
  session generation, parent binding generation, active/attached lifecycle, and
  current root message.
- Enqueue one immutable `card_reply` with idempotency key
  `worker-review:<workerId>:<workerSessionGeneration>:<turnId>:<eventId>`.
- Keep the Worker transition and canonical-card invalidation successful when
  mention identity is absent or standalone-notification routing is stale.
- Return explicit notification reservation/skip facts to the caller without
  exposing the mention identity.
- Add SQLite tests for atomic commit/rollback, duplicate blocked observations,
  recovery, a second blocked episode, stale routing fences, and outbox identity.

## Task 3: Wire wake-up and structured diagnostics

- Pass the renderer through the existing `WorkerPresentation` boundary.
- Update all projected transition callers and test kernels without adding a
  direct Lark dependency to coordinators or stores.
- Wake the existing outbound dispatcher only after a newly committed intent;
  rely on periodic scans if the best-effort wake is lost.
- Emit bounded Pino events for reserved, mention-omitted, and routing-skipped
  outcomes. Do not log notice text or Open IDs.
- Add supervisor/observer tests proving a single wake, no duplicate reservation,
  and no TraeX replay or remote-control action.

## Task 4: Documentation and repository verification

- Update `docs/architecture.md` and `docs/feishu-group-usage.md` with the
  notification trigger, recipient fallback, durable flow, and local-only approval
  boundary.
- Run focused Worker card, Worker store, supervisor, observer, outbox, and
  architecture tests.
- Run `npm run typecheck`, `npm run architecture:check`, `npm run docs:audit`,
  `npm run build`, `npm test`, and `git diff --check`.
- Review the complete diff and commit the implementation independently.

## Task 5: Install and production validation

- Run `./install.sh` only after all repository gates pass.
- Inspect active Prompt, Worker, outbox, lease, and integrity state before restart.
- Use the ordinary `npm run swarm:restart` safety gate. Do not reuse an earlier
  force authorization for this new deployment.
- Verify build identity, readiness, SQLite integrity, Herdr workspaces, Gateway,
  Lark, startup recovery, and outbox/card convergence.
- Validate the notification with a controlled blocked transition only if it does
  not initiate a high-risk action; otherwise report the automated test evidence
  and leave live triggering to an operator-directed exercise.
- Do not push. A later push still requires complete outgoing-range inspection,
  trailer cleanup, and `npm run public:audit`.
