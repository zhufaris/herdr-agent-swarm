# Session Policy, Dispatcher, and Documentation Audit Design

## Goal

Finish the repository cleanup by rejecting impossible Session actions before
they enter durable execution, centralizing repeated coalescing drain mechanics,
and making historical plan/spec archival explicit and repeatable.

## Scope and constraints

- Preserve atomic interaction consumption and Session-operation insertion.
- Keep existing SQLite enum values readable for upgrade compatibility.
- Never replay an operation that may have reached Herdr.
- Do not change slash-command behavior or the failed-steering-to-FIFO recovery.
- Documentation auditing is read-only. It reports drift but never moves files.
- Do not add dependencies or expose prompt, terminal, card payload, or secret data.

## Alternatives considered

For Session eligibility, the alternatives were to keep rejecting only inside
each workflow, duplicate workflow predicates in the card handler, or centralize
the stable binding-state policy next to durable acceptance. Centralizing the
policy gives one atomic decision and avoids durable work that is already known
to be invalid. The policy deliberately covers only binding-state predicates;
dynamic facts such as an active supervised turn remain execution-time checks.

For drain reuse, inheritance and a callback-based runtime were considered. A
small callback-based runtime is preferred: it hides requested/running/stopping
coordination and optional periodic wake-ups behind a narrow interface without
making workflow classes inherit lifecycle policy. Retry backoff remains owned
by `InboundRouter`, because Session operations use periodic anti-entropy rather
than delayed retries.

For documentation cleanup, automatic keyword moves and a declarative manifest
were considered. A manifest plus a read-only audit command is preferred. It
makes classifications reviewable in Git and prevents a heuristic from moving
active records.

## Session-operation eligibility

Add a pure domain policy that returns either `null` or a bounded rejection
reason for a `(binding, operation kind)` pair. The durable acceptance
transaction evaluates it after actor, interaction, generation, Pane, and Agent
session identity checks, and before inserting the operation or consuming the
interaction. A rejected policy decision returns `stale`, preserving the current
public acceptance result without widening interfaces.

The stable policy is:

| Operation | Required binding state |
| --- | --- |
| `stop`, `reset`, `rename` | active lifecycle, active state, non-orphaned attachment, and a Pane |
| `pane_close` | active lifecycle, active state, attached state, and a Pane |
| `archive` | active lifecycle |
| `resume` | archived lifecycle and a retained Pane |
| `reattach`, `replace` | orphaned attachment and active lifecycle |
| `model` | always unsupported |

`stop` still verifies an active supervised turn at execution time. `reset`,
`reattach`, and `replace` retain project/runtime checks in their owning
workflows. Existing accepted legacy `model` rows are finalized as `rejected`
inside the Session dispatcher with the standard unsupported-model explanation;
they never create Pane-control work.

## Coalescing drain runtime

Create a runtime module with this interface:

```ts
interface CoalescingDrain {
  start(intervalMs?: number): void;
  request(): Promise<void>;
  wake(): void;
  stop(): Promise<void>;
  snapshot(): { state: "idle" | "running" | "stopping"; requested: boolean };
}
```

The implementation guarantees at most one drain callback at a time, coalesces
wake-ups arriving during a drain into another pass, ignores wake-ups after
stop, optionally schedules an unreferenced periodic wake-up, and waits only for
the active drain during shutdown. Callback failure is reported to the owner and
does not become an unhandled rejection.

`SessionOperationWorkflow` uses the complete lifecycle. `InboundRouter` uses
the same single-flight request/wake mechanism while retaining its existing
retry timer, retry counters, failure details, and diagnostic shape. Business
claim/execute loops remain in their workflows; the runtime knows nothing about
SQLite, Lark, Herdr, or operation kinds.

## Documentation archive manifest and audit

Add a JSON manifest under `docs/superpowers/` listing archived plan/spec paths,
their archive destinations, status, reason, and optional superseding record. A
Node script validates:

- every manifest source is absent from the active tree;
- every destination exists below `docs/archive/superpowers/`;
- entries and paths are unique and stay inside their permitted roots;
- paired plan/spec records are classified consistently when both are listed;
- active docs do not link to an archived source path.

Expose the read-only check as `npm run docs:audit`. The initial manifest covers
only the records already moved in this worktree. Future archival is a reviewed
manifest edit plus a Git move, never an automatic mutation.

## Error handling and observability

Policy rejection consumes neither the interaction nor the operation slot. The
card callback returns the existing stale warning. A persisted legacy model row
is terminally rejected and logged as a normal Session-operation completion.
The shared drain runtime delegates bounded failure recording and logging to its
owner so existing `/status` contracts remain stable. The documentation audit
prints path-specific failures and exits nonzero.

## Verification

- Unit-test the policy matrix and atomic non-consumption on rejection.
- Test legacy persisted model rejection without invoking model selection.
- Unit-test coalescing, periodic wake-up, failure containment, and shutdown.
- Preserve inbound retry and Session dispatcher integration tests after reuse.
- Test the documentation audit against temporary fixtures and run it on the
  repository manifest.
- Run focused Vitest files, strict unused TypeScript checks, normal typecheck,
  the full test suite, production build, and `git diff --check`.
