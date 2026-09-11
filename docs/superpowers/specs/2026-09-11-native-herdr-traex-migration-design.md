# Native Herdr TraeX Migration Design

## Goal

Complete the move from the retired PATH-level TraeX compatibility shim to Herdr
0.9's native `traex` Agent kind as a deliberate clean break. `herdr:traex` is the
only valid live TraeX session source. Legacy `herdr:codex` and
`herdr-traex-shim` records remain immutable audit history but are not reconciled,
recovered, controlled, or rewritten. Keep TraeX-specific transcript observation
and model control behind explicit internal interfaces instead of presenting them
as Herdr features.

## Observed baseline

The installed Herdr 0.9 runtime starts and observes TraeX natively. Its snapshot
uses this session tuple:

```text
source = herdr:traex
agent  = traex
kind   = id
value  = <TraeX thread UUID>
```

The installed service and private environment resolve `HERDR_BIN` to the official
Herdr 0.9 binary. Persisted bindings may still contain the older `herdr:codex` or
`herdr-traex-shim` source, and already-running panes may retain process-local
artifacts from the environment in which they started. Herdr 0.9 exposes native
Agent start, prompt, wait, read, and attach behavior, but its public CLI does not
expose the retired shim's `steer`, `model-list`, or `model-prompt` extensions.

## Considered approaches

### Immediate cutover and database rewrite

Point `HERDR_BIN` at the official binary, rewrite all session sources to
`herdr:traex`, and remove the shim in one release. This minimizes the final code
surface but is unsafe: session source participates in observer cache keys, prompt
and turn-control fences, and binding replacement decisions. A partial rewrite can
make a live turn look stale or make an unchanged pane look replaced.

### Permanent multi-source compatibility

Treat all three source strings as interchangeable forever and never rewrite
stored identity. This reduces immediate disruption but leaves historical
transport details embedded throughout domain logic and makes future fencing
changes harder to audit. It is rejected because the migration explicitly no
longer carries compatibility behavior.

### Staged native cutover with one compatibility seam

Introduce one domain-level TraeX session identity policy, make runtime fencing and
observer keys use it, add native capability checks, and only then switch the
service binary. Existing binding rows remain unchanged during the first cutover;
new bindings store the native tuple. A later transactional migration may rewrite
quiescent legacy identities together with every dependent durable fence. Once the
native path is proven, delete only the shim responsibilities that Herdr now owns.

This was the initial migration approach and enabled the live cutover. It is no
longer the target end state because the native release has been installed and
verified.

### Native-only clean break

Accept only the exact native tuple shape headed by `source = herdr:traex`. Remove
the semantic alias layer, legacy-source eligibility, and tests that promise legacy
recovery. Do not rewrite old durable tuples: rewriting a session source without
atomically proving every prompt and control fence is riskier than allowing the
existing reconciliation path to orphan an obsolete binding. Operators create or
claim a native binding when continued work is required.

This is the chosen final approach. It produces one runtime identity contract and
preserves the no-replay invariant by refusing to adopt ambiguous historical work.

## Session identity policy

A live TraeX session is valid only when its exact tuple has:

```text
source = herdr:traex
agent  = traex
kind   = id
value  = <non-empty TraeX thread UUID>
```

Runtime equality is exact equality across source, agent, kind, and value. Pane,
terminal, binding generation, and turn identity fences remain independent and
must also match wherever the workflow currently requires them. There is no
canonical alias function and no special treatment for `herdr:codex` or
`herdr-traex-shim`.

Existing database rows are not bulk-rewritten or deleted. A legacy source can be
shown in diagnostics and retained for audit, but it is ineligible for transcript
observation, model control, prompt dispatch, attachment recovery, and orphan
recovery. Normal reconciliation moves it through the existing detached, orphaned,
or failed lifecycle according to the surrounding durable state. No code may infer
that changing only the source spelling proves continuity. Operators must create
or claim a native binding to continue work.

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

The operational configuration uses the official absolute Herdr binary. Install
and restart continue through the normal safety gates. A failed readiness check
rolls configuration back to the previous release; it never retries or replays a
prompt.

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
TraeX adapter. Model selection accepts only native `herdr:traex` sessions while
preserving the complete exact session tuple and turn fences.

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
verification. The installed shim must remain absent after the running service
uses the official binary. Stale release directories may be removed only when
their exact paths are resolved and no live process references them. Historical
source strings may remain only in database contents, archived design documents,
and migration notes—not in active runtime branches or promises.

The real-user smoke command resolves its status endpoint in this order:

1. explicit `BRIDGE_STATUS_URL`;
2. `BRIDGE_HTTP_HOST` and `BRIDGE_HTTP_PORT` loaded from the private service
   environment;
3. application schema defaults.

It remains observational and never sends a Lark message itself.

## Delivery slices

### Slice 1: remove the compatibility seam

Delete source canonicalization and make pane identity, reconciliation, transcript
observer keys, model-session eligibility, and persistence accept only exact native
sessions. Keep durable SQL fences exact. Do not rewrite database rows.

### Slice 2: native setup and doctor gate

Replace shim readiness checks with version, kind, and integration checks. Add
fixtures for malformed output, old versions, missing TraeX kind, stale/missing
integration, and success. Update operator-facing remediation.

### Slice 3: controlled live cutover

Build and install an immutable service release, update the private environment to
the official absolute Herdr binary, and restart through the supported safety
gate. Verify readiness, build identity, active binding identity, prompt/outbox
health, and one non-destructive native TraeX observation. Roll back if native
bindings unexpectedly detach, generations change, session values diverge, or any
prompt is replayed. Legacy bindings becoming ineligible is expected.

### Slice 4: control-port extraction and shim removal

Extract model control, remove unsupported steering claims, delete the obsolete
shim implementation and tests, and update README and architecture documentation.
Run a final source/reference audit before unlinking the installed wrapper.

### Slice 5: operational cleanup

Fix the real-user smoke endpoint resolution, verify the installed native release,
and allow legacy bindings to age out through normal lifecycle handling. A
transactional legacy-source migration is explicitly out of scope. Separately
validate Herdr 0.9's socket subscription contract before simplifying event
subscriptions.

## Verification

Focused tests must prove:

- only `herdr:traex` is a valid TraeX session source;
- `herdr:codex`, `herdr-traex-shim`, unknown sources, mismatched agents,
  mismatched kinds, and changed values are rejected;
- legacy/native source changes detach or orphan rather than preserving a binding;
- different session values still detach or reject stale work;
- exact durable prompt and turn-control fences remain effective;
- setup rejects pre-0.9 Herdr, missing `traex`, non-current integration, malformed
  output, and the stale shim path;
- model selection accepts native sessions without weakening tuple/value fencing;
- the real-user smoke resolves explicit overrides and configured non-default
  endpoints without sending external messages.

Before each source handoff, run affected Vitest files, `npm run typecheck`, and
`npm run build`. Because reconciliation and shared runtime behavior change, run
the full test suite before live cutover. Live acceptance requires unchanged
generations for native attached bindings, expected orphaning of legacy bindings,
no prompt replay, no stalled outbox lanes, ready health, and a native snapshot
whose exact thread UUID resolves to the expected TraeX transcript.

## Non-goals

- Bulk-rewriting or deleting legacy binding identities.
- Preserving runtime compatibility for legacy session sources.
- Replacing snapshot reconciliation with socket events.
- Implementing remote approvals, arbitrary terminal input, or process control.
- Claiming Herdr provides model selection or steering when its public contract
  does not.
- Removing precise transcript observation or no-replay recovery.
