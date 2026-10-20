# SQLite Operational Scalability Plan

Specification:
[SQLite operational scalability](../specs/2026-10-08-sqlite-operational-scalability.md)

## Workspace, ownership, and baseline

- Workspace: repository root.
- Mode: in-place and serialized. The approved work spans the SQLite schema,
  migrations, Store capabilities, runtime, health, projections, CLI, and
  lifecycle scripts. Parallel mutation in this shared checkout is unsafe.
- Branch and starting revision: `main` at
  `acd05b8aba1db01c01c086075aa3570d3b054e63`.
- Dependencies are already installed from the repository lockfile.
- Fresh planning baseline: `npm test` passed 287 files and 4,137 tests on
  2026-10-08 in 106.77 seconds. Typecheck, build, and architecture checks were
  also green before specification synthesis; every ticket repeats its affected
  checks and every release repeats the complete verification set.
- Gate 1, Gate 2, and Gate 3 implementation and production rollout
  authorization are approved by the user on 2026-10-08.
- No push, pull request, external issue publication, or deletion of the
  original production database or validated backup is included.

### Mandatory implementation precondition

The checkout contains approved but uncommitted Card Dismissal and rejected
Turn Card root-recovery work that overlaps schema, migrations, lease,
conversation, outbox, and tests. Before T1 starts, that work must complete its
own plans, pass its own verification, and be committed with explicit paths.
The resulting revision becomes this plan's execution base. The SQLite plan
must not stage or absorb those existing changes. This is a workspace ownership
precondition, not a SQLite capability dependency.

All tickets are main-local under the current session policy. Each ticket uses
one serial wave, has `delegation_allowed = false`, and cannot overlap any other
mutation. If delegation is explicitly authorized later, the same ticket may
use one direct child only after real Host/task or Git-worktree isolation is
available; the child cannot spawn, stage, commit, deploy, restart, or touch
excluded files. Main owns Red evidence, diff acceptance, checkbox updates,
explicit staging, atomic commits, release activation, and completion claims.

## Release 1: safe and observable SQLite runtime

- [x] **T1: Bound writer lock waits and expose labeled SQLite diagnostics**

  | Field | Plan |
  | --- | --- |
  | What to build | Give the synchronous writer a fixed low-cardinality operation label, transaction timing, busy/locked classification, rollback evidence, and a bounded diagnostic snapshot. Validate that synchronous wait plus retry allowance stays inside the lease heartbeat safety margin; retry eligible contention only after leaving the transaction, with bounded jitter and a known deadline. |
  | Spec references | SCN-3; INV-5, INV-6; SQLite runtime module; Behavior & Failure Modes. |
  | Dependencies / Blocked by | Mandatory implementation precondition only. |
  | Delegation eligibility and mode | Technically bounded and testable, but main-local under current policy. |
  | Ownership and implementation path | SQLite runtime owns PRAGMAs, labeled transaction receipts, error classification, and diagnostics; configuration owns safety validation; lease/runtime callers supply fixed labels and retry deadlines without exposing SQL or values. |
  | Mutation ownership | `src/store/sqlite/context.ts`, configuration/domain health contracts as required, lease/runtime retry wiring, and focused context/contention/config tests. |
  | Exclusions | No schema redesign, status Worker, query optimization, durability downgrade, SQL/value logging, or production restart. |
  | Isolation and conflicts | Serial shared checkout; conflicts with every later ticket using the transaction context and with the pre-existing lease changes. |
  | Verification seam | Red two-handle contention and invalid-config tests; transaction commit/rollback and stale-owner tests; fixed-label diagnostic assertions; affected Vitest, typecheck, architecture check, and build. |
  | Host capacity | One main-local wave; no child capacity required. |
  | Direct-child boundary | `delegation_allowed = false`. |
  | Acceptance criteria | Busy waits cannot silently consume the valid lease window; retries never suspend inside a transaction; owner/token change fails as lease loss; diagnostics are bounded and payload-free; existing trigger fencing remains effective. |

  Suggested atomic commit: `feat(sqlite): bound writer contention and expose diagnostics`

