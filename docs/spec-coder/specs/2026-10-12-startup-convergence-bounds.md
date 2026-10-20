# Startup Convergence Bounds

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Production startup remains `ready`, but one historical Binding keeps
`startupViews` permanently degraded. Binding
`26abce39-e212-4691-a0d4-ba01b56a7234` is archived, unattached, and has no
Pane. Its Topic View is archived at `viewVersion=23` and
`deliveredVersion=22`; it has no Run Cards, pending outbound replies, or active
delivery recovery. `listStartupViewBindings()` nevertheless selects it solely
for that one-version presentation difference. `StartupViewConverger` then asks
`MainCardWorkflow` to reserve a Pane-owned update after the authoritative Pane
identity has been cleared, so SQLite correctly rejects the new intent with
`invalid_delivery_scope`. The same Binding is retried indefinitely and keeps
startup diagnostics in `retry_wait`.

The same startup stage also performs up to sixteen retained Session Activity
recovery pages synchronously. The latest production restart processed eight
pages, each taking approximately 575–655 ms, adding roughly five seconds to
startup view convergence even though the recovery already has a durable cursor
and an existing background full-rescan retry path.

## Solution

Apply two bounded changes inside the existing startup convergence owners:

- `SqliteProjectionStore.listStartupViewBindings()` must not select a Binding
  whose lifecycle is terminal (`archived`, `closed`, or `failed`) and whose Pane
  identity is absent. Existing pending Delivery and recovery work remain owned
  by the Delivery Engine and startup outbox recovery, not by synthesizing a new
  Main/Answer projection. `StartupViewConverger` repeats the same guard before
  view reconstruction to close the selection-to-use race, including a
  `draining` Binding that loses its Pane concurrently.
- Process at most two retained Session Activity pages per convergence pass.
  When more evidence remains, keep the existing cursor, return the existing
  bounded-rescan signal, and let `StartupViewRecovery` resume from that exact
  cursor. This preserves evidence while yielding startup after at most 256
  retained results per pass.

The local selection-and-yield approach was auto-selected under explicit
autonomous authority. Catching the SQLite error would weaken the delivery-scope
fence, while modifying production `deliveredVersion` would invent an external
ACK. A new recovery subsystem is unnecessary because cursor continuation and
background retry already exist.

## User Stories

### SCN-1: An archived Binding without a Pane does not block startup

When a terminal Binding has no authoritative Pane, a stale or missing Topic
View does not cause a new Pane-owned Main/Answer projection. Startup convergence
returns no failed Binding ID, creates no outbound reply, and leaves historical
Topic View and delivery evidence unchanged.

### SCN-2: Deliverable Bindings retain existing convergence behavior

Active Bindings and terminal Bindings that still retain an authoritative Pane
remain eligible under the existing dirty-view, actionable-card, pending-delivery,
and recovery predicates. If a selected Binding becomes terminal and loses its
Pane before projection, the application guard safely stops new projection.

### SCN-3: Retained Session Activity yields without losing its cursor

When more than two 128-item retained recovery pages remain, one convergence
pass processes exactly two pages and reports bounded continuation. The next
full-rescan retry begins after the second page's cursor and eventually drains
the remaining evidence without replaying already recovered Agent activity.

## Implementation Decisions

### INV-1: New Pane-owned projection requires an authoritative Pane

SQLite delivery-scope and owner-generation fences remain unchanged. A terminal
Binding with `paneId=null` is an undeliverable historical owner for new
projection work. Its previously prepared or delivered effects remain durable
history and are handled by existing Delivery recovery/retention paths.

### INV-2: Selection and execution both enforce terminal ownership

The projection store owns the authoritative startup read-model query and
filters terminal/null-pane rows before returning them. The coordinator owns a
second guard immediately before reconstructing views so a concurrent lifecycle
transition cannot reintroduce an invalid intent. Neither guard updates Topic
View versions or Binding state.

### INV-3: Retained recovery is bounded by pages, not discarded

