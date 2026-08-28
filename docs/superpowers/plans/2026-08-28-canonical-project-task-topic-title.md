# Canonical Project and Task Topic Title Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan inline with test-driven development. This repository session explicitly forbids sub-agent delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new and existing managed Lark topics use the canonical `<project-space-name> / <Herdr pane name>` title, including `herdr-agent-swarm / task-esk0`.

**Architecture:** Generate one `task-xxxx` name per automatic provisioning attempt and use it for both the Herdr pane and durable binding title. During normal Herdr reconciliation, atomically fence and persist any title correction derived from the matching live pane, update `TopicViewState`, and reserve the Main Card update through the existing durable outbox.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, SQLite, Lark CardKit, Herdr adapter ports

**Spec:** `docs/superpowers/specs/2026-08-28-canonical-project-task-topic-title-design.md`

## Global Constraints

- Preserve all existing uncommitted Lark `post` normalization and tool-activity rendering changes.
- Do not call a separate Lark topic rename API or recreate a topic.
- Do not change `topicId`, `rootMessageId`, prompt history, or prompt dispatch state.
- A title repair must verify the expected pane ID and binding generation.
- A missing or blank pane label and an unresolved project must not change the title.
- Explicit `/swarm rename <name>` remains authoritative and continues to rename Herdr before projecting the title.
- Do not combine this change with the npm `solo:*` to `swarm:*` command migration.

---

### Task 1: Use the generated pane name as the automatic binding title

**Files:**
- Modify: `tests/project-selection-integration.test.ts`
- Modify: `tests/herdr-discovery-integration.test.ts`
- Modify: `tests/pane-thread-lifecycle-integration.test.ts`
- Modify: `src/coordinator/binding-provisioning-workflow.ts`

**Interfaces:**
- Consumes: `randomPaneName(): string`, `formatProjectPaneTitle(spaceName, cwd, paneName, paneId): string`
- Produces: all automatic provisioning and reset paths persist the exact generated pane name inside the canonical binding title

- [ ] **Step 1: Write failing creation and reset tests**

Update the natural-language and titled `/swarm new` assertions so the captured
Herdr creation title and the binding title share the same random suffix:

```ts
expect(created[0]).toMatch(/^task-[a-z0-9]{4}$/);
expect(store.findBindingByPane("w1:p1")).toMatchObject({
  title: `alpha / ${created[0]}`
});
```

For reset, capture `HerdrPaneCreationOptions.title` and assert the replacement
binding title is `repo / ${createdTitle}` even when `/swarm reset custom text`
supplies optional text. Preserve the test that the original natural-language
message is dispatched unchanged as `initialPromptText`.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
npx vitest run tests/project-selection-integration.test.ts tests/herdr-discovery-integration.test.ts tests/pane-thread-lifecycle-integration.test.ts
```

Expected: assertions expecting `<project> / task-xxxx` fail because the binding
currently uses `requestedTitle`.

- [ ] **Step 3: Implement one-name automatic provisioning**

In `BindingProvisioningWorkflow.createRoot`, `reset`, and
`createSelectedProject`, derive the canonical title from `paneTitle`:

```ts
const paneTitle = randomPaneName();
const title = formatProjectPaneTitle(projectSpaceName(project), project.cwd, paneTitle, "TraeX pane");
```

Continue storing `requestedTitle` and `initialPromptText` in project selection so
prompt behavior and recovery idempotency are unchanged. Discovery continues to
use the observed `pane.label`.

- [ ] **Step 4: Run focused tests and verify pass**

Run the Task 1 Vitest command again. Expected: PASS.

---

### Task 2: Add a fenced durable title-projection transition

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Produces:

```ts
type BindingTitleProjectionResult = {
  outcome: "projected" | "unchanged" | "stale_binding";
  binding: Binding | null;
  outboxReserved: boolean;
};