- [x] **T2: Serve cheap readiness and stale-while-revalidate status**

  | Field | Plan |
  | --- | --- |
  | What to build | Replace the readiness binding scan with a constant-time database probe. Move expensive operational and integrity reads to the existing read-only Worker, coalesce concurrent refreshes, cache the last timestamped good result, and apply bounded refresh/error backoff and separate frequent semantic versus lower-frequency physical audit cadence. |
  | Spec references | SCN-4; INV-6; Diagnostics read module; Behavior & Failure Modes. |
  | Dependencies / Blocked by | T1 supplies the runtime diagnostic contract and busy classification. |
  | Delegation eligibility and mode | Technically bounded with HTTP/Worker seams, but main-local under current policy. |
  | Ownership and implementation path | Health application logic owns freshness and degraded-state semantics; the read-only diagnostics adapter owns bounded queries, `query_only=ON`, busy timeout, and audit cadence; the writer is not used for expensive status reads. |
  | Mutation ownership | Health server/collector and health ports; SQLite operations/integrity Worker and auditor; runtime composition; focused health, operations, and integrity tests. |
  | Exclusions | No card behavior, writable Worker connection, unbounded historical diagnostics, or corruption suppression. |
  | Isolation and conflicts | Serial after T1; conflicts with later schema/operations summary work. |
  | Verification seam | HTTP readiness/status tests plus a Worker integration seam prove constant work, refresh coalescing, stale timestamping, transient busy fallback, fatal integrity handling, and bounded retry. |
  | Host capacity | One main-local wave. |
  | Direct-child boundary | `delegation_allowed = false`. |
  | Acceptance criteria | `/ready` performs a constant-time probe; `/status` cannot synchronously scan on the main writer; concurrent callers share one refresh; busy is temporary unavailability, while confirmed physical corruption fails closed. |

  Suggested atomic commit: `refactor(health): isolate sqlite diagnostics reads`

- [x] **T3: Add current-schema bootstrap, fingerprint, and fast test fixtures**

  | Field | Plan |
  | --- | --- |
  | What to build | Create fresh databases from one canonical current baseline, record a schema epoch/fingerprint, take a verified fast path for current databases, and retain ordered compatibility migrations for historical databases. Give new migrations unique identifiers and provide a per-Vitest-worker current-schema fixture/cloning path for ordinary Store tests. |
  | Spec references | SCN-6; INV-5, INV-6; Compatibility & Migration; Testing Decisions. |
  | Dependencies / Blocked by | T1 for labeled/timed migration transactions. |
  | Delegation eligibility and mode | Main-local because it owns shared schema/migration/test construction. |
  | Ownership and implementation path | Migration infrastructure owns compatibility detection and fingerprint verification; current-schema creation owns fresh initialization; test helpers may bypass historical replay only through the verified canonical baseline. Historical migration `89` remains explicitly represented rather than destructively rewritten. |
  | Mutation ownership | SQLite schema/migration/capability graph and exclusive-lock modules; test Store helpers; migration, reopen, equivalence, and construction-count tests. |
  | Exclusions | No historical row compaction, production `VACUUM`, table-fencing manifest, or business-state changes. |
  | Isolation and conflicts | Serial; conflicts with all later schema and migration tickets. |
  | Verification seam | Fresh-baseline versus fully migrated schema comparison includes tables, indexes, triggers, views, and migration markers; current/mismatch/historical reopen tests; construction statement-count evidence. |
  | Host capacity | One main-local wave. |
  | Direct-child boundary | `delegation_allowed = false`. |
  | Acceptance criteria | Fresh and historically migrated databases are semantically equivalent; current databases skip historical replay only after fingerprint verification; unexplained drift fails closed; ordinary Store tests no longer pay the full compatibility chain. |

  Suggested atomic commit: `refactor(sqlite): bootstrap the current schema directly`

- [x] **T4: Bound startup and periodic recovery batches**

  | Field | Plan |
  | --- | --- |
  | What to build | Convert stale-claim cleanup and authoritative recovery scans to deterministic keyset-paged batches with explicit limits, cumulative snapshot bounds, transactional rollback per batch, and resumable cursors. Preserve terminal ambiguity, no-replay evidence, and later-batch discoverability. |
  | Spec references | SCN-8; INV-3, INV-4, INV-5, INV-6; Behavior & Failure Modes. |
  | Dependencies / Blocked by | T1 for retry/deadline semantics and transaction diagnostics; T3 for current migration primitives. |
  | Delegation eligibility and mode | Main-local due overlap with current lease/recovery work and high-risk no-replay invariants. |
  | Ownership and implementation path | Lease activation owns stale-claim recovery; Core recovery owns snapshot count/byte limits, ordering evidence, keyset continuation, and terminal ambiguity. Each batch commits atomically and yields before the next claim. |
  | Mutation ownership | Lease bootstrap/store, authoritative snapshot and recovery stores/workflows, bounded configuration, and focused startup/recovery/concurrency tests. |
  | Exclusions | No deletion of ambiguity/gap evidence, Agent Input resubmission, Card recovery policy changes, or production data repair. |
  | Isolation and conflicts | Serial after T1/T3; conflicts with the pre-existing recovery files and later retention work. |
  | Verification seam | Large synthetic backlog and oversized snapshot tests assert batch limits, continuation, rollback/reopen, deterministic order, lease deadline preservation, and unchanged no-replay results. |
  | Host capacity | One main-local wave. |
  | Direct-child boundary | `delegation_allowed = false`. |
  | Acceptance criteria | No startup/recovery transaction is proportional to the entire backlog; failed batches do not partially advance; uncertain/ambiguous work remains blocked with evidence; later eligible batches are eventually found. |

  Suggested atomic commit: `refactor(recovery): process sqlite work in bounded batches`

