# Typed Card Action Routing Design

## Status

Approved for implementation planning.

## Objective

Make CardKit callback ownership explicit and exhaustive. A normalized Lark card
action must be parsed once, routed to exactly one owning workflow, and rejected
consistently when it is unknown or belongs to a retired interaction.

This change addresses a concrete routing failure: `CardInteractionWorkflow`
previously treated every unrecognized string action as stale, preventing later
handlers from receiving dead-letter and project-selection actions.

## Scope and invariants

The refactor changes only callback parsing and dispatch. It does not change:

- persisted card payload shapes or action names;
- authorization policy owned by each workflow;
- prompt FIFO, exact-turn control, no-replay, or outbox ordering;
- asynchronous project-selection acknowledgement semantics;
- compatibility behavior for callbacks emitted by retired cards.

Every known action has one owner. Unknown actions and explicitly retired actions
are distinct: unknown actions receive the generic stale-action response, while
retired actions retain their current compatibility guidance.

## Chosen module shape

Introduce a pure parser module at the normalized Lark seam:

~~~text
IncomingLarkCardAction
        |
        v
parseCardActionCommand(value, option)
        |
        +-- instance interaction command -> InstanceInteractionWorkflow
        +-- session/card command -------> CardInteractionWorkflow
        +-- model command --------------> ModelSelectionWorkflow
        +-- delivery command -----------> DeliveryRecoveryWorkflow
        +-- project command ------------> BindingProvisioningWorkflow
        +-- pane-claim command ---------> BindingProvisioningWorkflow
        +-- retired command ------------> compatibility rejection
        '-- unknown --------------------> generic stale-action rejection
~~~

`CardActionCommand` is a discriminated union. Each variant contains only the
validated fields its owner needs. The parser performs structural checks and
normalization; it performs no database access and no authorization decisions.

`CardActionRouter` owns the exhaustive switch and shared chat/user allowlist.
Business authorization stays in the owning workflow because it depends on fresh
binding, creator, generation, or administrator state.

`CardInteractionWorkflow` no longer probes arbitrary raw action objects. Its
interface accepts only its typed command variants. The same narrowing is applied
to other handlers where it does not force unrelated restructuring. Instance card
actions may keep their existing internal parser initially, but the top-level
parser must identify their namespace before another owner can consume them.

## Ownership table

| Action family | Owner | Routing behavior |
| --- | --- | --- |
| Worker/instance actions | `InstanceInteractionWorkflow` | Routed first by explicit recognized action names or namespace |
| Main/Answer/session actions | `CardInteractionWorkflow` | Receives a typed session/card command only |
| Model and model-mode selection | `ModelSelectionWorkflow` | Receives validated binding, model, and operation identifiers |
| Open-thread and dead-letter actions | `DeliveryRecoveryWorkflow` | Receives validated binding or reply identity |
| Project selection and pane claim | `BindingProvisioningWorkflow` through the router | Preserves admin checks and background task tracking |
| Historical supplement and prompt-steering actions | Router compatibility branch | Returns the existing retired-action guidance without terminal input or queue mutation |
| Unknown or malformed action | Router fallback | Returns one generic stale-action response |

No workflow may claim an action merely because its `action` field is a string.
Adding a new callback requires adding a parser variant, one owner mapping, and a
table-driven ownership test.

## Error and compatibility behavior

- Wrong chat or disallowed operator keeps the existing early rejection behavior.
- Malformed known actions are treated as stale rather than partially dispatched.
- Retired `open_supplement`, `submit_supplement`, `convert_queued_prompt`, and
  `enqueue_failed_steering` callbacks remain side-effect free.
- Unknown callbacks return a warning toast instead of silently disappearing.
- A handler returning no response cannot cause the router to try another owner,
  because ownership was resolved before dispatch.
- Background project selection remains tracked so shutdown waits for accepted work.

## Testing

Add pure parser tests covering every known action, malformed payloads, retired
actions, and unknown actions. Add a table-driven router test proving each action
invokes exactly one owner. Keep focused integration tests for authorization,
dead-letter retry, project selection, and side-effect-free retired callbacks.

Verification before implementation delivery:

~~~text
npx vitest run tests/card-action-command.test.ts tests/card-interaction-integration.test.ts tests/operations-integration.test.ts tests/project-selection-integration.test.ts
npm test
npm run typecheck
npm run build
git diff --check
~~~

## Delivery

Commit the parser/router refactor as one thematic commit after the design commit.
Do not install, deploy, restart the service, publish a package, or create a release
as part of this slice.
