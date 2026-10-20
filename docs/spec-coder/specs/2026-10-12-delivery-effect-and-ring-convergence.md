# Delivery Effect and Ring Convergence

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Three delivery defects violate the service's durable-first and scope-isolation
invariants.

First, Feishu HTTP `5xx` and `408` responses are currently classified as proven
rejections. The outbox may therefore retry an effect that Feishu applied before
losing the response. `shareThread` also falls back to a second root-message
forward after a `5xx`, or after a response without a message ID, so one ambiguous
provider outcome can immediately produce a second visible effect.

Second, every `turn-card:` projection is routed through methods named and fenced
for a Primary owner. Production contains a current Worker Conversation Page
whose owner/page identity is valid but which can never satisfy that Primary-only
claim. A separate Primary page has advanced from outbound snapshot revision `5`
to page sequence greater than `1200`, yet its obsolete pending reply remains the
scope head. Since the latest restart those two rows have generated more than 150
repeated `stale_attempt` diagnostics while blocking `wN:p6N` and `wN:p6S`.

Third, a Ring marks its head as actively granted before semantic preparation,
safe-supersession advancement, and the SQLite claim. An exception in any of
those pre-effect steps releases the global scheduler permit but does not finish
the per-Ring grant, leaving that scope permanently unrunnable until restart.

Initial deployment also exposed a distinct recovery hazard. A Worker Segment
last updated more than seventeen hours before restart still had an unattempted
page-zero create. Once Worker claim routing was corrected, restart recovery
created 27 historical Card Pages before the service was stopped. This was not a
duplicate claim, but it violated the operator preference to lose a small amount
of never-visible presentation work rather than replay a large historical card
backlog.

## Solution

Make Feishu effect certainty conservative: only explicit client/provider
rejections and proven pre-connect failures are replay-safe. Treat `5xx`, `408`,
request timeouts, connection resets, and missing acknowledgement identity as
uncertain. Root-forward fallback remains available only for the exact
`400/230001` rejection proving that thread forwarding was not accepted.

Deepen the existing prepared-delivery seam by replacing the misleading
Primary-only Conversation Page methods with owner-neutral methods. One SQLite
transaction validates either the exact Primary owner or the exact Worker plus
parent owner, the authoritative Conversation Segment/Page identity, prerequisites,
conflict eligibility, cooldown, and lease before claim. A current Worker page
therefore follows the same Card Page lifecycle as a Primary page.

When the authoritative page proves that an unclaimed, checkpoint-free reply is
obsolete, retire it without an external call. For a non-closed Segment, clear
the obsolete pending link and return the page to `creating` or `active` so normal
projection convergence can reserve only the latest revision. For a closed
Segment, clear the link and terminalize the undelivered page locally so old
cards are not replayed into Feishu. Ambiguous, claimed, checkpointed, uncertain,
cooldown-blocked, prerequisite-blocked, conflict-blocked, or lease-blocked work
is never retired by this rule.

Finally, make the existing Ring drain lifecycle the unconditional owner of an
active grant. If execution rejects while the Ring still owns a grant, discard
only the cached reference, finish the grant, release the scheduler permit, and
request ordinary durable refill. SQLite remains authoritative, so the recovery
does not invent or replay an effect.

Fence never-attempted initial Card Page recovery by the current process epoch.
The Ring records one immutable startup timestamp and passes it to Conversation
Page claim. A page-zero `card_reply` whose durable intent predates this process
and whose `first_claimed_at` and provider checkpoints are empty is locally
dismissed and terminalized instead of becoming a new visible historical card.
Initial creates admitted during the current process remain eligible. Claimed,
checkpointed, delivered, or uncertain effects are unchanged.

The design was auto-selected under the active goal's explicit autonomous/default
execution authority. It reuses the current Gateway failure contract, Delivery
Ring, prepared-delivery store, Conversation Page state, and refill path. It adds
no worker, queue, timer, table, ledger, or human-recovery surface.

## User Stories

### SCN-1: Ambiguous Feishu outcomes never create a second effect

