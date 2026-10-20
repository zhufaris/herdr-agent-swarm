# Feishu Event Visibility and Mutable Action Cards

## Problem Statement

Herdr Core already records the native TraeX transcript and Herdr Agent Swarm projects normalized events into durable card views, but the current visibility policy loses useful operator context in three places:

- Core filters TraeX reasoning records before they reach Swarm, even when a record contains a concise Markdown heading that is safe and useful as a progress summary.
- Swarm classifies `wait`, `write_stdin`, and `wait_agent` as internal activity and drops them from both the Answer timeline and the persistent status projection. Consequently, a long-running command can appear inactive in Feishu. Internal collaboration lifecycle records are likewise unavailable as a bounded status summary.
- Primary Human Review creates one immutable mention card and later creates a separate resolution card. Worker Human Review also creates an immutable notification. Neither path can add later instructions to the original action request or resolve that same visible surface.

The default Answer page limit is also 10,500 characters, causing long but otherwise safe answers to paginate earlier than desired. The intended default is 21,000 characters while retaining the existing 28,000-character stream ceiling.

The change must preserve Herdr as the authority for native runtime state, SQLite as the authority for projection and delivery intent, and Lark as a presentation target only. It must not expose private reasoning, remotely execute approvals, replay a Prompt, rewrite frozen Answer pages, or combine with the separate Core journal source-reclamation fix.

## Solution

Use an incremental typed-projection design across Herdr Core and Herdr Agent Swarm:

1. Core extracts only a bounded Markdown heading from qualifying TraeX reasoning records and emits it through the existing normalized `message` payload with `channel=reasoning`. Reasoning prose is discarded before journal persistence, and reasoning events do not participate in final-message identity.
2. Core translates supported collaboration lifecycle records into a bounded `agent_activity` payload containing only stable identity, safe display label, lifecycle state, and turn/time metadata. Prompt text, internal messages, result prose, reasoning, and absolute paths never cross the Core boundary.
3. Swarm separates status-bar visibility from Answer-timeline visibility. Wait activity and normal sub-agent lifecycle remain status-only; sub-agent failure, interruption, or blocking additionally produces one stable Answer status item. Repeated wait polls and repeated agent observations update stable items rather than append noise.
4. Primary and Worker retain their existing Human Review lifecycle ownership. A shared Human Review card projection module owns the mutable visible surface: card snapshot version, delivery target, create/update intent, delivery checkpoint, and replacement after a permanently invalid target. One episode creates at most one current action card.
5. The Answer page default becomes 21,000 characters. The 28,000-character stream limit and frozen-page rules remain unchanged.

The reasoning display configuration is `hidden | summary`, defaulting to `summary`. A full-reasoning mode is deliberately unsupported.

## User Stories

### SCN-1: Safe reasoning summary

When TraeX emits reasoning whose first stable Markdown heading is `Inspecting delivery state`, the active Answer timeline shows that heading as a bounded thinking item. The complete reasoning body is absent from the Core journal, bridge inbox, SQLite projections, logs, and Lark payloads. Reasoning without a qualifying heading produces no visible item.

### SCN-2: Coalesced command wait

When an asynchronous command yields a cell/session and the Agent polls it repeatedly, the Main or Worker status area shows one current `等待命令完成` activity. Further wait polls update that activity. No wait item is written to the Answer timeline. When the wait completes, the status becomes terminal until superseded by newer activity.

### SCN-3: Bounded sub-agent lifecycle

A sub-agent start/running/completed sequence updates one status item keyed by stable agent identity. Normal lifecycle changes do not enter the Answer timeline. A failed, interrupted, or blocked state updates the status item and creates or updates one Answer status item. Duplicate lifecycle events are idempotent. No prompt, private coordination, completion prose, or absolute path is displayed.

### SCN-4: First Human Review request

When a current, identity-fenced Primary Prompt or Worker Turn first needs human handling, its owning lifecycle transition opens one Human Review episode, updates the canonical Main/Task status to `需要处理`, and atomically reserves one mention-card create intent. A retry or repeated observation of the same episode does not create another mention.