### R1 production gate

- [x] **D1: Install, restart, and observe Release 1**

  Build and install an immutable release, restart through the supported
  lifecycle command, and capture readiness, lease, transaction latency,
  busy/locked count, status refresh duration, Ring backlog, projection gaps,
  uncertain quarantine, database/WAL size, and freelist baselines. Stop and
  roll back the release on any strict rollout-gate regression. This is
  main-local operational work with `delegation_allowed = false`; it does not
  run retention or physical compaction.

  D1 evidence (2026-10-08): installed immutable build
  `sha256:519c12836fb3e8ec0b61eaa5032b14c8a6b1b8e7156d63a61fc9dac5adac5dc6`
  from `fd4cef875ce565c027800bc4593bb9af7e89e752`; forced restart was used only
  after the old process stopped answering `/status` and durable inspection
  proved zero active turns and zero active delivery claims. The replacement
  reached `ready`, held and renewed fencing token 1, completed startup recovery
  in 13.5 seconds, and reported healthy SQLite integrity with `quick_check=ok`.
  Post-restart transaction diagnostics recorded zero busy, locked, or failed
  transactions; the maximum startup transaction was 2.45 seconds and the
  maximum observed steady prepared-delivery write was 534 ms. The retained
  production baseline was 4,467,585,024 database bytes, 6,682,672 WAL bytes,
  341,074 freelist pages, 5,083 pending Ring items, 762 open projection gaps,
  and 42 active quarantines. `/status` remained responsive while cached SQLite
  diagnostics refreshed; existing historical delivery debt kept the aggregate
  status degraded but did not make readiness, lease, integrity, or delivery
  recovery fail.

## Release 2: bounded hot paths

- [x] **T5: Persist Conversation deltas and render only the active timeline page**

  | Field | Plan |
  | --- | --- |
  | What to build | Add the missing item-to-segment index and aggregate visibility/current-page metadata so one canonical event persists only changed timeline items and flags. Ordinary Turn Card convergence loads segment metadata, the active page, and items at or after its durable cursor; explicit recovery retains a separate bounded history interface. |
  | Spec references | SCN-1; INV-1, INV-2, INV-6; Projection write modules. |
  | Dependencies / Blocked by | D1 proves the R1 runtime in production; T3 supplies schema/migration fast paths. |
  | Delegation eligibility and mode | Main-local because current Conversation Segment files contain prior-task edits. |
  | Ownership and implementation path | Conversation Projection owns delta application and view metadata; Turn Card workflow consumes an active-page projection and cannot patch frozen pages; SQLite keeps projection plus Delivery Intent reservation atomic. |
  | Mutation ownership | Conversation Segment domain port/store and migrations; Turn Card workflow/page rendering adapters only as required; focused segment/card/long-output tests. |
  | Exclusions | No conversation reorder, frozen-page mutation, Core protocol change, Session Activity, or retention. |
  | Isolation and conflicts | Serial; conflicts with T7/T11 and existing Conversation Segment changes. |
  | Verification seam | Red statement-count and long-output tests, duplicate/conflict fixtures, page-cursor reads, restart round trips, frozen-page preservation, and query-plan assertion for the new index. |
  | Host capacity | One main-local wave. |
  | Direct-child boundary | `delegation_allowed = false`. |
  | Acceptance criteria | One new event causes delta-sized persistence and active-page work; duplicate events write nothing; incompatible duplicates retain the gap path; frozen pages remain immutable and excluded from ordinary hydration. |

  Suggested atomic commit: `perf(projection): persist and render timeline deltas`

- [x] **T6: Remove repeated Core Inbox point reads from live ingestion**

  | Field | Plan |
  | --- | --- |
  | What to build | Prepare fixed Core Inbox statements once, load event/lane evidence once per batch entry, return inserted sequence/evidence without redundant point reads, and preserve the existing bounded/redacted JSON authority until normalized-field cutover. |
  | Spec references | SCN-1; INV-1, INV-3, INV-6; Core Inbox architecture. |
  | Dependencies / Blocked by | D1 and T3. |
  | Delegation eligibility and mode | Main-local because ingestion and schema tests share the dirty Store bundle. |
  | Ownership and implementation path | Core Inbox Store owns idempotent ingest and sequence allocation; ingress coordination consumes one normalized result and cannot add an Agent Input replay path. |
  | Mutation ownership | Core Inbox Store/runtime ingress and narrow ports; focused inbox/ingress/statement-count tests. |
  | Exclusions | No new Core protocol, normalized discriminator backfill, JSON deletion, or ordering changes. |
  | Isolation and conflicts | Serial; conflicts with T10's discriminator migration. |
  | Verification seam | Red duplicate and batch statement-count tests plus concurrent/reopen ordering, lane evidence, malformed/redacted payload, and rollback tests. |
  | Host capacity | One main-local wave. |
  | Direct-child boundary | `delegation_allowed = false`. |
  | Acceptance criteria | Each event performs one bounded ingest decision; duplicates converge on prior evidence; inserted sequence is returned without a redundant lookup; Core order and no-replay behavior remain unchanged. |

  Suggested atomic commit: `perf(core): remove redundant inbox reads`

