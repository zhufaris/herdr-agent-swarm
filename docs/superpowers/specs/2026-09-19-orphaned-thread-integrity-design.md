# Orphaned Thread Integrity Design

## Problem

The SQLite integrity auditor currently reports an active binding thread alias and
an active Worker session thread as corrupt whenever their parent binding is
temporarily orphaned. That conflicts with the recovery model: an orphaned binding
keeps its generation, Pane identity, and published Feishu thread identities so it
can recover when Herdr proves the same native runtime identity again.

This false positive blocks the non-forced service restart safety gate even though
the references and ownership fences are internally consistent.

## Decision

Keep published alias and Worker-thread rows active while their parent binding is
orphaned. Change the two integrity rules to validate structural ownership only:

- the referenced binding and Worker must exist;
- chat, binding generation, parent Pane, Worker role, Worker session generation,
  and Worker parent identity must still match;
- an active thread remains invalid when its parent binding is terminal
  (`archived`, `closed`, or `failed` lifecycle), but temporary attachment states
  (`degraded` or `orphaned`) are valid.

Routing remains fail-closed. Existing alias and Worker-thread lookup paths already
require the parent binding to be active and attached before accepting inbound work.
No state is rewritten and no runtime or delivery effect is replayed.

## Worker Limit Scope

This change does not alter project `maxInstances` or the active Worker count. A
failed provisioning attempt can own a pending Pane and remain retryable, so
excluding it from quota by `observed_state` would leak resources and weaken the
durable session model. Worker-limit remediation remains a separate lifecycle task
requiring a safe cleanup/retry contract.

## Verification

- A focused SQLite test creates valid active aliases and Worker threads, orphans
  the parent, and expects a healthy integrity report.
- The same test mutates generation, Pane, and ownership fences and verifies that
  both rules still report the contradictions.
- Existing routing tests continue to prove that orphaned parents cannot receive
  thread traffic.
- Typecheck, build, the full test suite, and the public audit remain required.