When Feishu returns `5xx`, `408`, a request timeout/reset, or a response without
the required effect identity, the failure is uncertain. The outbox preserves it
for reconciliation and neither retries it nor invokes root-forward fallback.
An exact `400/230001` thread rejection may still use the existing root fallback;
`409`, `425`, and `429` remain explicit rejected transient outcomes.

### SCN-2: Worker and Primary Conversation Pages use one claim contract

A current Worker-owned Conversation Page with exact Worker generation,
Worker-session generation, parent Binding generation/session, Pane scope, page
revision, target, and plan may be claimed and settled through the same
Conversation Page interface as a Primary-owned page. A mismatched owner or
parent never falls back to Primary or Global delivery.

### SCN-3: Deterministically stale page heads converge without old replay

An unclaimed page delivery whose authoritative page revision has advanced is
dismissed atomically, its pending link is released, and normal convergence may
reserve the current revision. A closed Segment's never-delivered page is
terminalized locally rather than creating an old card. Possible-effect work
remains untouched.

### SCN-4: A pre-effect exception cannot strand a Ring grant

If semantic preparation, safe-supersession inspection, or SQLite claim throws,
the scheduler permit and per-Ring grant are both released. The stale cache entry
is removed and durable refill can make the same scope runnable again without a
service restart.

### SCN-5: Restart does not replay a never-visible initial Card Page

When restart discovers an unattempted page-zero create older than the current
Ring process epoch, it dismisses the outbox row without a Gateway call and
terminalizes that undelivered page. A page-zero create reserved after the Ring
started remains claimable. Any prior claim, checkpoint, delivery, or uncertain
effect prevents local retirement.

## Implementation Decisions

### INV-1: Effect certainty, not retry class, controls external replay

`rejected` means the provider proved the effect was not accepted;
`not-started` means transport failed before a request could cross the boundary;
`uncertain` means the effect may exist. Only the first two can enter automatic
retry or alternate-effect fallback. A `transient` label never upgrades
uncertain evidence into replay safety.

### INV-2: Conversation Page ownership and projection identity are atomic

The prepared-delivery store owns claim eligibility. Primary and Worker owner
predicates remain distinct internally, but both are hidden behind one
Conversation Page interface and execute in the same transaction as the page,
scope, prerequisite, conflict, cooldown, and lease checks. Card/Gateway adapters
never infer workflow ownership.

### INV-3: Safe stale retirement requires proof of no possible effect

Retirement requires the exact pending row, no active claim, no card or Gateway
checkpoint, non-uncertain effect evidence, and an authoritative owner/page
contradiction such as a closed Segment or advanced page revision. The original
outbox row remains as dismissed audit evidence. Other claim failures remain
pending and preserve their existing recovery semantics.

### INV-4: Every begun Ring grant has one unconditional local release

The drain lifecycle releases the scheduler permit on both resolve and reject.
On reject it additionally finishes a still-active Ring grant and removes the
cached reference before requesting durable refill. The refill re-reads SQLite;
it does not reuse an unverified in-memory payload.

### ARCH-1: Gateway translation remains at the Feishu adapter boundary

Feishu HTTP/provider normalization and the exact root-forward fallback rule stay
in `src/gateways/feishu/` and `src/adapters/`. Domain delivery code continues to
consume the provider-neutral `GatewayFailure` contract and never imports the
Lark SDK.

### ARCH-2: PreparedDeliveryStore is the deep Conversation Page seam

Rename the internal Primary-only claim/checkpoint/ack/fail methods to
Conversation Page terminology and keep owner-specific SQL private. Callers learn
one interface; the store retains the complex atomicity, ownership, stale-proof,
and settlement implementation.

### ARCH-3: Ring recovery reuses the existing durable refill path

The Ring engine adds no recovery state machine. It owns only process-local grant
cleanup, while the store and refill adapter remain the authority for durable
work. Existing architecture import checks must continue to pass.

### INV-5: Process epoch is a loss fence only for pristine initial presentation

