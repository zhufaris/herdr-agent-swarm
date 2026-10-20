# CardKit-only Answer delivery

## Decision

Remove the `rich_post` / `rich-text-reply` / `rich-text-update` delivery
protocol from Herdr Agent Swarm. All newly accepted Primary and Worker turns
must create and update Answer output through CardKit pages only.

An already-delivered Feishu rich-text message is an external historical effect.
It will not be edited, deleted, or converted in place. The service will stop
updating it and create a new CardKit Answer continuation for any active
durable turn that still owns a `rich_post` page.

## Scope

- Remove rich-text gateway intents, Feishu adapter methods, page mode, page
  planning, recovery, and test coverage.
- Make Primary and Worker acceptance create CardKit stream pages.
- Migrate active durable `rich_post` pages to CardKit without submitting or
  replaying a TraeX prompt.
- Keep existing external rich-text messages as immutable visible history.
- Update architecture and operator documentation to describe CardKit as the
  only Answer delivery format.

The migration does not delete historical outbox/audit records, rewrite already
delivered external messages, or use manual SQLite changes.

## Durable handoff

The SQLite store owns a fenced, transactional handoff operation for an active
Primary or Worker rich-text page:

1. Revalidate aggregate generation, current page identity, and that the page
   is active and `rich_post`.
2. Mark that page frozen so no later rich-text update can target it.
3. Dismiss pending rich-text updates in that aggregate lane with an explicit
   migration reason. Delivered effects remain immutable evidence.
4. Reserve a new CardKit `stream_card_create` continuation on the same durable
   aggregate. Its initial CardKit timeline snapshot begins at the current
   delivery cursor, not at an inferred terminal transcript.
5. Persist the CardKit page/checkpoint and outbound intent atomically, then
   wake the regular outbox dispatcher.

The CardKit continuation is visibly labelled as a continuation. It receives all
future timeline deltas, tools, task list state, and final rendering through the
standard Answer Card reducer. No prompt body is resent to Herdr or TraeX.

The page index stays monotonic even when the new CardKit page starts from a
cursor within the original rich-text page. Display text must say it is a
continuation rather than incorrectly claiming it is the first page.

## Runtime behavior

Primary and Worker acceptance reserve CardKit `stream_card_create` as their
only initial Answer effect. The normal CardKit convergence workflow owns
streaming, timeline snapshots, pagination, frozen pages, final cards, and
delivery recovery.

Startup convergence first invokes the migration handoff for eligible active
legacy pages, then converges the CardKit page. If a migration cannot prove the
current aggregate/page identity, it leaves the record unchanged and reports a
bounded recovery failure; it never guesses a target or replays the turn.

After the release has converged legacy active pages, no runtime source,
delivery-intent type, gateway contract, schema constraint, or recovery branch
refers to `rich_post`, `rich-text-reply`, or `rich-text-update`.

## Failure handling

- A rejected CardKit creation follows the existing CardKit outbox recovery
  policy; it does not reactivate the rich-text page.
- An uncertain provider effect remains quarantined for inspection. The
  migration never duplicates an unknown external effect.
- A completed or failed rich-text page is historical only. It is not reopened;
  only active pages are eligible for handoff.
- The service does not attempt to edit or delete an existing Feishu rich-text
  message.

## Tests and verification

- Unit tests prove that new Primary and Worker turns emit CardKit stream-create
  intents and no rich-text intent.
- Store integration tests prove a fenced, idempotent active-page handoff,
  dismissal of pending rich-text updates, and no TraeX prompt side effect.
- Recovery tests cover startup handoff, stale generation rejection, rejected
  CardKit create, and uncertain external effects.
- Static checks ensure no production source imports or exports the removed
  rich-text protocol.
- Run affected Vitest suites, `npm run typecheck`, `npm run build`, and the
  full `npm test` because persistence, recovery, and the Gateway contract are
  shared behavior.

## Non-goals

- Reformatting historical Feishu rich-text messages into CardKit.
- Replaying historical prompts or fabricating answer timeline events.
- Changing the no-replay, SQLite lease, or ordered outbox invariants.
