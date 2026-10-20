# Ring Safety-Scan Observability Plan

Specification: [Ring Safety-Scan Observability](../specs/2026-10-06-ring-safety-scan-observability.md)

Workspace: `/workspace/herdr-agent-swarm`, in-place on
`main`, starting revision `526b5360`. Existing user-owned `TODO.md` and the
three pre-existing untracked documents are excluded from this plan.

Baseline: `npm test -- --maxWorkers=1` passed 288 files and 4,154 tests. The
production-shaped scope-head checks passed 2/2, including a roughly 655 ms
20,000-row query. `public:audit` has pre-existing repository-wide historical
documentation/path findings and remains an explicit later T9 gate blocker.

Approval: Gate 1 and Gate 2 approved on 2026-10-06. The active goal to finish
the remaining tasks authorized Gate 3 implementation on 2026-10-06.

## Tickets

### - [x] R1A: Expose trustworthy safety-scan discovery evidence

| Field | Content |
| --- | --- |
| What to build | Add process-lifetime `safetyScanRuns`, `safetyScanDiscoveries`, `lastSafetyScanAt`, and `lastSafetyScanDiscoveryAt` fields to the existing Delivery Engine snapshot and `/status` projection. Only a successfully completed periodic maintenance refill contributes; newly accepted durable reply IDs count as discoveries. |
| Spec references | SCN-1 through SCN-5; Domain Model, Architecture, Behavior & Failure Modes, and Compatibility & Migration in the approved specification. |
| Ownership and implementation path | `RingDeliveryEngine` owns refill-cause classification and cache-membership detection. `DeliverySnapshot` owns the additive diagnostic shape. Preserve the public `DeliveryEngine.enqueue()` API and existing health composition. No SQLite, Core, Gateway, scheduling, claim or settlement changes. |
| Acceptance criteria and verification | Red-Green tests prove empty successful scans, missed-item discovery, duplicate exclusion, non-safety refill exclusion, failed-scan exclusion, injected-clock timestamps, and unchanged exactly-once claim/delivery behavior. Run focused Ring and health tests, architecture check, typecheck, build, full single-worker suite, diff review and an independent code review. Create one atomic Conventional Commit containing only this ticket and its approved spec/plan updates. |
| Blocked by | None. Production observation and rollback rehearsal remain post-deployment R1 operations, not part of this ticket. |

## Coverage Check

| Requirement | Ticket |
| --- | --- |
| SCN-1 empty successful safety scan | R1A |
| SCN-2 missed hot-path work discovered exactly once | R1A |
| SCN-3 duplicate hydration excluded | R1A |
| SCN-4 startup/notification/retry/advance excluded | R1A |
| SCN-5 failed scan is not counted as successful | R1A |
| Additive health/status compatibility | R1A |
| No delivery-semantic or persistence change | R1A |

## Final Delivery Checks

- Review the complete task-owned diff and preserve user-owned files.
- Run focused Ring/health tests and `npm run architecture:check`.
- Run `npm run typecheck`, `npm run build`, and `npm test -- --maxWorkers=1`.
- Record the known pre-existing `public:audit` blocker without weakening it.
- Commit R1A atomically; do not push.
- Installation/restart, production observation duration, rollback rehearsal,
  rollback-window closure and T9 implementation remain separately authorized
  operational steps.
