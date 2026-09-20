# Typed Card Action Payload Design

## Status

Approved for implementation planning.

## Objective

Complete the CardKit routing seam by parsing structural callback fields once.
Instance and Session workflows must receive action-specific typed commands rather
than a discriminated action name wrapped around `Record<string, unknown>`.

This deepens the parser introduced by the typed routing refactor. The parser owns
wire-format validation and normalization; workflows continue to own authorization,
fresh-state lookup, lifecycle policy, and side effects.

## Scope and compatibility

This change does not alter emitted CardKit payloads, action names, persistence,
authorization, or user-visible success and rejection messages. Existing structural
compatibility remains intentional:

- binding generations accept integer numbers and decimal integer strings;
- binding context remains optional on cards that can operate outside a bound thread;
- conversation keys default to the callback chat when omitted;
- form values remain on `IncomingLarkCardAction` because they are supplied separately
  by CardKit and are validated by the business workflow;
- retired action handling remains centralized and side-effect free.

Malformed required identifiers, invalid integer generations, invalid interaction
identifiers, unsupported intent values, and oversized conversation keys parse as
`unknown`. They receive the existing generic stale-action response and never reach a
workflow.

## Command model

Replace the broad Instance and Session variants with action-specific discriminated
unions. Shared normalized structures keep the interface compact:

- `BindingCardContext`: optional `bindingId`, `bindingGeneration`, and normalized
  `conversationKey`; when a binding ID is present its generation is required.
- `SessionBindingContext`: required `bindingId` plus optional generation, preserving
  the existing behavior of old Main Card callbacks that omitted the generation.
- Worker Task ownership fields: `turnId`, `instanceId`, instance generation, Worker
  session generation, and source card message ID.
- Worker Main ownership fields: `instanceId`, both generations, and source card
  message ID.
- Submission-only fields such as `requestedBy`, `interactionId`, `intent`, and
  removal `planId` appear only on the variants that consume them.
- Card target commands contain a typed aggregate kind and its identity fields.

The command discriminator remains `kind`. Each action-specific variant also keeps an
`action` literal where downstream branching benefits from the existing vocabulary.
No workflow receives the original callback value object.

## Ownership and data flow

~~~text
IncomingLarkCardAction
        |
        | value + option
        v
parseCardActionCommand
        |
        +-- typed Instance command -> InstanceInteractionWorkflow
        |                              +-- WorkerCardActions
        |                              '-- WorkerLifecycleActions
        +-- typed Session command  -> CardInteractionWorkflow
        +-- existing typed owners  -> model/delivery/provisioning
        +-- retired                -> compatibility response
        '-- unknown                -> generic stale response
~~~

`InstanceInteractionWorkflow` dispatches on the typed command discriminator rather
than string prefixes. `WorkerCardActions` and `WorkerLifecycleActions` accept only
their respective command subsets. `CardInteractionWorkflow` switches exhaustively
over its Session variants and no longer needs `stringValue`, `numberValue`, or
`sessionOperationKind` to interpret untrusted callback payloads.

The `IncomingLarkCardAction` remains available to workflows for trusted envelope
context: operator, chat, message ID, and form values. It is not used to parse the
callback value again.

## Validation boundary

Parser validation is structural only:

- non-empty bounded strings for opaque IDs and user-provided routing keys;
- finite non-negative integers for generations;
- literal unions for action, aggregate kind, and Worker task intent;
- optional binding context accepted only as a coherent pair.

The parser does not check whether an ID exists, a generation is current, a card is
owned by the current Primary, an operator is authorized, or an operation is valid in
the current lifecycle. Those checks require fresh state and remain in the owning
workflow.

## Error handling

- A malformed known action is classified as `unknown`, not partially dispatched.
- Unknown and malformed callbacks produce one generic stale-action warning.
- Retired callbacks retain their specific compatibility guidance.
- Fresh-state and authorization failures retain their existing workflow-specific
  responses.
- Adding an action requires one parser variant, one workflow case, and parser/router
  inventory tests.

## Testing

Extend the pure parser suite with one valid payload per action-specific variant and
table-driven malformed cases for required fields, generation normalization, binding
context coherence, intent, aggregate kind, and identifier bounds.

Update workflow integration tests to parse callbacks through the public parser seam.
Add an architecture assertion that Instance and Session workflow modules do not cast
callback values to `Record<string, unknown>` or read `action.value`. Keep the existing
authorization, Worker ownership, durable Session operation, project selection, and
retired callback regression tests.

Verification before delivery:

~~~text
npx vitest run tests/card-action-command.test.ts tests/card-action-router.test.ts tests/card-interaction-integration.test.ts tests/instance-routing.integration.test.ts tests/session-operation-workflow.test.ts
npm test
npm run typecheck
npm run build
npm run docs:audit
git diff --check
~~~

## Delivery

Commit this design separately, then commit parser/workflow/test changes as one
thematic implementation commit. Do not install, deploy, restart, publish, tag, or
push as part of this slice.