- [x] **T7: Persist queue feedback and Worker card selection narrowly**

  | Field | Plan |
  | --- | --- |
  | What to build | Add a queue-feedback projection operation that updates only queue fields, revision, and timestamp and reserves delivery only when the view changes. Replace repeated Worker Main candidate scans with a bounded ranked selection that hydrates large payload only for the winning task. |
  | Spec references | SCN-1; INV-2, INV-6; Queue feedback architecture. |
  | Dependencies / Blocked by | D1 and T3. |
  | Delegation eligibility and mode | Main-local because it spans Store/card projection transaction seams. |
  | Ownership and implementation path | Queue Feedback projection owns queue-only state; Worker Main read projection owns bounded current-task selection; neither rewrites full Run Card/timeline state. Delivery Intent remains transactional with changed views. |
  | Mutation ownership | Queue feedback projector and relevant Store/port; Worker card-context query; focused queue-feedback/worker-card tests. |
  | Exclusions | No queue semantics, fairness, worker lifecycle, card layout, or Delivery Scope change. |
  | Isolation and conflicts | Serial; conflicts with T5 through card projection and with T8 through delivery reservation. |
  | Verification seam | Red unchanged/changed view tests, SQL statement/query-plan counts, large-answer non-hydration fixture, rollback, duplicate, and worker lifecycle preservation tests. |
  | Host capacity | One main-local wave. |
  | Direct-child boundary | `delegation_allowed = false`. |
  | Acceptance criteria | Unchanged queue feedback performs no projection/outbox write; changed feedback updates only queue fields and one delivery intent; Worker Main uses one deterministic candidate and preserves existing displayed state. |

  Suggested atomic commit: `perf(cards): narrow queue feedback persistence`

- [x] **T8: Refill Delivery Rings with one set-based scope-page query**

  | Field | Plan |
  | --- | --- |
  | What to build | Derive checkpoint, authoritative blocker, maximum order, candidate head, and retry time for a bounded page of scopes in one set-based operation. Write only changed watermarks in the same transaction and exclude the look-ahead sentinel from reconciliation. |
  | Spec references | SCN-2; INV-2, INV-4, INV-6; Delivery Ring refill architecture. |
  | Dependencies / Blocked by | D1, T3, and the committed Delivery Ring checkpoint/recovery work in the mandatory precondition. |
  | Delegation eligibility and mode | Main-local due overlap with current outbox/recovery/ring changes. |
  | Ownership and implementation path | Prepared Delivery Store owns authoritative scope-page calculation and checkpoint consistency; Delivery Engine consumes returned pages and preserves Pane/Global isolation and existing fairness. |
  | Mutation ownership | Prepared Delivery/refill ports and Store; Ring delivery engine only as needed; operations diagnostics and focused Ring/refill/query-plan tests. |
  | Exclusions | No new conflict key, Delivery Scope semantics, order bypass, Gateway behavior, or replay of effects. |
  | Isolation and conflicts | Serial; conflicts with T7 and later retention/outbox work. |
  | Verification seam | Production-shaped query-plan and statement-count tests plus multi-scope, retry, supersession, uncertainty, quarantine, rollback, overflow, startup, and sentinel fixtures. |
  | Host capacity | One main-local wave. |
  | Direct-child boundary | `delegation_allowed = false`. |
  | Acceptance criteria | Refill cost is bounded by requested scope page; unchanged checkpoints are not rewritten; only authoritative terminal prefixes advance; uncertain/quarantine blockers remain ordered; no scope leaks into another Pane or Global Ring. |

  Suggested atomic commit: `perf(delivery): refill ring scopes set-wise`

### R2 production gate

