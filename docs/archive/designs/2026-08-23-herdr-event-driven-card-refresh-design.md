# Historical: Herdr Event-Driven Card Refresh Design

> Superseded by the current reconciliation and CardKit Answer streaming model.
> This record is retained for decision history and must not be treated as current.

## Goal

Use native Herdr workspace, tab, and pane lifecycle events to refresh affected
Lark cards promptly while retaining Herdr snapshots as the source of truth and
periodic reconciliation as recovery. TraeX terminal parsing remains responsible
for answer and task content.

## Event Transport

The plugin subscribes to pane lifecycle and agent-detection events plus the
workspace and tab events that can change pane visibility or identity. Each hook
invokes a short Node command. The command bounds and appends the Herdr-provided
event name and JSON context to an inbox under `$HERDR_PLUGIN_STATE_DIR`, verifies
the managed PID belongs to this plugin's compiled entrypoint, and sends SIGUSR1.
It never starts the bridge and never signals an unrelated process.

The bridge drains the inbox on SIGUSR1. Multiple events are coalesced before a
reconciliation pass. Valid workspace identifiers narrow the scan; missing,
malformed, or unfamiliar payloads safely request a full scan. The payload is a
hint only. Every state transition is derived from a fresh Herdr snapshot.

## Reconciliation Semantics

The reconciler accumulates requested workspace IDs while a pass is scheduled or
running. Events arriving during a pass cause a follow-up pass, so a change that
occurs after a workspace was scanned is not lost. A full-scan request dominates
targeted requests. The existing explicit startup pass remains full.

Targeted passes list panes only for affected configured workspaces, inspect only
bindings in those workspaces, preserve skip diagnostics for untouched panes, and
schedule workers only for affected bindings. Card projection and terminal output
deduplication remain unchanged.

## Answer History and Active-Card Semantics

An answer may span any number of Lark cards (`card1` through `cardN`); three
cards is only an example, not a limit. Together, part 1 through the current part
represent the complete answer in order. A completed part is immutable. Only the
most recent, active answer card receives streaming content updates.
When that card reaches the 28,000-character stream limit, the bridge finishes
it once, creates exactly one continuation card, persists the continuation's
page offset and identifiers, and makes that new card active.

Terminal capture is a rolling observation window, not an append-only message
feed. Repeated observations of the same active assistant output replace the
current draft even when the visible window boundary moves. They must not be
committed as separate answer segments merely because successive snapshots are
not byte-for-byte prefixes of one another. A segment is committed only when the
observer identifies a real transition to a new assistant message.

The primary task card continues to receive phase, queue, and progress updates.
It does not duplicate the full answer. Answer updates target the active answer
card and never recreate or rewrite already-finished history cards.

The periodic interval remains configurable but its plugin example default is
raised from 30 seconds to five minutes. It catches missed hooks, Herdr restarts,
inbox corruption, and changes made while the bridge was offline.

## Safety and Failure Handling

Inbox records are size-bounded JSON lines. Malformed records are ignored and
logged without stopping the bridge. Draining uses rename-before-read so newly
arriving records remain queued for the next signal. The inbox never contains
terminal output, Lark content, or credentials.

SIGUSR1 is installed only by the bridge runtime and removed during shutdown. The
hook exits successfully when the bridge is stopped so normal Herdr operations are
not disrupted. Plugin command logs remain available for actual relay failures.

## Verification

Tests cover event serialization and bounds, malformed payload fallback, workspace
extraction, unrelated/stale PID handling, coalescing, an event arriving during an
active pass, targeted workspace scans, full-scan dominance, and periodic fallback.
The full existing suite, typecheck, build, shell syntax, and Herdr manifest parse
must pass. No PM2 or plugin lifecycle operation is part of this change's runtime
verification.

Answer-card regression coverage additionally verifies that rolling snapshots do
not increase the number of answer cards, a long answer is represented exactly
once across multiple ordered cards, later output updates only the active answer
card and the primary task card, crossing the active page boundary creates one
continuation card, and replaying an event creates neither duplicate content nor
duplicate cards.