The process-start timestamp is process-local scheduling evidence, not workflow
truth and not a persisted cursor. It may suppress only a page-zero create that
has never crossed the provider-effect boundary. It cannot suppress updates,
continuation pages already visible through a prior page, claimed work, provider
checkpoints, or uncertain effects. This intentionally trades a small crash-window
presentation loss for bounded restart behavior; Core and Conversation data stay
authoritative and unchanged.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, INV-1, INV-2, INV-3, INV-4, INV-5, ARCH-1, ARCH-2, ARCH-3

- Update Feishu failure-table tests so `5xx` and `408` are unknown/uncertain,
  while `409`, `425`, `429`, permanent `4xx`, and pre-connect codes retain their
  exact semantics. Prove ambiguous thread-forward and missing-ID outcomes never
  call root-forward fallback.
- Add Ring tests that inject throws before claim and in claim, then prove the
  same scope can be offered and executed again without restart.
- Add process-epoch tests proving an old pristine page-zero create is locally
  terminalized, a current-process create is claimable, and possible-effect work
  remains untouched.
- Add real temporary-SQLite tests for a Worker Conversation Page claim and
  settlement under exact Worker/parent fences.
- Add real temporary-SQLite tests for an advanced non-closed page and a closed
  never-delivered page. Prove retirement is atomic, produces no Gateway call,
  advances the scope, and leaves the page in the specified convergence state.
- Run the affected suites, typecheck, build, architecture/docs checks, the full
  Vitest suite, and delivery artifact validation. After deployment compare the
  two repeated reply IDs, Ring pending/waiting counts, stale-attempt growth,
  Core health, and Feishu delivery latency.

## Out of Scope

No Delivery Ledger, new retry worker, new queue, new table, schema migration,
automatic uncertain-effect replay, production SQLite hand edit, global Ring
ordering redesign, historical Human Recovery workflow, empty-Ring eviction,
arbitrary wall-clock age cutoff, render caching, log aggregation, missing-index
migration, dependency upgrade, or unrelated startup/status optimization is
included.

## Further Notes

Workspace mode is in-place inside the existing isolated clean worktree
`/tmp/herdr-agent-swarm-main-ring-stability-20261012`, branch `main`, starting
revision `2fba0e4687dc65ff8ab698842a1c289421d40727`. The user's original checkout
remains untouched. Node `24.14.1`, npm `11.11.0`, Vitest `4.1.11`, TypeScript
`5.9.3`, and locked dependencies were observed installed.

Live read-only evidence at this revision showed `62` pending deliveries, `61`
waiting behind a scope head, and repeated stale attempts for
`turn-card:segment:5790a187-5823-4e23-ac6a-e1c130b64b76:page:0:create` and
`d0d6e3b6-caed-4d1e-8ff9-190f0fb1c800`. The first is a valid Worker-owned page
incorrectly routed to a Primary claim. The second points to a completed Primary
page whose sequence has advanced by more than one thousand revisions beyond the
outbox snapshot. No production data was modified during diagnosis.

Fresh baseline records for request `round-20261012-delivery-ring-stability`:

```spec-coder-verification
{"record_id":"5a1f79e9a7e248f1a9dc5d83f3177858","command":["/usr/bin/npx","vitest","run","tests/feishu-delivery-errors.test.ts","tests/lark-adapter.test.ts","tests/ring-delivery-hot-path.test.ts","tests/prepared-delivery-store.test.ts"],"exit_code":0,"status":"captured","observed_at":"2026-10-12T21:09:51.227505+00:00","result":"4 files and 214 tests passed"}
```

```spec-coder-verification
{"record_id":"5c96356d740841949eac1d5df6aaffae","command":["/usr/bin/npm","run","typecheck"],"exit_code":0,"status":"captured","observed_at":"2026-10-12T21:10:07.473283+00:00"}
```

```spec-coder-verification
{"record_id":"a956c3ad81e24cc58c3011fe31fdf8a8","command":["/usr/bin/npm","run","build"],"exit_code":0,"status":"captured","observed_at":"2026-10-12T21:10:07.500495+00:00","build_id":"sha256:332d423d28ec95187132d0b8c20500e80937d9219b51e2d2b3a3322ee4ac1c77"}
```