- [x] **D2: Install, restart, and observe Release 2**

  Repeat immutable install/restart and compare R2 against the captured R1
  baseline, including long-output projection work, statement counts, Ring
  refill latency/backlog, gaps, quarantine, busy/slow transactions, readiness,
  and lease continuity. Roll back on any strict gate. This is main-local with
  `delegation_allowed = false`; retention remains disabled.

  D2 evidence (2026-10-08): the first immutable candidate
  `sha256:b4764f0ca9e4c8b4c9f8f8a68d9b177670dd75bb3cdc5dd3175160a24dba161a`
  from `0282b97b7641e2d7f477c483a32722ffec8a2c9f` failed closed during the
  production `.4` to `.5` migration because a fixed T5 transaction label was
  82 characters, above the 80-character diagnostic-label bound. A production-
  shaped Red-Green regression test reproduced the exact startup failure; the
  bounded-label repair landed independently as `ee4e9c6d7fb6620c6ec7b42f16a6d7be3ca5ec59`.
  Fresh verification passed 4,236 tests in 289 files, canonical typecheck, and
  canonical build. The replacement immutable build
  `sha256:ee508e3259193823710cc3852727182219b150fff9c847dd5bb3f1918183cb67`
  completed migration bootstrap in 5.23 seconds, recorded epoch `.5` and
  markers 112-114, completed total startup in 22.824 seconds, and reached
  `ready`. Expected and observed identity matched; canonical MainPID 1204697
  owned the configured listener and fencing token 1 renewed normally.
  SQLite integrity remained healthy with `quick_check=ok`; 53 startup and
  early-runtime transaction diagnostics contained zero failed, busy, or locked
  transactions. The retained physical sample was 4,467,585,024 database bytes,
  7,057,592 WAL bytes, and 334,816 freelist pages. The stable Ring sample had
  6,461 pending items, one ready item, zero active claims, 762 open projection
  gaps, and 42 active quarantines. Initial `/status` contention reached 8.7
  seconds while startup work drained, then stabilized at 53 ms and the
  supported `swarm:status` passed identity, ownership, and readiness checks.
  Existing historical debt and one pre-existing `invalid_cursor` ingestion
  retry kept aggregate status degraded without failing the R2 strict gate.

## Release 3: canonical metadata, Session Activity, and retention

- [x] **T9: Generate lease fencing and integrity policy from one schema manifest**

  | Field | Plan |
  | --- | --- |
  | What to build | Introduce a canonical current-table manifest that declares lease fencing or explicit exemption, retention class, and integrity classification. Generate fence trigger membership from it, validate it against `sqlite_master`, and normalize compatible lease expiry comparisons to milliseconds. |
  | Spec references | SCN-6; INV-5, INV-7; SQLite runtime and Compatibility decisions. |
  | Dependencies / Blocked by | D2 and T3; T1 supplies lease-safety timing. |
  | Delegation eligibility and mode | Main-local because manifest completeness controls every mutable table. |
  | Ownership and implementation path | Schema metadata owns table classification; lease activation derives triggers and cannot maintain a second table list; integrity and retention consume the same manifest without accepting arbitrary table names. |
  | Mutation ownership | Schema/migration/lease/integrity modules and manifest types; exhaustive schema/fencing tests. |
  | Exclusions | No removal of trigger fencing, transaction-only replacement, payload compaction, or unrelated table rename. |
  | Isolation and conflicts | Serial; conflicts with T10-T13 schema/retention changes. |
  | Verification seam | Manifest-to-`sqlite_master` equality, every-mutable-table trigger enforcement, exemption validation, stale-owner interleaving, migration/reopen, and architecture dependency tests. |
  | Host capacity | One main-local wave. |
  | Direct-child boundary | `delegation_allowed = false`. |
  | Acceptance criteria | A new durable table without complete classification fails validation; every fenced table rejects stale owners; no manual `FENCED_TABLES` registry remains; millisecond expiry preserves takeover behavior. |

  Suggested atomic commit: `refactor(sqlite): derive policy from a schema manifest`

- [x] **T10: Normalize Core event discriminators with resumable backfill**

  | Field | Plan |
  | --- | --- |
  | What to build | Add indexed `event_type`, `submission_id`, `channel`, and `call_id` columns, dual-write them on ingest, backfill existing JSON rows in bounded resumable batches, verify equivalence, and switch query paths to normalized fields while retaining original event JSON until retention permits compaction. |
  | Spec references | SCN-1, SCN-6; INV-1, INV-3, INV-4, INV-6; Core Inbox and Compatibility decisions. |
  | Dependencies / Blocked by | T6, T9. |
  | Delegation eligibility and mode | Main-local due large-table migration and Core-order authority. |
  | Ownership and implementation path | Core Inbox translation owns discriminator extraction and equality; migration owns bounded backfill/checkpointing; readers switch only after equivalence evidence. |
  | Mutation ownership | Core event domain DTO/schema/migrations/Store/ingress readers; backfill command or runtime; focused compatibility/performance tests. |
  | Exclusions | No new Core event types, event reorder, unsupported default values, or immediate JSON deletion. |
  | Isolation and conflicts | Serial; conflicts with T11 event projection and T12/T13 retention. |
  | Verification seam | Old/new/malformed row fixtures, dual-write equality, interrupted backfill/reopen, index query plans, duplicate ingest, ordering, and no-replay tests. |
  | Host capacity | One main-local wave. |
  | Direct-child boundary | `delegation_allowed = false`. |
  | Acceptance criteria | Normalized queries return exactly the prior JSON-derived identities; incomplete backfill remains resumable and cannot activate cutover; existing event payloads remain available and redacted. |

  Suggested atomic commit: `feat(core): normalize inbox event discriminators`

