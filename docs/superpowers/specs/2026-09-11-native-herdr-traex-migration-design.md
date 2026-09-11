# Native Herdr TraeX Migration Design

## Goal

Move Agent Swarm from its PATH-level TraeX compatibility shim to Herdr 0.9's
native `traex` Agent kind without replacing, orphaning, or replaying work owned by
existing bindings. Keep TraeX-specific transcript observation and model control
behind explicit internal interfaces instead of presenting them as Herdr features.

## Observed baseline

The installed Herdr 0.9 runtime starts and observes TraeX natively. Its snapshot
uses this session tuple:

```text
source = herdr:traex
agent  = traex
kind   = id
value  = <TraeX thread UUID>
```

The service still resolves `HERDR_BIN` to the installed command shim. Persisted
bindings predominantly use the older `herdr:codex` source, while some code and
tests use `herdr-traex-shim`. Five observed active, attached bindings still carry
the legacy source. Herdr 0.9 exposes native Agent start, prompt, wait, read, and
attach behavior, but its public CLI does not expose the shim's `steer`,
`model-list`, or `model-prompt` extensions.

## Considered approaches

### Immediate cutover and database rewrite

Point `HERDR_BIN` at the official binary, rewrite all session sources to
`herdr:traex`, and remove the shim in one release. This minimizes the final code
surface but is unsafe: session source participates in observer cache keys, prompt
and turn-control fences, and binding replacement decisions. A partial rewrite can
make a live turn look stale or make an unchanged pane look replaced.

### Permanent multi-source compatibility

Treat all three source strings as interchangeable forever and never rewrite
stored identity. This is operationally safe but leaves historical transport
details embedded throughout domain logic and makes future fencing changes harder
to audit.

### Staged native cutover with one compatibility seam

Introduce one domain-level TraeX session identity policy, make runtime fencing and
observer keys use it, add native capability checks, and only then switch the
service binary. Existing binding rows remain unchanged during the first cutover;
new bindings store the native tuple. A later transactional migration may rewrite
quiescent legacy identities together with every dependent durable fence. Once the
native path is proven, delete only the shim responsibilities that Herdr now owns.

This is the chosen approach because it preserves no-replay and exact-turn fencing
while making the compatibility logic small and removable.

## Session identity policy

Add a pure domain module that distinguishes exact representation from semantic
TraeX identity. For sessions whose agent is `traex`, these sources are aliases:

```text
herdr:codex
herdr-traex-shim
herdr:traex
```

The canonical semantic source is `herdr:traex`. Source aliasing is allowed only
when agent, kind, and value also match exactly. It must never make different
thread UUIDs, path identities, agents, panes, binding generations, or terminal
identities equivalent. Unknown sources remain exact strings. In particular, an
ordinary Codex session is never normalized to TraeX merely because its source is
`herdr:codex`.

The shared policy supplies:

- semantic equality for pane/binding reconciliation;
- a canonical cache identity for transcript observers;
- canonicalization for newly persisted native observations;
- explicit detection of a legacy representation for diagnostics and later
  migration.

All existing session comparisons must be audited. In-memory comparisons use the
semantic policy. Durable operations that intentionally fence against a stored
tuple continue to use the exact stored representation until that tuple and all
dependent rows can be migrated atomically. This prevents an active prompt or
turn-control operation from becoming stale merely because its source spelling
changed.

The first native cutover does not bulk-update SQLite. Existing bindings retain
their stored tuple, while transcript cache identity no longer churns when Herdr
reports the native alias. Newly provisioned or attached bindings persist
`herdr:traex`. A follow-up migration is allowed only when it either proves the
binding is quiescent or updates the binding and every durable session fence in
one transaction. It must not increment generation.

## Native capability gate

Replace the setup probe's shim installer check with an official-Herdr capability
probe. Setup and doctor must report independently whether:

1. the configured executable responds and satisfies the minimum supported Herdr
   version, initially 0.9.0;
2. the Agent kind list contains `traex`;
3. the TraeX integration is installed and reports `current`;
4. configured workspaces remain inspectable.

Command output is external input and remains Zod-validated at the adapter
boundary. Failures identify the configured executable and the failed capability;
they no longer recommend installing this repository's shim. The probe must reject
a PATH wrapper that reports a stale validated Herdr version even if delegated
workspace commands happen to work.

