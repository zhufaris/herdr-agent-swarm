# Primary Main Card Pane Name Implementation Plan

**Goal:** Render the stable Primary pane name with its native token or pane ID in
the Primary Main Card identity row.

**Design:** Normalize a presentation-only `paneName` at the Herdr adapter
boundary, carry it through durable Topic View events/state, and render it with a
pure pane-display helper. Raw pane labels and all runtime identity fields retain
their existing semantics.

## Task 1: Normalize stable pane names at the Herdr boundary

**Files:**

- Modify `src/domain/runtime-observation.ts`
- Modify `src/adapters/herdr-adapter.ts`
- Modify `tests/herdr-adapter.test.ts`

1. Extend `HerdrPane` with optional `paneName` presentation metadata.
2. Parse snapshot tab records and index them by `tab_id`.
3. Resolve `paneName` from a trimmed pane label, otherwise from a managed
   `lark_` tab label with that prefix removed.
4. Preserve `label` unchanged and return no name for unmanaged or blank tab
   labels.
5. Add focused adapter tests for label preference, managed-tab fallback, and
   unmanaged-tab rejection.

## Task 2: Carry paneName through the durable Topic View

**Files:**

- Modify `src/domain/events.ts`
- Modify `src/domain/topic-view.ts`
- Modify Primary binding provisioning and recovery call sites under
  `src/coordinator/`
- Modify `tests/topic-view.test.ts`
- Modify the nearest provisioning/reconciliation tests

1. Add optional `paneName` to the relevant binding and pane-observation event
   payloads.
2. Add nullable `paneName` to `TopicViewState`; legacy JSON hydrates to null.
3. Accept non-blank names from creation, activation, and runtime observation.
4. Do not erase an existing name when a later observation omits it.
5. Include `paneName` in presentation equality so an authoritative rename
   increments `viewVersion` and refreshes the Main Card.
6. Pass adapter-resolved names through provisioning, resume, recovery, and
   periodic binding reconciliation paths.

## Task 3: Render the stable name in Primary Main Cards

**Files:**

- Modify `src/domain/pane-display-identity.ts`
- Modify `src/cards/run-card.ts`
- Modify `tests/run-card.test.ts`
- Modify or add `tests/pane-display-identity.test.ts`

1. Add a pure display helper that combines a stable pane name with the existing
   token-or-ID identity.
2. Collapse duplicate values and retain the existing fallback when no name is
   present.
3. Use the helper only in the Primary Main Card `PANE` metric.
4. Assert `nxmz · yx0c`, ID fallback, duplicate collapse, and missing-name
   compatibility.

## Task 4: Verify the cross-boundary change

1. Run focused Vitest files for the adapter, Topic View, reconciler,
   provisioning, pane display, and Main Card.
2. Run `npm run typecheck`.
3. Run `npm run build`.
4. Run `npm test` because the change crosses adapter, projection, and CardKit
   boundaries.
5. Inspect the final diff and confirm that unrelated pre-existing worktree
   changes remain untouched.

Installation and service restart are not part of this implementation plan.