- [x] **T11: Project bounded per-Pane Session Activity**

  | Field | Plan |
  | --- | --- |
  | What to build | Persist a generation/session/source-epoch-fenced Session Activity snapshot and bounded task, subagent, and tool items for each Primary Pane scope. Project current model, current goal, last Turn state, compaction count, and nullable token/context usage from canonical Core events; Worker activity uses its parent Primary Pane and creates no Worker Ring. |
  | Spec references | SCN-7; INV-1, INV-2, INV-6; Session Activity projection. |
  | Dependencies / Blocked by | T5, T9, T10. |
  | Delegation eligibility and mode | Main-local because it overlaps current Conversation Segment and Core event work. |
  | Ownership and implementation path | Conversation Projection owns the bounded current view; Core event translation supplies activity DTOs; cards consume the projection through a domain port. Exact identity/revision conditional writes reject stale generations. |
  | Mutation ownership | Session Activity domain/ports, schema/migrations/Store/projector, composition and focused projection/card/restart tests. |
  | Exclusions | No full Human/Assistant message copy, Worker Delivery Ring, Herdr Core token producer, or Conversation Segment replacement. |
  | Isolation and conflicts | Serial; conflicts with T5/T10 and retention schema. |
  | Verification seam | Primary/Worker activity, duplicate/out-of-order/stale-generation, restart, bound/expiry, model/goal/compaction, nullable usage, and projection-plus-delivery atomicity tests. |
  | Host capacity | One main-local wave. |
  | Direct-child boundary | `delegation_allowed = false`. |
  | Acceptance criteria | Current activity reconstitutes after restart without duplicating per-Turn history; stale runtime identities cannot overwrite current state; terminal items stay bounded; unavailable usage remains null rather than invented. |

  Suggested atomic commit: `feat(activity): persist bounded session activity`

- [x] **T12: Define the Retention Barrier and permanent Audit Skeleton**

  | Field | Plan |
  | --- | --- |
  | What to build | Add one domain-owned Retention Barrier predicate and schema for permanent payload-free Audit Skeletons. Evaluate terminality, age, references, checkpoints, gaps, uncertainty, quarantine, prerequisites, replacements, and projection reconstruction before allowing compaction. |
  | Spec references | SCN-5; INV-3, INV-4, INV-7; Retention and maintenance modules. |
  | Dependencies / Blocked by | T9-T11 provide canonical classifications, normalized evidence, and current projection dependencies. |
  | Delegation eligibility and mode | Main-local because incorrect policy could erase recovery evidence. |
  | Ownership and implementation path | Delivery and Operations owns the policy; Store adapters supply typed facts and enforce accepted decision plus skeleton creation atomically. The policy receives no table name or SQL. |
  | Mutation ownership | Retention domain/ports, schema/migrations, Store capability, audit queries, and exhaustive policy/round-trip tests. |
  | Exclusions | No payload deletion yet, `VACUUM`, uncertain override, backup deletion, or public workflow-state change. |
  | Isolation and conflicts | Serial; conflicts with T13 and all schema writers. |
  | Verification seam | Table-driven acceptance/refusal tests for every barrier term, identity/hash equality, save/load/post-load audit behavior, duplicate skeleton, stale-owner conflict, rollback, and manifest coverage. |
  | Host capacity | One main-local wave. |
  | Direct-child boundary | `delegation_allowed = false`. |
  | Acceptance criteria | Only proven terminal, unreferenced, reconstructible payloads older than 30 days are eligible; any uncertain/quarantined/unresolved/referenced/prerequisite/replacement gap refuses without mutation; skeleton identity and recovery links are permanent. |

  Suggested atomic commit: `feat(retention): add audit skeleton barriers`

