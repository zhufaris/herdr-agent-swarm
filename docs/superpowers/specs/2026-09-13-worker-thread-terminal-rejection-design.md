# Worker Thread Terminal Rejection Design

## Goal

Stop durable Lark inbound messages from retrying forever when a Worker Session
Thread targets an instance that is permanently unavailable. The sender must get
the existing rejection card, and the inbound record must reach the accepted
terminal state only after that feedback has been durably reserved.

## Current failure

`InboundMessageRoutingWorkflow.handle()` invokes
`workerSessionThreads.handleMessage()` before the `try/catch` that translates
known instance availability errors into `PermanentInboundMessageRejection`. A
Worker Thread whose instance is stopped therefore leaks
`Target instance is not running` to `InboundMessageDispatcher`. The dispatcher
correctly treats an unclassified error as retryable, releases the inbound row,
and retries it indefinitely.

Other instance routes already classify these errors as terminal after reserving
the rejection card. Worker Session Thread routing must use the same protocol.

## Design

Move the Worker Session Thread dispatch inside the routing workflow's existing
error-classification boundary. Keep Worker Thread routing first so it retains
precedence over Primary bindings and commands.

When Worker Thread handling throws one of the existing permanent instance
availability errors, the routing workflow will:

1. reserve the existing request-rejected card through the durable outbox;
2. log the rejection with the message identity and route;
3. throw `PermanentInboundMessageRejection`;
4. allow `InboundMessageDispatcher` to mark the inbound row accepted.

If rejection-card reservation fails, that storage or delivery-intent error must
escape unchanged. The inbound row remains retryable, preserving the invariant
that workflow intent is durable before Lark delivery. Unknown Worker Thread
errors also remain retryable.

No schema, migration, production-data repair, Worker lifecycle, or outbox
quarantine behavior changes are included. Existing retained messages will
converge automatically after deployment because the dispatcher already retries
them.

## Testing

Add focused routing tests using the real Worker Thread entry seam:

- a stopped Worker error reserves a rejection card and becomes
  `PermanentInboundMessageRejection`;
- a rejection-card reservation failure remains the surfaced retryable error;
- an unrelated Worker Thread error remains retryable.

Run the focused routing and dispatcher tests, then typecheck, build, and the full
test suite because the change affects durable inbound workflow behavior. After
installation and a safety-gated restart, verify the three retained inbound rows
leave the retry backlog and the running build identity matches the new commit.
