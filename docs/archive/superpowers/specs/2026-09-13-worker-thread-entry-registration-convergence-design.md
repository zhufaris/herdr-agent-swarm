# Worker Thread Entry Registration Convergence

## Goal

Ensure that every successful formal Worker creation publishes exactly one
immutable Worker Thread entry card back into the originating Primary Thread,
including when the canonical Worker Main Card is delivered before the creation
command registers its entry request.

## Production evidence

The current Primary `yy1r` owns two formal Workers whose canonical Worker
threads and Main Cards already exist. Their `worker_main_views` rows are fully
delivered, but both corresponding `worker_thread_entry_requests` rows remain
`pending`.

The ordering is deterministic:

1. Worker creation persists `worker.created` card-context invalidation.
2. `CardContextRebuilder` projects and delivers the canonical Worker Main Card.
3. `SwarmCommandGateway` later registers the Primary entry request.
4. Registration persists only the request and does not invalidate the already
   current Worker Main projection.
5. No later projection calls `reserveWorkerThreadEntries()`, so the request can
   remain pending indefinitely.

This corrects the ordering assumption in the earlier Worker Thread entry design:
canonical Main delivery ACK cannot reserve an entry request that has not yet
been registered.

## Selected design

### Atomic registration and projection invalidation

`registerWorkerThreadEntry()` will persist the entry request and a
generation-fenced `worker-session` card-context invalidation in the same SQLite
transaction. The invalidation targets the exact Worker ID and Worker session
generation and uses the latest durable Worker Main dependency revision.

If the Worker Main Card is already delivered, the rebuilder reloads its current
view and `reserveWorkerThreadEntries()` converts the new request from `pending`
to `reserved` while enqueueing one immutable `card_reply` to the originating
Primary root. If the Main Card is not yet delivered, the existing Main Card
publication and later delivery ACK continue to provide the required projection
work; the entry is never emitted before a canonical Worker Main message exists.

The transaction remains idempotent. Duplicate registration for the same command
intent inserts neither another request nor another invalidation. The existing
entry idempotency key, `worker-thread-entry:<commandIntentId>`, remains the
delivery identity.

### Wake-up and recovery

After successful registration, `SwarmCommandGateway` emits the existing
best-effort outbound-work wake. The wake reduces latency only; SQLite remains the
authority. `CardContextRebuilder` consumes the durable invalidation and the
ordinary outbox dispatcher sends the card. No coordinator calls Feishu
directly.

Startup convergence must also discover legacy `pending` entry requests whose
canonical Worker Main message is already delivered and synthesize the same
generation-fenced invalidation. This repairs the two current production rows
without manually editing SQLite and remains safe to repeat after every restart.
Requests whose Worker session, parent binding generation, Primary root, or
canonical Main message no longer matches are terminalized as stale rather than
published against a new owner.

## Boundaries and invariants

- The Worker Main Card remains the canonical Worker Thread root.
- The Primary receives only the immutable entry/navigation card, not a second
  live Worker projection.
- Entry publication happens only after the canonical Worker Main message ID is
  durable and matches the active Worker session.
- Request registration and its convergence signal are one SQLite transaction.
- A lost process-local wake delays delivery but cannot lose the entry request.
- Duplicate commands, repeated scans, restart recovery, and delivery retries
  cannot create duplicate entry cards.
- Stale Worker or Primary generations fail closed.
- Worker creation continues through the formal Swarm workflow; no direct Herdr
  pane or direct Feishu send is introduced.

## Implementation boundaries

- `SqliteCommandIntentStore` owns atomic entry-request registration and creation
  of the corresponding card-context invalidation.
- Startup/card-context convergence owns recovery of legacy pending requests.
- `CardContextRebuilder` and `SqliteCardContextStore` retain responsibility for
  validating the current Worker/Main/Primary relationship and reserving the
  entry-card outbox row.
- `SwarmCommandGateway` supplies only the existing wake hint after durable
  registration.

## Validation

Add a red-capable integration test with the production ordering: first project
and acknowledge the Worker Main Card, then register the entry request. The test
must initially observe a stranded `pending` request and, after the fix, observe
exactly one reserved/delivered entry outbox intent. Repeat registration and
rebuilding to prove idempotency.

Add startup convergence coverage for a pre-existing pending request with an
already delivered canonical Main Card, plus stale-generation coverage that
proves no entry is sent. Run the affected SQLite, command-gateway, card-context,
and startup suites, followed by typecheck, build, full tests, and `git diff
--check`. Deployment must use `./install.sh` and the supported restart command;
post-restart verification must confirm the current pending requests converge and
no duplicate Primary entry cards are emitted.

## Non-goals

- Do not recreate or rename existing Workers.
- Do not delete the failed `test` Worker or its conflicting legacy Herdr Agent.
- Do not add an unverified Feishu deep link.
- Do not alter Worker task routing or Main Card rendering.