- [x] **T13: Compact eligible payloads in bounded resumable batches**

  | Field | Plan |
  | --- | --- |
  | What to build | Extend retention maintenance to keyset-page eligible Core, timeline, conversation, and delivery payloads through T12, atomically create/confirm their Audit Skeletons, remove only approved large payloads, record bounded refusal counts, honor a time budget, and yield between fenced transactions. |
  | Spec references | SCN-5, SCN-8; INV-3, INV-4, INV-5, INV-6, INV-7; Retention behavior. |
  | Dependencies / Blocked by | T12. |
  | Delegation eligibility and mode | Main-local because this is destructive payload mutation even though identity evidence remains. |
  | Ownership and implementation path | Retention maintainer coordinates pages; the SQLite retention capability owns candidate proof and one-row/batch atomicity; diagnostics expose counts and cursors without payload. |
  | Mutation ownership | Retention Store/runtime/config/status wiring, relevant payload tables/migrations, and focused retention/crash/reopen tests. |
  | Exclusions | No file shrink, active-state pruning, backup deletion, unbounded transaction, or bypass of the Retention Barrier. |
  | Isolation and conflicts | Serial; conflicts with T14 maintenance and all outbox/Core payload work. |
  | Verification seam | Production-shaped safe/unsafe fixtures, repeated/interrupted batches, stale references, concurrent generation changes, injected rollback, restart cursor, time budget, and permanent audit reconstruction. |
  | Host capacity | One main-local wave. |
  | Direct-child boundary | `delegation_allowed = false`. |
  | Acceptance criteria | Accepted payloads compact once and retain Audit Skeletons; refusal is non-mutating; batches are bounded/resumable; a crash loses at most the current transaction; uncertain or newly referenced rows remain complete. |

  Suggested atomic commit: `feat(retention): compact eligible sqlite payloads safely`

### R3 production gate

- [x] **D3: Install, backfill, enable retention, and observe Release 3**

  Install/restart R3, run bounded discriminator backfill to equivalence, verify
  Session Activity, then enable 30-day retention in bounded batches. Capture
  accepted/refused counts, remaining protected evidence, Ring/backlog/gaps,
  lease, readiness, busy/slow transactions, WAL/freelist, and database bytes.
  Stop and roll back the release on any strict gate. This is main-local with
  `delegation_allowed = false`; it does not replace or shrink the database file.

  Production evidence (2026-10-09): installed build
  `sha256:f42a29cc2897d751d7ab2940a88d13b029beeceeb87a6d4892e8f49c4ae07a86`
  at commit `386d8c3699d0aa9ec1de61693f25ec46885bb6b0`; discriminator
  backfill reached its fixed high-water and completed after 178,655 rows.
  Thirty-day payload compaction is enabled with the default bounded batch
  count; the first cursored passes compacted 0 rows and conservatively refused
  rows as `retention_window_open` or `not_terminal`. Readiness, physical and
  semantic integrity, lease renewal beyond 140 seconds, Core ingestion, and
  delivery stayed healthy. Gaps and uncertain effects did not increase;
  post-backfill SQLite transactions had no failures or >=1 second samples, and
  five `/status` requests completed in 11-39 ms. Live delivery continued while
  the Ring changed by +1 pending against +12 delivered over the final 30-second
  sample. The active database was neither replaced nor shrunk.

## Release 4: reversible physical compaction

- [x] **T14: Add a resumable, validated SQLite maintenance-cycle command**

  | Field | Plan |
  | --- | --- |
  | What to build | Add an operator command that records/resumes phases for admission stop, service stop, lease-release proof, consistent backup, retention drain, `VACUUM INTO` candidate creation, physical/foreign-key/schema/semantic validation, same-filesystem atomic activation, restart/smoke checks, and rollback. Enforce private directory and `0600` database/sidecar modes plus `UMask=0077`. |
  | Spec references | SCN-9; INV-5, INV-7, INV-8; Maintenance Cycle and Compatibility decisions. |
  | Dependencies / Blocked by | D3, T3, T9, T13. |
  | Delegation eligibility and mode | Main-local only: it controls production service state and database activation. |
  | Ownership and implementation path | CLI/lifecycle adapter owns operator phases and exact file identities; SQLite validators own physical/schema/semantic evidence; systemd lifecycle owns stop/start; activation never proceeds after unresolved validation. |
  | Mutation ownership | New maintenance CLI/workflow and tests; lifecycle/release scripts, service unit template, composition/config and docs as required. Production files are touched only during D4. |
  | Exclusions | No backup deletion, cross-filesystem non-atomic swap, live-writer vacuum, automatic corruption repair, push, or remote publication. |
  | Isolation and conflicts | Serial; no source mutation or production maintenance may overlap it. |
  | Verification seam | File-backed injected-failure tests at every phase, byte-preserving rollback, symlink/owner/mode/path refusal, 15-minute deadline behavior, exact candidate/source identity, restart/smoke failure, and resume semantics. |
  | Host capacity | One main-local wave with exclusive operator control. |
  | Direct-child boundary | `delegation_allowed = false`. |
  | Acceptance criteria | Active DB is unchanged until all candidate checks pass; any failed gate preserves/restores the original; backup remains; activation is atomic on one filesystem; final files are `0600`; result identifies every phase and rollback outcome. |

  Suggested atomic commit: `feat(ops): add reversible sqlite maintenance cycles`

### R4 production gate

