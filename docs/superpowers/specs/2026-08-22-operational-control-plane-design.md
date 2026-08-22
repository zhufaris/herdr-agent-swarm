# Operational Control Plane Design

## Goal

Give users and operators a safe control plane for inspecting sessions,
recovering failed Lark delivery, and acting on live Herdr panes while preventing
two bridge processes from consuming the same SQLite-backed workload. Reduce
repeated Herdr CLI discovery calls without allowing stale observations to drive
attachment mutations.

This design adds `/herdr sessions`, `/herdr failures`, an instance lease, a
two-second workspace snapshot cache, actionable `/herdr spaces` rows, and a
real-user smoke-test procedure. It does not add destructive pane cleanup.

## Single-instance lease and fencing

SQLite is the authority for one active bridge instance per database. A singleton
lease row stores a random owner ID, a monotonically increasing fencing token,
and an expiry timestamp. Startup acquires the lease in `BEGIN IMMEDIATE` before
starting the publisher, projector, health listener, coordinator, or Lark
WebSocket. Acquisition succeeds when the row is absent, expired, or already
owned by the same process. Taking an expired lease increments the fencing token.
A live lease owned by another process makes startup fail with a bounded,
actionable error.

The owner renews before expiry on a fixed heartbeat. Renewal is conditional on
both owner ID and fencing token. A failed renewal means ownership is lost: the
bridge immediately becomes not ready and begins graceful shutdown. Release is
also conditional on owner and token, so an old process cannot release a newer
owner's lease. Process death requires no cleanup because expiry permits takeover.

The lease token is an instance fence, not a per-job lock. This service currently
has one SQLite writer process, so checking ownership before starting all runtime
consumers and on every heartbeat is the safety boundary. The owner ID is logged
in bounded form and exposed only as a short diagnostic suffix. `/ready` includes
lease ownership and becomes `503` after lease loss; `/status` includes token,
expiry, and heartbeat health without exposing host secrets.

Default timing is a 15-second TTL and a 5-second heartbeat. Startup validates
that the heartbeat is comfortably shorter than the TTL. Tests use an injected
clock rather than wall-clock sleeps.

## Workspace snapshot cache

A shared `WorkspaceSnapshotCache` wraps `HerdrPort.listPanes`. It stores one
successful pane snapshot per workspace for at most two seconds and coalesces
concurrent refreshes for the same workspace. `/herdr spaces`, reconciliation,
and readiness use the shared cache. A refresh failure is returned to the caller
and does not extend the age of an old value; callers that permit stale fallback
must label it explicitly. The first implementation does not use stale fallback.

Read-only callers use `listPanes(workspaceId)`. Mutating identity decisions use
`listPanes(workspaceId, { forceRefresh: true })`, specifically attach, reattach,
replace, and any future claim action. Successful pane creation, rename, attach,
or replacement invalidates that workspace immediately. The cache is in memory
only and exposes hit, miss, coalesced-refresh, refresh-failure, and snapshot-age
diagnostics through logs and `/status`; logs stay at debug except failures.

`HerdrPort` remains the raw external adapter. The coordinator and health server
depend on the cache abstraction so there is one cache per process rather than
separate caches with inconsistent freshness.

## Session and failure views

`/herdr sessions` is accepted from the configured group root or any topic and
renders sessions belonging to that chat. It shows title, project/Space, Pane ID,
lifecycle, attachment, runtime state, generation, queue depth, and last activity.
Active and degraded sessions appear first, followed by recoverable provisioning,
orphaned, archived, closed, and failed sessions. Rows are bounded and paginated.
An existing topic link is offered only for a binding in the requesting chat.
No prompt body or terminal output is exposed.

`/herdr failures` renders current actionable failures for the requesting chat:
dead-letter outbound replies, failed or cancelled prompts, recoverable
provisioning, and degraded/orphaned attachments. Historical totals remain in
`/status`, but the card distinguishes current actionable records from history.
Errors are safely bounded. Prompt failures are diagnostic only and never receive
a retry button.