### SCN-5: Supplement the existing mention card

When a new bounded notice or structured input request belongs to an open episode, the episode records the deduplicated update, increments its card view version, and reserves an update for the already checkpointed message. If the initial create is still pending, the latest snapshot supersedes the earlier pending snapshot and no impossible pre-create update is sent.

### SCN-6: Resolve the existing mention card

When the authoritative runtime leaves the blocked state, the episode becomes resolved and the existing action card is updated to `已处理` without a second mention and without a separate resolution card. Repeated resolution is a no-op.

### SCN-7: Recover after restart

After process restart, SQLite reconstructs the open episode and its current card target/version. New supplements and resolution continue against the same card. Lark contents are never used to reconstruct workflow state.

### SCN-8: Replace an invalid card target

If Lark permanently rejects an update because the target is expired or defunct, durable recovery retires that surface and reserves one replacement card for the still-open episode. The replacement may mention once because it is a new visible surface. Recovery never repeats Agent work or changes Prompt delivery state.

### SCN-9: Larger Answer page

An Answer remains on one page until the configured 21,000-character boundary is reached. Content beyond that boundary continues on a new card with the existing canonical source offsets and immutable frozen-page behavior.

### SCN-10: Compatibility and degradation

Swarm accepts both old Core streams without reasoning/agent activity and new streams containing the additive payload. Missing optional events degrade to the current behavior without affecting Prompt ownership, recovery, or final answers. Deployment proceeds Swarm first, then Core.

## Implementation Decisions

### Domain Model

The affected contexts are:

- **Native Event Normalization (Core):** owns parsing untrusted provider JSONL and deciding which bounded facts may leave the transcript boundary.
- **Conversation Projection (Swarm):** owns whether a normalized fact belongs in the status surface, Answer timeline, or neither.
- **Human Review (Swarm):** Primary and Worker lifecycle owners decide when an episode opens/resolves; a shared card projection owns the current visible action-card surface.
- **Delivery (Swarm):** owns ordered, idempotent Lark effects and delivery checkpoints; it never owns workflow truth.

The existing term **Human Review episode** remains canonical: one continuous need for local human action. A **Human Review surface** is the current Lark card representing that episode. Replacing an expired surface does not create a new episode. These terms do not require a repository glossary because no glossary currently exists and the specification provides the local definition.

The Human Review episode protects these invariants:

- **INV-1:** At most one open episode exists for the fenced Primary Prompt or Worker Turn.
- **INV-2:** An episode has at most one current visible surface generation; duplicate observations cannot create another current card.
- **INV-3:** Only the first create of a surface generation may mention. Supplements and resolution never mention.
- **INV-4:** Episode state, rendered view version, and durable outbox intent commit atomically.
- **INV-5:** Delivery failure or recovery cannot submit, steer, approve, deny, stop, or replay Agent work.
- **INV-6:** Reasoning prose never crosses the Core normalization boundary.
- **INV-7:** Frozen Answer pages are never patched.

Human Review surface state is reconstituted from SQLite without replaying lifecycle commands. A stored episode may be open or resolved; a surface may be awaiting creation, active, replacing, or terminal. Delivery message/card identity and delivered version must survive restart. Malformed stored snapshots fail closed and are reported rather than silently rendered.

### Architecture

#### Core codec

The existing TraeX decoder remains the sole parser of provider JSONL.

- A private deterministic helper extracts a first Markdown bold heading, normalizes whitespace, applies Core redaction, and bounds it to 160 characters.
- Qualifying records emit the existing `ReplyPayload::Message` with `channel=reasoning`; a separate emission helper avoids changing `last_message`.
- Collaboration records translate to a new additive `ReplyPayload::AgentActivity` with a closed lifecycle enum. The decoder retains only the minimum identity-to-label correlation needed across records and checkpoints.
- Unsupported lifecycle variants are ignored or emitted as `record_skipped` according to the existing malformed-versus-known-ignored policy; raw payloads are never forwarded.

