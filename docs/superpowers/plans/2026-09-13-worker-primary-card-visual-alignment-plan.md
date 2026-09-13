# Worker and Primary Card Visual Alignment Implementation Plan

**Goal:** Align the canonical Worker Main Card with the Primary Main and Answer Card visual language while retaining one continuously updated Worker card and adding explicit owning-Primary context.

**Architecture:** Keep the Worker renderer and domain view independent from Primary renderers. Reuse existing pure card-style primitives, preserve every workflow and callback identity, and limit the change to deterministic presentation plus focused test expectations.

## Task 1: Specify the rendering contract in tests

- Assert the canonical title is `🧭 <Worker name>`.
- Assert the subtitle includes `HERDR WORKER`, the Primary pane display name or durable pane-ID fallback, and the localized runtime state.
- Assert the compact state row includes Worker pane, queue count, and model.
- Assert runtime evidence includes project display name or persisted ID, Primary label and pane ID, Worker pane ID, generations, workspace, and branch.
- Assert stopped and terminated states use the grey lifecycle template.
- Preserve specialized read-only snapshot and legacy-entry headers and the existing action payloads.

## Task 2: Align the canonical Worker renderer

- Add small local presentation helpers for the Primary label, project label, Worker pane fallback, subtitle, and lifecycle template.
- Apply the Primary-style identity header and compact metadata hierarchy to `renderWorkerMainCard`.
- Keep current task, bounded progress/output, legal actions, queue, recent tasks, and runtime evidence in their existing semantic order.
- Keep rendering pure, bounded, and redacted; do not add persistence, delivery, or domain behavior.

## Task 3: Update integration expectations

- Update instance-card and card-target routing assertions for the concise canonical Worker title.
- Verify display-name enrichment and durable legacy fallbacks without showing `Unknown project`.
- Confirm snapshots remain passive and Worker Task or Answer cards are not introduced.

## Task 4: Verify and release

- Run focused Worker card, instance-card, and routing tests.
- Run `npm run typecheck`, `npm run build`, and the full `npm test` suite.
- Commit the implementation without staging the unrelated SQLite migration test change.
- Run the supported install flow, inspect active-work safety state, restart through the normal lifecycle command, and verify service readiness and build identity.
