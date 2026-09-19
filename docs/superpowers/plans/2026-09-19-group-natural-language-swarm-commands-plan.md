# Group Natural-Language Swarm Commands Implementation Plan

## Objective

Add a deterministic natural-language interpretation layer for common Swarm and
instance commands in the configured Feishu group. Queries execute through the
existing gateways; mutations require a durable, fenced confirmation card.

## Work packages

### 1. Domain interpretation contract

- Add a pure `NaturalLanguageCommandInterpreter` contract and discriminated
  command/task/clarification/unsupported results.
- Implement bounded Chinese/English grammar that emits only existing
  `BridgeCommand` and `InstanceCommand` values.
- Add table-driven tests, including task-neighbor and dynamic-project regression
  cases.

### 2. Durable confirmation model

- Add the confirmation domain type, state transitions, and consumer-shaped store
  port.
- Add a forward-only SQLite migration and focused store implementation.
- Atomically reserve a confirmation plus outbox card intent and atomically
  consume/cancel it with actor, expiry, schema, and generation checks.
- Cover idempotency and restart states in SQLite tests.

### 3. Confirmation workflow and cards

- Add a workflow that stages typed mutations and handles confirm/cancel actions.
- Add strict CardKit action parsing and rendering for confirmation and
  clarification cards.
- Route confirmed Swarm commands through `SwarmCommandGateway`; route instance
  commands through the existing instance workflow with frozen target evidence.
- Verify repeated callbacks and stale cards do not execute effects.

### 4. Ingress integration

- Interpret only explicit bot mentions after slash parsing and before ordinary
  prompt fallback.
- Preserve Worker-thread routing and alias restrictions.
- Direct queries through existing handlers, stage mutations, and render
  clarification/unsupported outcomes.
- Add routing integration tests proving command-shaped failures never become
  prompts.

### 5. Documentation and verification

- Update help cards and `docs/feishu-group-usage.md` terminology and examples.
- Run focused parser, store, card-action, command-gateway, and ingress tests.
- Run `npm run typecheck`, `npm run build`, architecture/docs checks,
  `npm run public:audit`, and the full test suite.
- Inspect the final diff and commit in independently verifiable slices. Do not
  install or restart the service without fresh operational authorization.
