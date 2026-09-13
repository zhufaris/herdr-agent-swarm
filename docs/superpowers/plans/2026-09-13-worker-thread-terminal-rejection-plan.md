# Worker Thread Terminal Rejection Implementation Plan

**Goal:** Terminally reject retained Worker Session Thread messages when their target instance is permanently unavailable, without weakening durable feedback or retry behavior.

**Architecture:** Keep Worker Thread routing precedence unchanged and move that dispatch into the existing `InboundMessageRoutingWorkflow` error-classification boundary. Reuse the current durable rejection-card path and `PermanentInboundMessageRejection` protocol.

## Task 1: Lock down terminal classification

- Add a routing test where `workerSessionThreads.handleMessage()` throws `Target instance is not running`.
- Assert the workflow reserves the existing rejection card and throws `PermanentInboundMessageRejection`.
- Run the focused test and confirm it fails before implementation.
- Move Worker Thread dispatch inside the existing classification boundary and make the focused test pass.

## Task 2: Preserve retry semantics

- Add a test where durable rejection-card reservation fails and assert that storage error escapes unchanged.
- Add a test where Worker Thread routing throws an unknown error and assert it remains retryable.
- Apply only the minimal implementation adjustments required by those tests.

## Task 3: Verify and release

- Run the focused routing and dispatcher tests.
- Run `npm run typecheck`, `npm run build`, and `npm test`.
- Commit the implementation separately from the design and plan commits.
- Run `./install.sh`, inspect active-work safety state, and restart through the supported lifecycle command.
- Verify the running build identity and confirm the three retained inbound rows leave the retry backlog without direct database edits.
