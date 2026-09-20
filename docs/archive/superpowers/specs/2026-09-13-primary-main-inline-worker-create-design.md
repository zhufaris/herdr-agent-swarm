# Primary Main Card inline Worker creation

## Goal

Let an operator enter a Worker name directly on a Primary Main Card and create
the formal Swarm Worker with one submit action. Keep the existing `/instances`
form as the advanced path for selecting runtime options.

## Card interaction

The Primary Main Card replaces its standalone `＋ 创建 Worker` callback with a
compact inline form containing:

- one required Worker-name input;
- one `创建并启动 Worker` submit button.

The form is rendered only when the card has the current Primary binding context.
Submitting an empty name remains a validation error. The card does not expose
agent kind, model, or start-state controls; operators use `/instances` when they
need those advanced choices.

## Command and trust boundary

The inline form submits a dedicated `primary_worker_create_submit` action with
only the fenced Primary context embedded in the card: `bindingId`,
`bindingGeneration`, and `conversationKey`. It does not embed or trust a
`projectId` or requester identity.

The action handler:

1. validates the callback against the current binding and generation;
2. requires that binding to identify a Primary instance;
3. derives the project from the verified binding;
4. uses the callback's authenticated `operatorOpenId` as the actor;
5. normalizes and validates the submitted Worker name;
6. invokes the existing formal Worker creation workflow with
   `agentKind: "traex"`, `model: null`, and `start: true`.

This preserves the durable SQLite, lifecycle, Herdr, event, and outbox path. The
card renderer never creates a pane, and the handler never accepts client-supplied
project or requester authority. Existing Worker pane naming remains
`<primary pane name>-<worker name>`.

## Results and errors

Success and failure use the same operator-facing response behavior as the
existing Worker creation submit flow. Duplicate names, stale cards, invalid
names, missing bindings, and lifecycle failures are reported without bypassing
the current idempotency and authorization checks. A stale callback must not
create or start a Worker.

## Code boundaries

- `src/cards/run-card.ts` owns the compact CardKit form presentation.
- `src/coordinator/card-action-command.ts` parses the dedicated action without
  inventing identity or project fields.
- `src/coordinator/instance-interactions/worker-lifecycle-actions.ts` resolves
  the trusted Primary context and delegates to the existing creation workflow.
- The current `instance_create_submit` action and full `/instances` form remain
  unchanged for advanced creation.

## Validation

Focused tests cover inline form rendering, name submission, fixed defaults,
authenticated actor derivation, project derivation, Primary-only enforcement,
stale generation rejection, and empty or invalid names. Before handoff, run the
affected Vitest files, `npm run typecheck`, `npm run build`, and
`git diff --check`.