`StartupViewConverger` owns the per-pass page budget. Two pages is a deterministic
bound of at most 256 retained results. `retainedActivityRecoveryCursor` remains
the continuation authority, and `StartupViewRecovery` remains the retry owner.
Only `remaining=false` clears the cursor and permits that part of convergence to
complete.

### ARCH-1: Reuse existing deep modules and ports

No new port, queue, table, worker, timer, or persisted recovery record is added.
The SQLite projection module deepens its existing selection query; the startup
converger deepens its existing race guard and page budget. Source dependencies
and composition remain unchanged.

### ARCH-2: Do not manufacture presentation settlement

The fix never advances `deliveredVersion`, creates a fake checkpoint, catches
scope errors by message text, or retries an uncertain external effect. A final
archived-card update may be omitted after Pane ownership is gone; this bounded
message loss is preferred to permanent startup retry or a false ACK.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, ARCH-1, ARCH-2

- Add a real-store/MainCardWorkflow regression test matching the production
  archived/unattached/null-pane/dirty-Topic state. It must initially return the
  Binding as failed with `invalid_delivery_scope`, then return no failure and
  reserve no outbox work while preserving `viewVersion=23` and
  `deliveredVersion=22`.
- Verify `listStartupViewBindings()` excludes terminal/null-pane rows but keeps
  an active Binding and a terminal Binding that still has a Pane when their
  views require convergence. Add a coordinator race case for a selected
  terminal/null-pane Binding supplied by a test store.
- Change retained recovery tests to prove one pass invokes exactly two pages,
  throws the existing bounded continuation signal, and the next pass resumes
  with `afterCursor` from page two and completes.
- Run startup-focused tests, typecheck, build, architecture checks, the full
  Vitest suite, and the live `/status` feedback loop. After deployment,
  `startupViews.pendingCount` must reach zero, repeated
  `startup-view-binding-failed` logs for the production Binding must stop, and
  readiness/backlog/latency must not regress.

## Out of Scope

No production SQLite edit, Topic View settlement rewrite, schema migration,
Delivery scope relaxation, retry-error string matching, pending/dead-letter
replay, Session Activity query/index redesign, generic startup scheduler,
systemd ownership-probe change, or unrelated archived Binding cleanup is
included.

## Further Notes

Workspace mode: in-place work inside the existing isolated clean worktree
`/tmp/herdr-agent-swarm-main-ring-stability-20261012`, branch `main`, starting
revision `c4a1eb43730bb9846fe45b6c3f633bda14a704b6`. The original user checkout
remains untouched. Locked dependencies were present and `npm ls --depth=0`
passed.

Fresh baseline records for request `round-20261012-startup-convergence-bounds`:

```spec-coder-verification
{"record_id":"1fdb056ace0042b0988d82fa044f43dd","command":["/usr/bin/npx","vitest","run","tests/startup-view-converger.test.ts","tests/startup-view-recovery.test.ts"],"exit_code":0,"status":"captured","observed_at":"2026-10-12T19:43:00.822323+00:00","result":"2 files and 35 tests passed"}
```

```spec-coder-verification
{"record_id":"7a14bc1e79b1430393e3964a44ef0bb4","command":["/usr/bin/npm","run","typecheck"],"exit_code":0,"status":"captured","observed_at":"2026-10-12T19:43:19.066778+00:00"}
```

```spec-coder-verification
{"record_id":"dd394cfc002d48a19d300ac7ba8fe846","command":["/usr/bin/npm","run","build"],"exit_code":0,"status":"captured","observed_at":"2026-10-12T19:43:39.307343+00:00","build_id":"sha256:22f8168269220d16d1dec3b77e5659b3eb7adec4e7e3f181439b0d785dec883c"}
```

The live red-capable feedback command is
`curl -fsS http://127.0.0.1:8788/status | jq -e
'.startupRecovery.startupViews.pendingCount == 0'`; it currently exits nonzero.
No glossary or ADR change is warranted because domain language and durable
architecture are unchanged. Approach selection and Gate 1 were auto-selected
under explicit autonomous authority; this document is the unique Gate 2
recommendation.
