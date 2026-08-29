# Primary to Worker Product Flow Test Design

## Goal

Prove the supported multi-agent workflow at two levels: a deterministic Vitest
integration test that runs in the normal suite, followed by one bounded real
Herdr and TraeX acceptance run. The covered workflow is user turn to Primary,
Primary discovery and dispatch to an existing Worker, Worker completion,
Primary observation of that completion, and idempotent recovery.

## Scope

The change adds a product-flow integration test. It does not change production
workflow behavior, create a second orchestration API, or modify the existing
Lark, card-rendering, queue-feedback, or title work already present in the
worktree. The existing `scripts/smoke-headless-multi-agent.ts` remains the real
runtime acceptance entry point.

## Deterministic Integration Test

Add `tests/primary-worker-flow.integration.test.ts`. It uses a temporary SQLite
database and the real `SqliteBindingStore`, `InstanceMessagingWorkflow`,
`InstanceWorkScheduler`, `PrimaryToolGateway`, and Primary MCP JSON-RPC
boundary. Agent execution is supplied by deterministic fake drivers so the test
does not require network access, a Herdr workspace, or a model process.

The fixture creates one active Primary and one active Worker in the same
project, including the runtime and workspace records required by the production
authorization checks. It submits one human turn to the Primary and establishes
that turn as the server-owned active Primary context. The test then exercises
the externally visible Primary MCP protocol in this order:

1. `list_instances` returns the existing same-project Worker.
2. `prompt_instance` accepts one durable Worker task with a stable idempotency
   key and derives the actor identity and parent turn on the server.
3. `InstanceWorkScheduler` executes the Worker task exactly once and persists a
   completed turn.
4. `wait_instance` returns the Worker's completion event and an advancing opaque
   cursor.
5. The Primary turn is completed with a summary after the Worker evidence is
   available. Worker completion alone must not enqueue or execute another
   Primary turn.
6. Repeating `prompt_instance` with the same idempotency key returns the existing
   turn and does not execute the Worker again.

The test communicates with the Unix socket gateway using the same framed JSON
request that the MCP child process uses. MCP request-shape tests remain in
`tests/primary-tools-mcp.test.ts`; the new test is responsible for the joined
product path across gateway, authorization, durable store, scheduler, and event
observation.

## Failure and Cleanup Behavior

Every temporary socket and SQLite database is closed in test cleanup. Assertions
must fail with concrete durable evidence: missing Worker turn, incorrect actor or
parent turn, non-completed Worker state, absent completion event, duplicate
execution, or an unexpected second Primary turn. No retry may replay a prompt
whose durable idempotency key already exists.

## Real Runtime Acceptance

After the deterministic test, build the repository and execute:

```bash
npm run smoke:headless-multi-agent -- --execute
```

This acceptance is permitted to create temporary Herdr panes and worktrees and
must clean them in `finally`. It must report `productPath: true` and prove at
least that the Primary called an existing Worker, Worker completion did not
automatically trigger a Primary turn, and restart did not replay Worker work.
If the host lacks the required Herdr pane/workspace context or agent executable,
the deterministic test can still pass, but the real acceptance and deployment
gate remain explicitly incomplete rather than being inferred from unit tests.

## Verification and Deployment

Run the new focused Vitest file, the existing Primary broker/gateway/MCP and
instance messaging tests, `npm test`, `npm run typecheck`, and `npm run build`.
Then run the real smoke command and inspect its JSON assertions. Because this
slice changes tests only, it does not require a service restart by itself; the
overall optimization workflow may deploy after the next production-code slice.
No success claim is made unless both levels have fresh evidence, or the real
acceptance is reported as a concrete environmental blocker.