- [x] **D4: Execute the production maintenance cycle and final smoke review**

  Within the approved maximum 15-minute window, capture the preflight metrics,
  stop admission/service, prove lease release, create and validate the backup,
  drain only eligible retention, create and validate the compacted candidate,
  atomically activate it, restart, and smoke-test `/health`, `/ready`, `/status`,
  Herdr convergence, Ring delivery, Session Activity, and Lark projection.
  Roll back immediately on readiness degradation, growing Ring backlog, new
  gaps/uncertain quarantine, lease loss, busy/slow regression, validation
  failure, or deadline exhaustion. Preserve the original and backup. This is
  main-local with `delegation_allowed = false`.

  Production evidence (2026-10-09): installed build
  `sha256:cff794950bf013a985298f628c712988c5276f5d50b2b09ee6ffc8bb48a50fb9`
  at commit `eab58a825e9899fac8647e72e306a9a33168c208`. Maintenance cycle
  `94c8d877-1447-4bdc-9fb9-d0fcad47bd34` completed `smoke_passed` in about
  198 seconds, activated the validated candidate, and preserved both the
  backup and original. Backup and candidate validation reported `quick_check`
  `ok`, zero foreign-key issues, zero semantic issues, and a valid schema.
  The database shrank from 4,467,585,024 to 3,351,056,384 bytes (25.0%);
  the active database and sidecars remained mode `0600`. Post-activation
  readiness was `ready`, the lease remained held, SQLite integrity was
  healthy, Core ingestion had no lagging sessions, both reconciliation loops
  converged, Card convergence had no pending work or failures, Session
  Activity continued to project, and Lark delivered new card replies and
  updates. A 120-second observation had zero status-poll failures. Ring counts
  showed bounded live-traffic churn while delivery continued, with no ready or
  retry-wait work, no new projection gaps after activation, and no increase in
  uncertain effects; therefore no rollback gate was met. All four earlier
  failed/rolled-back cycle journals and their retained artifacts remain
  preserved.

## Dependency and execution waves

```text
Existing Card/Recovery work -> verified atomic commits -> execution base
                                      |
                                      v
R1: T1 -> T2 -> T3 -> T4 -> D1
                              |
                              v
R2: T5 -> T6 -> T7 -> T8 -> D2
                              |
                              v
R3: T9 -> T10 -> T11 -> T12 -> T13 -> D3
                                           |
                                           v
R4: T14 -> D4
```

The arrows show the safe serialized wave order, not extra functional
dependencies beyond those recorded on each ticket. Every wave contains one
main-local ticket or one main-local production gate. On resume, the unchecked
boxes plus committed Git state determine the next wave; no private scheduler
state is persisted.

## Coverage check

| Approved behavior | Responsible tickets/gates |
| --- | --- |
| SCN-1 incremental long-output projection | T5, T6, T7, T10 |
| SCN-2 bounded set-based Ring refill | T8 |
| SCN-3 lease-safe lock contention | T1, T4 |
| SCN-4 nonblocking readiness/status | T1, T2 |
| SCN-5 safe payload compaction | T9, T12, T13 |
| SCN-6 schema metadata cannot drift | T3, T9 |
| SCN-7 bounded Session Activity | T10, T11 |
| SCN-8 bounded recovery | T1, T4, T13 |
| SCN-9 reversible production compaction | T14, D4 |
| INV-1 Core order authority | T5, T6, T10, T11 |
| INV-2 atomic delivery intent | T5, T7, T8, T11 |
| INV-3 no replay | T4, T6, T10, T12, T13 |
| INV-4 uncertainty preservation | T4, T8, T10, T12, T13 |
| INV-5 fenced writer | T1, T3, T4, T9, T12-T14 |
| INV-6 bounded live work | T1-T8, T10, T11, T13 |
| INV-7 permanent accountability | T9, T12-T14 |
| INV-8 reversible maintenance | T14, D4 |

Every scenario and invariant has an implementation owner, no dependency cycle
exists, and no ticket relies on an unresolved architecture decision. The only
implementation blocker is the explicit ownership precondition for the current
overlapping worktree changes.

## Per-release and final delivery checks

For every ticket:

1. establish focused Red evidence for changed behavior, or structural
   before/after evidence for an approved behavior-preserving refactor;
2. make the smallest Green implementation and run affected tests;
3. run `npm run typecheck`, `npm run architecture:check`, and `npm run build`;
4. inspect the complete task diff and `git diff --check`;
5. stage only explicit ticket-owned paths and create one Conventional Commit,
   after verifying no automated CLI attribution trailer is present.

Before each D1-D4 gate, also run `npm run public:audit` and the full `npm test`.
After T14/D4, delivery-coder performs independent Standards and Specification
review, maps actual tests to every SCN/INV, verifies all checked boxes and
commit boundaries, and repeats the complete suite. No push or pull request is
performed without separate authorization.