reconcileBindingTitleWithProjection(input: {
  bindingId: string;
  expectedPaneId: string;
  expectedGeneration: number;
  title: string;
  event: BridgeEvent;
  view: TopicViewState;
  rootMessageId: string | null;
  card: object;
}): BindingTitleProjectionResult;
```

- [ ] **Step 1: Write failing SQLite tests**

Cover these cases in `tests/sqlite-store.test.ts`:

```ts
const result = store.reconcileBindingTitleWithProjection({
  bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1,
  title: "repo / task-ab12", event, view, rootMessageId: "root-1", card
});
expect(result).toMatchObject({ outcome: "projected", outboxReserved: true });
expect(store.getBinding("b1")?.title).toBe("repo / task-ab12");
expect(store.loadTopicView("b1")?.title).toBe("repo / task-ab12");
expect(store.listPendingOutboundReplies()).toHaveLength(1);
```

Also assert the same title returns `unchanged` without a second outbox row, and
a mismatched pane ID or generation returns `stale_binding` without changing the
binding, view, or outbox.

- [ ] **Step 2: Run the focused store tests and verify failure**

Run:

```bash
npx vitest run tests/sqlite-store.test.ts
```

Expected: TypeScript/test failure because the new store method is absent.

- [ ] **Step 3: Implement the atomic store operation**

Add the input/result types and method to the runtime reconciliation port. In
`SqliteBindingStore`, execute one immediate transaction that:

1. loads the binding;
2. returns `stale_binding` unless pane ID and generation match;
3. returns `unchanged` when the binding title already matches;
4. updates `bindings.title`;
5. persists the supplied `TopicViewState`; and
6. reserves one `session_status` Main Card `card_update` when a root/status
   message is available.

Reuse the existing outbox idempotency/version conventions used by
`checkpointRuntimeOutputWithProjection`; do not send Lark work directly.

- [ ] **Step 4: Run the focused store tests and verify pass**

Run `npx vitest run tests/sqlite-store.test.ts`. Expected: PASS.

---

### Task 3: Converge existing bindings from the matching Herdr pane label

**Files:**
- Modify: `src/coordinator/herdr-runtime-reconciler.ts`
- Modify: `tests/herdr-runtime-reconciler.test.ts`

**Interfaces:**
- Consumes: `projectSpaceName`, `formatProjectPaneTitle`, and `reconcileBindingTitleWithProjection(...)` from Task 2
- Produces: idempotent runtime/startup title convergence for existing attached bindings

- [ ] **Step 1: Write failing reconciliation tests**

Add tests proving that one reconciliation pass with a matching pane labeled
`task-esk0` changes a legacy binding title to `herdr-agent-swarm / task-esk0`,
updates its TopicView, and reserves exactly one Main Card update. Run a second
pass and assert no additional outbox work. Add negative cases for blank labels,
unresolved projects, and a stale generation/pane fence.

- [ ] **Step 2: Run the reconciler test and verify failure**

Run:

```bash
npx vitest run tests/herdr-runtime-reconciler.test.ts
```

Expected: the legacy title remains unchanged.

- [ ] **Step 3: Implement title convergence**

After `applyRuntimeObservation` accepts the pane identity and before ordinary
runtime/card projection, resolve the binding project. If `pane.label.trim()` is
non-empty, compute:

```ts
const title = formatProjectPaneTitle(
  projectSpaceName(project),
  pane.cwd,
  pane.label,
  pane.paneId
);
```

When it differs, reduce a `BindingRenamed` event into the current TopicView and
call the fenced store operation with `renderProjectEntryCard(view)`. On
`projected`, replace the local binding with the returned binding, wake outbound
delivery if reserved, and publish the event. Do nothing for unresolved projects,
blank labels, unchanged titles, or stale bindings.

- [ ] **Step 4: Run focused title tests and verify pass**

Run:

```bash
npx vitest run tests/thread-title.test.ts tests/sqlite-store.test.ts tests/herdr-runtime-reconciler.test.ts tests/project-selection-integration.test.ts tests/herdr-discovery-integration.test.ts tests/pane-thread-lifecycle-integration.test.ts
```

Expected: PASS.

---

### Task 4: Validate, document, deploy, and verify

**Files:**
- Modify: `docs/feishu-group-usage.md`

**Interfaces:**
- Consumes: canonical title behavior from Tasks 1-3
- Produces: user-facing naming documentation and a verified production build

- [ ] **Step 1: Update the usage guide**

Document that new/reset topics use `<project> / task-xxxx`, natural-language
prompts are not used as topic names, existing managed topics converge after
restart/reconciliation, and `/swarm rename <name>` produces
`<project> / <name>`.

- [ ] **Step 2: Run repository verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all tests pass, TypeScript emits no errors, build identity is
generated successfully, and no whitespace errors are reported.

- [ ] **Step 3: Review the scoped diff**

Confirm the title changes do not overwrite the pre-existing `post` parsing and
tool rendering edits, and confirm no credentials, runtime databases, logs, or
generated `dist/` files are staged.

- [ ] **Step 4: Restart through the supported lifecycle command**

Run:

```bash
herdr plugin action invoke restart --plugin herdr-lark-bridge
herdr plugin action invoke status --plugin herdr-lark-bridge
```

Expected: the managed service reports the newly generated build identity and
`readiness=ready`; existing connected topics receive at most one canonical
Main Card title update.
