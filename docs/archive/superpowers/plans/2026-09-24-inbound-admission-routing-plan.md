# Inbound Admission and Routing Implementation Plan

## Objective

Implement the approved inbound deep-module design without changing routing
precedence, authorization, user-visible feedback, SQLite schema, or recovery
semantics. Complete the pass only after interface-level focused tests and the
full repository verification suite pass.

## Step 1: Make inbound runtime events content-free

Files:

- `src/domain/events.ts`
- `src/events/runtime-event-bus.ts`
- `src/composition/runtime-event-integration.ts`
- `src/events/inbound-work-notifier.ts` or its replacement
- `tests/runtime-event-bus.test.ts`
- `tests/runtime-event-integration.test.ts`

Actions:

1. Replace the inbound event payload with an `InboundWorkHint` containing only
   `eventId`.
2. Preserve awaited publication and subscriber failure propagation.
3. Add a structural test proving the event shape cannot contain message text.
4. Keep the full message exclusively in the durable inbox.

Verification:

```bash
npx vitest run tests/runtime-event-bus.test.ts tests/runtime-event-integration.test.ts
```

## Step 2: Introduce `PromptAdmissionWorkflow`

Files:

- create `src/coordinator/prompt-admission-workflow.ts`
- update `src/domain/ports/prompt-acceptance.ts` only if a consumer-shaped type
  belongs there
- update `src/coordinator/inbound-message-routing-workflow.ts`
- update `src/coordinator/startup-recovery-workflow.ts`
- update `src/coordinator/card-action-router.ts` construction callbacks
- create `tests/prompt-admission-workflow.test.ts`

Actions:

1. Move Answer-root selection, parent Prompt capture, queue position, queued Run
   Card creation, atomic acceptance, post-commit effects, audit, and initial
   project Prompt handling into the new module.
2. Keep existing message-ID idempotency and max-queue behavior.
3. Route ordinary and project-selection Prompts through the same interface.
4. Remove `enqueueInitialProjectPrompt` from the routing interface.

Verification:

```bash
npx vitest run tests/prompt-admission-workflow.test.ts tests/inbound-message-routing-workflow.test.ts tests/startup-recovery.test.ts
```

## Step 3: Return structured routing results

Files:

- update `src/coordinator/inbound-message-routing-workflow.ts`
- update or create a domain routing-result type beside the workflow interface
- update `tests/inbound-message-routing-workflow.test.ts`

Actions:

1. Rename the public operation from `handle` to `route`.
2. Return `InboundRoutingResult` for every successful or durably rejected path.
3. Centralize the single content-safe completion log from that result.
4. Preserve Worker Thread first, command precedence, alias restrictions,
   mentioned natural-language behavior, Prompt routing, auto-provisioning, and
   disconnected feedback.
5. Keep infrastructure and durable-reservation failures retryable.

Verification:

```bash
npx vitest run tests/inbound-message-routing-workflow.test.ts tests/steering-integration.test.ts tests/instance-routing.integration.test.ts
```

## Step 4: Deepen the durable pipeline

Files:

- rename or replace `src/coordinator/inbound-message-dispatcher.ts` with
  `src/coordinator/durable-inbound-pipeline.ts`
- update `src/domain/ports/workflow.ts` only for the smallest inbox store port
- update `src/coordinator/inbound-router.ts`
- update `src/coordinator/startup-recovery-workflow.ts`
- update `tests/inbound-message-dispatcher.test.ts` into pipeline interface tests

Actions:

1. Expose only `start`, `receive`, `recover`, `stop`, and `snapshot`.
2. Keep synchronous test draining behind a private implementation seam or test
   through observable completion, not through a production `drain` interface.
3. On admission, persist first and publish a content-free wake-up.
4. Drain by claiming the complete message from SQLite and calling `route`.
5. Preserve scope-local retry isolation and bounded backoff.
6. Await an executing route during shutdown and leave interrupted claims
   recoverable.

Verification:

```bash
npx vitest run tests/inbound-message-dispatcher.test.ts tests/concurrency-controls.integration.test.ts tests/health-server.test.ts
```

## Step 5: Recompose startup and Gateway ingress

Files:

- `src/composition/create-ingress-recovery-runtime.ts`
- `src/composition/create-application-runtime.ts`
- `src/composition/create-bridge-runtime.ts`
- `src/coordinator/startup-recovery-workflow.ts`
- `src/gateways/compatibility-ingress.ts`
- `tests/helpers/create-test-router.ts`
- affected startup, managed-runtime, and integration tests

Actions:

1. Construct Prompt admission, router, and pipeline only in composition.
2. Give Gateway ingress only `receive`; give startup only lifecycle and Prompt
   admission capabilities.
3. Subscribe inbound-ready hints to pipeline wake-up rather than routing message
   payloads.
4. Preserve startup ordering: recover durable claims, connect consumers, start
   Gateway, finish prerequisite recovery, then drain inbox work.

Verification:

```bash
npx vitest run tests/inbound-router.test.ts tests/startup-recovery.test.ts tests/managed-bridge-runtime.test.ts tests/concurrency-controls.integration.test.ts
```

## Step 6: Enforce architecture and update documentation

Files:

- `tests/architecture-boundaries.test.ts`
- `docs/architecture.md`
- `docs/architecture-boundary-inventory.md`
- `docs/superpowers/README.md`

Actions:

1. Assert that Gateway, composition, top-level router, and message router do not
   claim, release, or recover inbox rows.
2. Assert that runtime inbound hints do not import or carry
   `IncomingLarkMessage`.
3. Document the final module interfaces and recovery path.
4. Mark the inbound seam complete only when all design acceptance criteria have
   direct evidence.

## Step 7: Final verification and audit

Run:

```bash
npx vitest run tests/runtime-event-bus.test.ts tests/runtime-event-integration.test.ts tests/prompt-admission-workflow.test.ts tests/inbound-message-routing-workflow.test.ts tests/inbound-message-dispatcher.test.ts tests/concurrency-controls.integration.test.ts tests/architecture-boundaries.test.ts
npm run typecheck
npm run build
npm run architecture:check
npm run docs:audit
npm test
git diff --check
```

Audit each design requirement against source and test evidence. Do not mark the
seam complete solely because the aggregate suite is green. Preserve all
pre-existing uncommitted EventBus, Card, and steer changes in the worktree.
