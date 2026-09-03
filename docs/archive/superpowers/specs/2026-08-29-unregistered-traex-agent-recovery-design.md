# Unregistered TraeX Agent Recovery

## Problem

An active topic binding can point at a live Herdr pane whose TraeX process is
visible but whose pane is absent from Herdr's `agents[]` registry. This occurs
for legacy panes created before native `herdr agent prompt` became mandatory.

The current runtime reconciliation treats the live pane and TraeX process as a
successful observation. It therefore keeps the binding `attached`, even though
ordinary prompt delivery deterministically fails with `agent_not_found`. The
failure is discovered only after a user sends work. Restarting the bridge does
not repair Herdr's Agent registry, and Herdr 0.7.5 exposes no operation that
adopts an already-running process as an Agent. `herdr agent attach` attaches a
client to an existing registered Agent; it is not a registration API.

## Decision

Treat native Agent registration as part of runtime health for TraeX bindings.
A live pane is dispatchable only when all of the following are true:

- the pane identity, workspace, project cwd, and terminal identity match the
  binding;
- TraeX is running;
- Herdr reports a compatible native Agent kind (`codex`, or a future native
  `traex` kind); and
- the Agent has a recognized lifecycle state.

When the pane and TraeX process exist but native Agent registration is absent,
runtime reconciliation marks the binding `degraded` and records a bounded,
user-facing reason. It does not mark the pane missing or orphaned, because the
terminal and process still exist. A later valid Agent observation restores the
binding to `attached` through the normal fenced reconciliation path.

The recovery action is `/swarm reset`. It provisions and verifies a new
Herdr-recognized TraeX Agent before atomically moving the existing Lark topic to
the replacement binding. It must remain available to the binding creator while
the binding is degraded.

## Recovery flow

```text
fresh Herdr snapshot
  -> matching pane and TraeX process exist
  -> compatible entry absent from agents[]
  -> fenced binding transition: attached -> degraded
  -> Main Card explains native Agent registration failure
  -> creator invokes /swarm reset
  -> create replacement pane
  -> start TraeX
  -> require compatible Agent in agents[] and idle/done
  -> atomic topic cutover
  -> archive old binding and detach any uncertain observer
  -> retain old pane unless fresh observation proves it safe to close
```

No operation sends input to the legacy pane. The failed prompt remains failed;
queued prompts belonging to the old binding are cancelled during cutover, and
possibly delivered work is detached without replay.

## Runtime classification

The Herdr adapter already merges pane and Agent records. It must preserve
enough information for reconciliation to distinguish these cases:

| Observation | Binding result | Recovery |
| --- | --- | --- |
| Pane missing | existing degradation/orphan policy | reattach or replace |
| Pane exists, TraeX absent | existing process/runtime failure policy | inspect or replace |
| Pane exists, TraeX present, compatible Agent absent | degraded | `/swarm reset` |
| Compatible Agent present | attached with observed Agent state | automatic convergence |
| Agent identity conflicts with a persisted native session | identity mismatch; never silently attach | explicit operator recovery |

An `unknown` pane status without a compatible `agentKind` is not sufficient for
dispatch. Conversely, a transient Agent snapshot failure must not immediately
orphan the pane or cancel work. The existing degradation counter and fenced
binding generation remain the concurrency controls.

## User-visible behavior

The Main Card shows that TraeX is present but not registered as a Herdr Agent,
and recommends `/swarm reset`. It must not claim that the pane is missing. The
reset action remains creator-only and is visible or accepted for both attached
and degraded active bindings.

If reset provisioning fails, the original topic binding and legacy pane remain
unchanged. If provisioning succeeds, the success message identifies the new
pane and explains whether the old pane was retained.

## Safety and durability

- Never fall back to `pane send-text` or raw Enter for ordinary prompts.
- Never automatically restart or terminate the legacy TraeX process.
- Never replay the failed prompt or any prompt that may have reached TraeX.
- Persist the degraded state and card intent before Lark delivery.
- Fence every observation and cutover by binding ID, pane ID, and generation.
- Verify the replacement through Herdr Agent registration before cutover.
- Preserve the old pane when its state is `unknown`, `working`, `blocked`, or
  its identity cannot be confirmed.

## Deployment correction

The host currently runs two intentionally separate bridge configurations: the
managed `herdr-agent-swarm.service` on port 8788 and a legacy plugin process on
port 8787. They use different Lark Apps, chats, and SQLite databases. The
`task-ulqf` topic belongs to the legacy port-8787 configuration. Deployment
must update or restart only the owning configuration; it must not stop the
other App or assume that an HTTP response on port 8787 represents the systemd
unit on port 8788.

Before restart, inspect queued/running prompts, active instance turns, pending
outbox entries, lease ownership, and the exact process environment. Build
identity must match after restart.

## Testing

Add focused tests proving that:

- a live TraeX pane absent from `agents[]` is classified as non-dispatchable;
- reconciliation degrades rather than orphans that binding;
- a later compatible Agent observation restores attachment;
- `/swarm reset` remains accepted for a degraded active binding;
- reset validates the replacement Agent before cutover;
- reset failure leaves the original binding active and does not send terminal
  input;
- cutover cancels queued old-generation prompts and detaches uncertain running
  work without replay; and
- card text distinguishes an unregistered Agent from a missing pane.

Run the focused adapter, reconciler, provisioning, card, and SQLite tests, then
the full Vitest suite, `npm run typecheck`, and `npm run build`. Production
verification must show the replacement pane in `herdr agent list`, the topic
bound to that pane, no queued/running prompt replay, an empty pending outbox,
and matching expected/observed build identity.