Core schema dependencies remain inward: provider conversion is contained in `agent_events/codec`, while the normalized payload is defined in the API schema. No Swarm or Lark concepts enter Core.

#### Swarm event projection

The Herdr event schema and projector accept `agent_activity`. The projector maintains stable item keys:

- `wait:<session-or-turn-key>` for wait activity;
- `agent:<agent-id>` for sub-agent activity;
- `thinking:<message-id>` for reasoning summaries.

Tool projection exposes separate policies for status activity and Answer timeline activity. Wait and Agent records can therefore update durable progress without being rendered as ordinary Answer tools. Failure/interruption/blocking uses the existing Answer `status` item shape with a stable ID.

The status projection continues through existing `AgentTranscriptObservation`, bridge events, reducers, and Run/Worker card views. Coordinators do not call Lark directly.

#### Human Review card projection

Primary and Worker lifecycle code call a shared, internally owned Human Review card projection interface with fenced owner identity, episode identity, state, bounded updates, creator mention identity, routing root, and render function. The interface returns a reservation outcome and exposes no Lark SDK type.

Persistence retains the existing Primary episode history and adds the delivery/view fields required for a mutable surface. Worker gains equivalent durable episode state because lifecycle-event identity alone cannot recover a mutable card target. Shared store helpers centralize snapshot revision, create/update selection, and replacement rules without merging Primary and Worker lifecycle ownership.

Outbox rows carry an explicit projection identity and snapshot revision. On successful card creation, delivery settlement checkpoints the returned message/card identity and wakes projection convergence if a newer view exists. Card updates target only a checkpointed message. Permanent expired/defunct-target recovery marks the old surface generation terminal and reserves one replacement create for an unresolved episode. Unknown or uncertain delivery failures stay quarantined under existing outbox rules rather than guessing whether the effect occurred.

#### Card rendering and configuration

The action card renderer receives only a sanitized projection DTO. It renders the initial request, ordered bounded updates, current state, safe Pane/Worker identity, and last-updated time. It contains no remote approval or terminal-control action.

Runtime configuration adds `reasoningDisplay: hidden | summary` with default `summary`. `answerPageLimitChars` defaults to 21,000 and remains constrained to `<= answerStreamLimitChars`. Explicit existing runtime configuration is preserved.

Concrete stores, renderers, event projectors, and gateway adapters continue to be assembled at the existing composition roots. Domain and coordinator modules do not import the Lark SDK or SQLite row types.

### Behavior & Failure Modes

- Reasoning extraction is deterministic and produces either one safe heading or no event. It does not perform model-based summarization.
- A new wait call for the same command/session upserts the same current activity. A missing session identity falls back to one turn-scoped wait key.
- Agent lifecycle events are ordered by Core cursor. Older or duplicate events cannot overwrite a newer persisted state.
- A supplement is deduplicated by source event identity. Bounded updates retain chronological order and a bounded history; rendering may show the latest subset without deleting canonical episode data.
- A structured `request_user_input` may arrive before the authoritative blocked transition. The shared projection persists one bounded, owner-scoped pre-block candidate keyed by source event identity. Opening the matching episode atomically absorbs that candidate into its first snapshot; a candidate that never matches an episode emits no card and expires under bounded retention.
- When supplement and resolution race, the SQLite transaction that observes the authoritative owner state decides the resulting episode version. A supplement cannot reopen a resolved episode; a later genuine blocked transition creates a new episode.
- If resolution occurs before the first card create is delivered, the pending action notification is superseded or dismissed so a stale mention is not delivered. If the external create outcome is uncertain, existing quarantine rules apply and no duplicate is sent until delivery certainty permits recovery.
- Card updates are presentation effects only. No failure path changes Prompt submission receipts, session ownership, FIFO ordering, or detached recovery.

### Compatibility & Migration