Each dead-letter row may offer `重试发送` and `忽略` actions. The card action
payload contains an opaque reply ID plus the expected current state; payloads
never contain card bodies or errors. The coordinator reloads the row, verifies
that it belongs to a binding in the action's chat (or to a project selection
created in that chat), and performs an atomic compare-and-set transition.

Retry changes only `outbound_replies.dead_letter` to `pending`, clears its error,
sets `next_attempt_at` to now, and wakes the publisher. It preserves the original
idempotency key and attempt history. It never changes `prompt_jobs`, enqueues a
prompt, or invokes Herdr. Dismiss transitions the outbound row to a terminal
`dismissed` state and records actor, reason, and timestamp in the audit log. A
dismissed row is retained for history and cannot be retried without a future,
separate operator workflow. Duplicate actions are idempotent and visibly report
the current result.

## Actionable Space directory

The Space directory remains a live inventory. A bound pane owned by the
requesting chat includes `打开项目话题` when its root message is known. It never
reveals another chat's topic link. An eligible unbound pane in a registered Space
includes `认领 Pane`. There is no close or delete action.

Claim uses a card action rather than embedding a synthetic chat command. Its
payload contains project ID, workspace ID, and pane ID. Handling force-refreshes
the workspace, then reuses the same validation and provisioning path as
`/herdr attach`: configured project/cwd match, stable exact pane identity,
ownership check, TraeX eligibility, one binding/topic, and idempotent result. The
action is scoped to the card's chat and actor. If the snapshot changed, the user
gets a fresh explanatory result instead of acting on the two-second-old card.

## Observability and failure behavior

Structured events cover lease acquisition, contention, renewal, loss, and
release; cache refresh failures; failure retry/dismiss decisions; session and
failure listing counts; and Space action outcomes. Logs carry IDs and states but
not prompt bodies, terminal output, card payloads, tokens, or Lark credentials.

`/health` remains process liveness. `/ready` represents whether this instance may
serve traffic and therefore requires a held lease. `/status` adds lease/cache
diagnostics and current-versus-historical failure counts. A lease-loss shutdown
does not release the row after ownership has changed because release is fenced.

## Real-user smoke test

Automation may prepare and observe a smoke test but must not impersonate a user
or bypass the bot-message filter. A repository script generates a unique marker,
prints a short checklist for a genuine user to send in the configured Feishu
group, and polls only local status/log evidence for bounded time. The checklist
covers `/herdr spaces`, opening a bound topic, claiming a disposable eligible
pane when available, `/herdr sessions`, and `/herdr failures`. It records the
marker and timestamps locally without storing message bodies or credentials.

If no disposable pane or dead letter exists, those mutations are explicitly
skipped rather than manufacturing production failure. The smoke test reports
manual confirmation separately from machine-observed health.

## Delivery slices and non-goals

The features ship in independently tested slices: lease, cache, failure/session
commands, Space actions, then smoke tooling and deployment. Schema changes are
additive and tested against a copy of the current database. Existing runtime
records in `var/` are never staged or modified by repository tooling.

Deferred work includes cleanup preview/confirmation, destructive pane closure,
retention execution, database vacuum/backup automation, PM2 boot persistence,
and a larger current-versus-historical metrics redesign.

## Verification

Automated tests cover lease contention, expiry takeover, token monotonicity,
renewal loss, fenced release, and readiness; cache TTL, coalescing, invalidation,
force refresh, and failures; command parsing, chat scoping, pagination, bounded
errors, safe dead-letter retry/dismiss, and absence of prompt replay; Space
button visibility, cross-chat isolation, stale-card revalidation, and idempotent
claim.

Release verification runs focused tests after each slice, then the full suite,
typecheck, build, `git diff --check`, migration against a copied runtime database,
PM2 restart, `/ready`, `/status`, and clean log inspection. The genuine-user
smoke checklist is the final acceptance step and never sends as the bot.
