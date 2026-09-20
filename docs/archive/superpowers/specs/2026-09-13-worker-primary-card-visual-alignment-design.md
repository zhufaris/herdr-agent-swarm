# Worker and Primary Card Visual Alignment Design

## Goal

Make the canonical Worker Main Card use the same visual hierarchy and identity
language as the Primary Main Card and Primary Answer Card. The Worker card adds
its owning Primary pane identity, while retaining Worker-specific task, queue,
output, and controls.

## Decision

Use shared presentation primitives and conventions, not a shared aggregate
renderer. Primary and Worker views have different lifecycle and action models,
so each renderer remains responsible for its own content. The shared visual
language covers header shape, lifecycle marker and color, compact metadata,
section ordering, and runtime placement.

The Worker Main Card remains the only continuously updated card for a Worker
Session. This change does not create Worker Answer Cards or revive per-turn
Worker Task Card delivery.

## Worker Main Card

The canonical Worker card uses this hierarchy:

1. Header title: `🧭 <Worker name>`.
2. Header subtitle: `HERDR WORKER · PRIMARY <Primary pane name> · <state>`.
3. Compact state row: runtime state, Worker pane, queue count, and model when
   present.
4. Current task, bounded progress, and bounded current output.
5. Legal Worker actions using the existing callback payloads and fences.
6. Queue and recent tasks.
7. Runtime footer containing project, Primary pane, Worker pane, session and
   runtime generations, workspace, and branch.

The Primary pane display name is preferred. The durable Primary pane ID remains
visible in runtime details so the card is still operationally useful when the
display label is ambiguous. Project display name is presentation configuration;
the persisted project ID remains the fallback. Missing legacy data uses existing
durable identifiers rather than `Unknown project` in the main identity header.

The header template follows the same lifecycle color vocabulary as Primary
cards: blue for usable/active work, orange for blocked or uncertain work, red
for failure, grey for stopped or terminated state, and green only for a clearly
completed or ready terminal presentation. State remains visible as text; color
is never the only signal.

## Primary Main and Answer Cards

Primary Main and Answer Card behavior does not change. They are the visual
reference for:

- the `🧭` identity title;
- compact identity and lifecycle metadata;
- semantic section markers;
- state-aligned template colors; and
- runtime evidence placed after primary content.

No Answer Card title, pagination, streaming element, source offset, frozen-page
rule, or continuation action changes in this slice.

## Presentation boundary

Small pure helpers in `src/cards/card-style.ts` may be extended for shared header
or metadata formatting. `renderProjectEntryCard`, `renderRequestAnswerCard`, and
`renderWorkerMainCard` remain distinct renderers. They consume their existing
domain views and do not translate Worker state into `TopicViewState` or
`RunCardView`.

Project display-name lookup remains in application presentation composition.
The Worker projection continues to carry durable `projectId`, Primary pane
label, Primary pane ID, and Worker pane ID. Rendering must not query SQLite or
Lark.

One-time Worker snapshots and legacy entry cards may reuse the canonical body,
but retain their explicit read-only titles and banners. They expose no mutation
controls.

## Safety and durability

- Do not change Worker session identity, binding generation, callback payloads,
  outbox lanes, CardKit sequence, or delivery checkpoints.
- Do not add a Worker Answer Card, Worker Task Card stream, or second canonical
  Worker Main Card.
- Preserve display redaction and existing content bounds.
- Keep CardKit rendering deterministic for the same view and project registry.
- Persist workflow state before delivery exactly as today.

## Verification

Focused renderer tests will assert:

- the aligned Worker title and subtitle with a Primary pane display name;
- fallback behavior for legacy views without a pane label or project display
  name;
- Primary pane ID and Worker pane ID in runtime details;
- consistent lifecycle text, marker, and header color;
- unchanged Worker actions and canonical message identity;
- read-only snapshot and legacy-entry behavior; and
- no Worker Task or Answer Card delivery intent.

Run the affected Worker Main, instance-card, routing, card-context, and Primary
card tests, followed by `npm run typecheck`, `npm run build`, and `npm test`.

## Non-goals

- Merging Primary and Worker domain views.
- Changing Primary Main or Answer Card persistence or rendering behavior.
- Introducing new commands, controls, workflow states, or schema migrations.
- Changing Worker task execution, observation, queueing, or result capture.
- Installing, restarting, or pushing a release as part of the implementation
  commit.