- The Core `message` payload remains schema-compatible; `channel=reasoning` contains only the safe summary.
- `agent_activity` is additive. Swarm support must be deployed before Core begins emitting it.
- SQLite migration adds only Human Review projection/episode fields and Worker episode persistence. Historical Primary rows remain readable. Historical immutable notification cards are not retroactively adopted or edited.
- Existing explicit `answerPageLimitChars` values remain unchanged. Only the generated/default value becomes 21,000.
- No journal format/version change is required for this feature.

## Testing Decisions

- Core codec unit tests prove heading extraction, no-heading omission, redaction, length bounding, no `last_message` interference, collaboration lifecycle translation, checkpoint restoration, and exclusion of prompt/result prose/path data.
- Swarm Herdr event protocol/reader/projector tests prove additive decoding, old-stream compatibility, stable identities, reasoning projection, Wait coalescing, Agent lifecycle state, and Answer failure-only visibility.
- Tool activity tests separately assert status visibility and Answer visibility instead of a single `isUserVisibleToolActivity` predicate.
- Run Card, Worker Task/Main Card, and integration tests verify current status selection and that Wait/normal Agent activity never appears in the Answer body.
- SQLite tests exercise Primary and Worker episode create, duplicate observation, supplement, pending-create supersession, delivery checkpoint, resolution, restart round trip, stale supplement refusal, and expired-target replacement.
- Outbox dispatcher/recovery tests verify create-before-update ordering, version convergence, uncertain-effect quarantine, and replacement without Prompt replay.
- Card tests verify exactly one initial mention, no mention on update/resolution, bounded/redacted update history, and safe identity display.
- Pagination/config/setup tests verify the 21,000 default, explicit override preservation, 28,000 ceiling, source-offset continuity, and immutable frozen pages.
- Architecture-boundary tests verify that provider JSON conversion remains in Core adapters/codecs, Lark rendering remains in cards, and workflow modules depend on domain ports rather than concrete delivery adapters.
- Final verification requires Core focused codec/schema tests plus lint/build, and Swarm affected tests plus typecheck/build and the full Vitest suite.

## Out of Scope

- Full chain-of-thought or raw reasoning display.
- Model-generated reasoning summaries.
- Remote approval, denial, arbitrary terminal input, process control, or Pane control from the action card.
- Displaying token-count, raw terminal-interaction, developer-message, `trae_extra_info`, context-compaction, worktree-path, or duplicate `*_end` payloads.
- Retrofitting historical immutable Human Review cards.
- Changing Prompt submission, FIFO, steering, detached recovery, or frozen Answer-page semantics.
- Deploying either repository, pushing branches, opening a PR, or including the separate Core journal source-reclamation changes.

## Further Notes

### Prepared workspaces

- Swarm: `/workspace/herdr-agent-swarm`, in-place on `main`, starting revision `77fbac62154b87c80bdd84ebeb8ebdc4db0c1b24`. This mode is safe because target source/spec files do not overlap the existing modified `TODO.md` or untracked `.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`, `docs/research/`, `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and `handoff.md`; those paths remain user-owned and excluded from commits.
- Core: `/tmp/herdr-core-feishu-event-summary`, isolated worktree on `feat/feishu-event-summary`, starting revision `7df83467c34cd1a3457739233a49cc21c4da384d`. Isolation prevents overlap with the original checkout's uncommitted `src/agent_events/journal.rs`. The preflight-created `.zig-cache/` is generated, untracked, and excluded from commits.

### Dependency and baseline evidence

- Swarm dependencies were already ready. `npm test` passed 254 files and 3,662 tests.
- Core uses the official Zig 0.16.0 archive in `/tmp/zig-x86_64-linux-0.16.0`, verified against SHA-256 `70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00` from Zig's download index. With isolated writable Zig caches, `cargo test --locked -p herdr agent_events::codec` passed all 14 codec tests; unrelated targets were filtered.

No unresolved product or architecture decision blocks planning. Gate 1 and Gate 2 were approved on 2026-10-03.