The operational cutover updates `HERDR_BIN` to the official absolute Herdr
binary only after compatibility tests pass. It uses the normal install and
restart safety gates. A failed readiness check rolls configuration back to the
previous release; it never retries or replays a prompt.

## Runtime ownership after cutover

Herdr owns Agent start, prompt submission, wait/state, native session projection,
and Agent lifecycle events. Agent Swarm continues to own durable binding and
prompt state, reconciliation, no-replay recovery, and Lark projection.

TraeX JSONL observation remains in Agent Swarm. The transcript contains exact
answer text and runtime turn IDs needed for detached observation and recovery;
native Agent support does not replace it. Periodic Herdr snapshot reconciliation
also remains authoritative. Socket events continue to be bounded wake-up hints
until a separate Herdr 0.9 event-contract test proves that subscription code can
be simplified.

## TraeX-specific controls

Model listing and interactive model selection are not Herdr 0.9 CLI operations.
Move them from shim-shaped Herdr commands to a narrow `TraexControlPort` and a
TraeX adapter. Model selection accepts any semantically valid TraeX session,
including native `herdr:traex`, while preserving exact session-value fencing.

Active-turn steering remains unsupported unless a separately tested TraeX-native
control channel is introduced. Removing the shim's `steer` route must not cause
the driver to advertise steering support. Keyboard injection and remote approval
must not be used as substitutes.

## Shim retirement

After native cutover and live observation succeed, remove the responsibilities
now owned by Herdr:

- PATH-level command interception and version acceptance;
- TraeX start and pane launcher translation;
- reporter sidecar and snapshot identity rewriting;
- shim install, status, and uninstall package scripts;
- shim-only tests and current-architecture documentation.

Removal must be based on import and behavior audits, not directory deletion. The
TraeX transcript reader, terminal redaction, exact-turn fences, detached observer
recovery, and uncertain-dispatch no-replay behavior remain. The installed shim is
unlinked only after the running service uses the official binary and passes live
verification.

## Delivery slices

### Slice 1: compatibility seam

Add the session identity policy and focused tests. Apply it to pane identity,
reconciliation, transcript observer keys, and model-session eligibility. Audit
all exact comparisons and document why durable SQL fences remain exact. No
service configuration or database rows change in this slice.

### Slice 2: native setup and doctor gate

Replace shim readiness checks with version, kind, and integration checks. Add
fixtures for malformed output, old versions, missing TraeX kind, stale/missing
integration, and success. Update operator-facing remediation.

### Slice 3: controlled live cutover

Build and install an immutable service release, update the private environment to
the official absolute Herdr binary, and restart through the supported safety
gate. Verify readiness, build identity, active binding identity, prompt/outbox
health, and one non-destructive native TraeX observation. Roll back if legacy
bindings detach, generations change, or session values diverge.

### Slice 4: control-port extraction and shim removal

Extract model control, remove unsupported steering claims, delete the obsolete
shim implementation and tests, and update README and architecture documentation.
Run a final source/reference audit before unlinking the installed wrapper.

### Slice 5: optional cleanup

Design a transactional canonical-source migration only if retaining legacy source
strings has measurable operational cost. Separately validate Herdr 0.9's socket
subscription contract before simplifying event subscriptions. Neither cleanup is
required for native cutover.

## Verification

Focused tests must prove:

- all three TraeX source representations compare equal only with identical
  agent, kind, and value;
- native/legacy alias changes do not increment generation, replace a binding, or
  change transcript observer identity;
- different session values still detach or reject stale work;
- exact durable prompt and turn-control fences remain effective;
- setup rejects pre-0.9 Herdr, missing `traex`, non-current integration, malformed
  output, and the stale shim path;
- model selection accepts native sessions without weakening value fencing.

Before each source handoff, run affected Vitest files, `npm run typecheck`, and
`npm run build`. Because reconciliation and shared runtime behavior change, run
the full test suite before live cutover. Live acceptance requires unchanged
generations for existing attached bindings, no newly failed prompts, no stalled
outbox lanes, ready health, and a native snapshot whose exact thread UUID resolves
to the expected TraeX transcript.

## Non-goals

- Bulk-rewriting live binding identities during the initial cutover.
- Treating source aliasing as permission to ignore session value or generation.
- Replacing snapshot reconciliation with socket events.
- Implementing remote approvals, arbitrary terminal input, or process control.
- Claiming Herdr provides model selection or steering when its public contract
  does not.
- Removing precise transcript observation or no-replay recovery.
