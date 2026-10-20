import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { createTestStoreBundle, type TestStoreBundle } from "./helpers/create-test-store-bundle.js";
import type { PreparedDelivery, PreparedDeliveryPlan } from "../src/domain/delivery.js";
import type { OutboundReply } from "../src/domain/types.js";
import type { SqlitePrimaryCardRedeliveryStore } from "../src/store/sqlite/primary-card-redelivery-store.js";

let stores: TestStoreBundle | undefined;
let temporaryDirectory: string | undefined;

afterEach(() => {
  stores?.driver.close();
  stores = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("Primary card redelivery store", () => {
  it("prepares its Main and Answer replacements atomically before handing them to the ring", async () => {
    stores = createTestStoreBundle();
    prepareActivePrimary(stores);
    seedCommandIntent(stores, "intent-prepared");
    const handedOff: PreparedDelivery[] = [];
    stores.outbox.setGatewayPlanPreparer(preparedPlan);
    (stores.primaryCardRedelivery as SqlitePrimaryCardRedeliveryStore).setPreparedDeliveryReservation(
      stores.outbox,
      { enqueuePreparedDelivery: (delivery) => handedOff.push(delivery) }
    );

    expect(reserveCards(stores, "intent-prepared", availableSnapshot(stores))).toEqual({
      outcome: "scheduled", mainScheduled: true, answerScheduled: true
    });

    const replies = redeliveryReplies(stores) as Array<{ id: string; gateway_plan_hash: string | null }>;
    expect(replies).toHaveLength(2);
    expect(replies.every(({ gateway_plan_hash }) => gateway_plan_hash !== null)).toBe(true);
    await Promise.resolve();
    expect(handedOff.map(({ replyId }) => replyId).sort()).toEqual(replies.map(({ id }) => id).sort());
    expect(handedOff.every(({ scope, ownerFence }) => scope.kind === "pane" && scope.paneId === "w1:p1"
      && ownerFence?.kind === "primary" && ownerFence.id === "b1" && ownerFence.generation === 1)).toBe(true);
  });

  it("atomically schedules the current Main Card and active Prompt's latest Answer page", () => {
    stores = createTestStoreBundle();
    prepareActivePrimary(stores);
    seedCommandIntent(stores, "intent-1");

    const snapshot = stores.primaryCardRedelivery.loadSnapshot({
      bindingId: "b1",
      expectedBindingGeneration: 1
    });
    expect(snapshot).toMatchObject({
      outcome: "available",
      topic: { bindingId: "b1", bindingGeneration: 1, viewVersion: 4 },
      answer: {
        run: { promptId: "p1", bindingGeneration: 1, viewVersion: 3 },
        page: { pageIndex: 0, messageId: "answer-1", state: "active" }
      }
    });
    if (snapshot.outcome !== "available") throw new Error("expected available snapshot");

    expect(stores.primaryCardRedelivery.reserve({
      commandIntentId: "intent-1",
      snapshot,
      mainCard: { surface: "main", title: snapshot.topic.title },
      answerCard: { surface: "answer", promptId: snapshot.answer?.run.promptId }
    })).toEqual({ outcome: "scheduled", mainScheduled: true, answerScheduled: true });

    const replies = stores.driver.database.prepare(`SELECT idempotency_key, root_message_id, kind, payload,
      projection_key, snapshot_revision, card_sequence, lane_key
      FROM outbound_replies WHERE projection_key LIKE 'primary-redelivery:%'
      ORDER BY projection_key`).all();
    expect(replies).toEqual([
      {
        idempotency_key: "primary-redelivery:answer:p1:0:revision:1",
        root_message_id: "answer-1",
        kind: "card_update",
        payload: JSON.stringify({ surface: "answer", promptId: "p1" }),
        projection_key: "primary-redelivery:answer:p1:0",
        snapshot_revision: 1,
        card_sequence: 1,
        lane_key: "gateway:feishu:primary:answer:p1:0"
      },
      {
        idempotency_key: "primary-redelivery:main:b1:1:revision:1",
        root_message_id: "main-1",
        kind: "card_update",
        payload: JSON.stringify({ surface: "main", title: "Task" }),
        projection_key: "primary-redelivery:main:b1:1",
        snapshot_revision: 1,
        card_sequence: 1,
        lane_key: "gateway:feishu:primary:primary-main:b1:1"
      }
    ]);
    expect(stores.driver.database.prepare("SELECT command_intent_id, binding_id, binding_generation, topic_view_version, prompt_id, run_view_version, answer_page_index, outcome FROM primary_card_redeliveries").get()).toEqual({
      command_intent_id: "intent-1",
      binding_id: "b1",
      binding_generation: 1,
      topic_view_version: 4,
      prompt_id: "p1",
      run_view_version: 3,
      answer_page_index: 0,
      outcome: "main_and_answer"
    });
    expect(stores.driver.database.prepare("SELECT state, observation_state FROM prompt_jobs WHERE id='p1'").get()).toEqual({ state: "running", observation_state: "attached" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE state='queued'").get()).toEqual({ count: 0 });
  });

  it("hydrates current Native Input backlog without changing execution state", () => {
    stores = createTestStoreBundle();
    prepareActivePrimary(stores);
    stores.driver.updateBinding("b1", { lastAgentState: "working" });
    for (let index = 1; index <= 4; index += 1) {
      stores.driver.acceptCollectingNativeInput({
        input: {
          id: `input-${index}`, bindingId: "b1", bindingGeneration: 1,
          ingressSource: "feishu", sourceMessageKey: `message-${index}`,
          larkMessageId: `message-${index}`, actorOpenId: "user-1",
          body: `body-${index}`, rootMessageId: "root-1", parentPromptId: null
        },
        batchId: "batch-1", occurredAt: `2026-10-01T00:01:00.00${index}Z`,
        windowMs: 2_000, maxQueueDepth: 20
      });
    }
    stores.driver.formDueNativeInputBatch({
      bindingId: "b1", occurredAt: "2026-10-01T00:01:02.001Z",
      nextBatchId: "batch-2", windowMs: 2_000,
      createProjection: ({ batchId, binding, combinedBody, titleSource, rootMessageId, queuePosition }) => ({
        view: createQueuedRunCard({
          promptId: batchId, bindingId: binding.id, bindingGeneration: binding.generation,
          title: titleSource, workspaceId: binding.workspaceId, paneId: binding.paneId,
          requestText: combinedBody, queuePosition, occurredAt: "2026-10-01T00:01:02.001Z"
        }),
        rootMessageId,
        answerCard: { batchId }
      })
    });
    seedCommandIntent(stores, "intent-backlog");

    const executionBefore = nativeInputExecutionRows(stores);
    expect(stores.driver.loadTopicView("b1")?.nativeInputBacklog).toEqual({ unbatchedInputCount: 0, pendingBatchCount: 0 });

    const snapshot = availableSnapshot(stores);
    expect(snapshot.topic).toMatchObject({
      viewVersion: 5,
      nativeInputBacklog: { unbatchedInputCount: 1, pendingBatchCount: 1 }
    });
    expect(reserveCards(stores, "intent-backlog", snapshot)).toEqual({
      outcome: "scheduled", mainScheduled: true, answerScheduled: true
    });

    expect(nativeInputExecutionRows(stores)).toEqual(executionBefore);
    expect(stores.driver.loadTopicView("b1")?.nativeInputBacklog).toEqual({ unbatchedInputCount: 0, pendingBatchCount: 0 });
    expect(redeliveryReplies(stores)).toHaveLength(2);
  });

  it("prefers the active Prompt over newer history and otherwise selects the newest visible historical Answer", () => {
    stores = createTestStoreBundle();
    prepareActivePrimary(stores);
    prepareHistoricalPrompt(stores, "p2", "answer-2");

    const withActive = stores.primaryCardRedelivery.loadSnapshot({ bindingId: "b1", expectedBindingGeneration: 1 });
    expect(withActive).toMatchObject({ outcome: "available", answer: { run: { promptId: "p1" }, page: { messageId: "answer-1" } } });

    stores.driver.database.prepare("UPDATE prompt_jobs SET state='delivered', observation_state='completed' WHERE id='p1'").run();
    const historical = stores.primaryCardRedelivery.loadSnapshot({ bindingId: "b1", expectedBindingGeneration: 1 });
    expect(historical).toMatchObject({ outcome: "available", answer: { run: { promptId: "p2" }, page: { messageId: "answer-2", state: "finished" } } });
  });

  it.each(["fixed", "dynamic"] as const)("loads still-valid %s completion actions into the canonical redelivery snapshot", (kind) => {
    stores = createTestStoreBundle();
    prepareActivePrimary(stores);
    stores.driver.database.exec("UPDATE prompt_jobs SET state='delivered', observation_state='completed' WHERE id='p1'; UPDATE run_cards SET phase='completed' WHERE prompt_id='p1'; UPDATE answer_pages SET state='finished' WHERE prompt_id='p1'");
    if (kind === "dynamic") {
      stores.driver.database.prepare(`INSERT INTO completion_choice_specifications(id, owner_kind, owner_id, owner_generation, version, default_option_id, created_at)
        VALUES ('choice-spec', 'primary-prompt', 'p1', 1, 1, 'one', '2026-10-01T00:00:01.000Z')`).run();
      stores.driver.database.prepare(`INSERT INTO completion_choice_options(specification_id, ordinal, option_id, label, message) VALUES
        ('choice-spec', 0, 'one', '方案一', 'default'), ('choice-spec', 1, 'two', '方案二', '2')`).run();
    }
    stores.driver.database.prepare(`INSERT INTO completion_action_sets(
      id, owner_kind, owner_id, owner_generation, binding_id, binding_generation, page_index, card_id, card_message_id,
      mention_open_id, state, selected_action, result_source_key, reason, created_at, updated_at, decided_at, choice_specification_id, selected_choice_option_id
    ) VALUES (?, 'primary-prompt', 'p1', 1, 'b1', 1, 0, 'answer-card-1', 'answer-1', 'user-1', 'available', NULL, NULL, NULL,
      '2026-10-01T00:00:01.000Z', '2026-10-01T00:00:01.000Z', NULL, ?, NULL)`).run(`actions-${kind}`, kind === "dynamic" ? "choice-spec" : null);

    expect(stores.primaryCardRedelivery.loadSnapshot({ bindingId: "b1", expectedBindingGeneration: 1 })).toMatchObject({
      outcome: "available",
      answer: { completionActions: {
        id: `actions-${kind}`, state: "available", mentionOpenId: "user-1", cardMessageId: "answer-1",
        ...(kind === "dynamic" ? { choiceSpecification: { defaultOption: { id: "one" }, alternatives: [{ id: "two" }] } } : {})
      } }
    });
  });

  it("schedules Main only when the active Prompt has only frozen and creating pages", () => {
    stores = createTestStoreBundle();
    prepareActivePrimary(stores);
    stores.driver.database.exec(`
      UPDATE answer_pages SET state='frozen' WHERE prompt_id='p1' AND page_index=0;
      INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at)
      VALUES ('p1', 1, 'creating-visible', 'creating-card', 'creating-element', 9000, 0, 'creating', 'streaming', '2026-10-01T00:01:00.000Z', '2026-10-01T00:01:00.000Z');
    `);
    seedCommandIntent(stores, "intent-main-only");
    const snapshot = stores.primaryCardRedelivery.loadSnapshot({ bindingId: "b1", expectedBindingGeneration: 1 });
    expect(snapshot).toMatchObject({ outcome: "available", answer: null });
    if (snapshot.outcome !== "available") throw new Error("expected available snapshot");

    expect(stores.primaryCardRedelivery.reserve({
      commandIntentId: "intent-main-only", snapshot, mainCard: { surface: "main" }, answerCard: null
    })).toEqual({ outcome: "scheduled", mainScheduled: true, answerScheduled: false });
    expect(redeliveryReplies(stores)).toHaveLength(1);
    expect(stores.driver.database.prepare("SELECT outcome, prompt_id, answer_reply_id FROM primary_card_redeliveries").get())
      .toEqual({ outcome: "main_only", prompt_id: null, answer_reply_id: null });
  });

  it("selects only the latest eligible page of a multi-page Answer", () => {
    stores = createTestStoreBundle();
    prepareActivePrimary(stores);
    stores.driver.database.exec(`
      UPDATE answer_pages SET state='finished' WHERE prompt_id='p1' AND page_index=0;
      INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at)
      VALUES ('p1', 1, 'answer-latest', 'card-latest', 'latest-element', 9000, 7, 'active', 'streaming', '2026-10-01T00:01:00.000Z', '2026-10-01T00:01:00.000Z');
    `);
    expect(stores.primaryCardRedelivery.loadSnapshot({ bindingId: "b1", expectedBindingGeneration: 1 }))
      .toMatchObject({ outcome: "available", answer: { page: { pageIndex: 1, messageId: "answer-latest", sequence: 7 } } });
  });

  it("is idempotent for the same Command Intent across reopen", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "swarm-redelivery-"));
    const databasePath = join(temporaryDirectory, "state.db");
    stores = createTestStoreBundle(databasePath);
    expect(stores.driver.database.prepare("SELECT 1 AS present FROM schema_migrations WHERE version=77").get()).toEqual({ present: 1 });
    prepareActivePrimary(stores);
    seedCommandIntent(stores, "intent-reopen");
    const snapshot = availableSnapshot(stores);
    expect(reserveCards(stores, "intent-reopen", snapshot)).toMatchObject({ outcome: "scheduled" });
    stores.driver.close();

    stores = createTestStoreBundle(databasePath);
    expect(reserveCards(stores, "intent-reopen", snapshot)).toEqual({ outcome: "duplicate", mainScheduled: true, answerScheduled: true });
    expect(redeliveryReplies(stores)).toHaveLength(2);
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM primary_card_redeliveries").get()).toEqual({ count: 1 });
  });

  it("allocates higher snapshot revisions for a later Command Intent with identical cards", () => {
    stores = createTestStoreBundle();
    prepareActivePrimary(stores);
    seedCommandIntent(stores, "intent-1");
    expect(reserveCards(stores, "intent-1", availableSnapshot(stores))).toMatchObject({ outcome: "scheduled" });
    seedCommandIntent(stores, "intent-2");
    expect(reserveCards(stores, "intent-2", availableSnapshot(stores))).toMatchObject({ outcome: "scheduled" });

    expect(stores.driver.database.prepare(`SELECT projection_key, MAX(snapshot_revision) AS revision
      FROM outbound_replies WHERE projection_key LIKE 'primary-redelivery:%'
      GROUP BY projection_key ORDER BY projection_key`).all()).toEqual([
      { projection_key: "primary-redelivery:answer:p1:0", revision: 2 },
      { projection_key: "primary-redelivery:main:b1:1", revision: 2 }
    ]);
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM primary_card_redeliveries").get()).toEqual({ count: 2 });
  });

  it("fails closed for inactive, generation-stale, and projection-stale contexts", () => {
    stores = createTestStoreBundle();
    prepareActivePrimary(stores);
    expect(stores.primaryCardRedelivery.loadSnapshot({ bindingId: "b1", expectedBindingGeneration: 2 }))
      .toEqual({ outcome: "unavailable", reason: "stale_binding" });
    stores.driver.updateBinding("b1", { state: "archived" });
    expect(stores.primaryCardRedelivery.loadSnapshot({ bindingId: "b1", expectedBindingGeneration: 1 }))
      .toEqual({ outcome: "unavailable", reason: "stale_binding" });

    stores.driver.updateBinding("b1", { state: "active" });
    seedCommandIntent(stores, "intent-stale");
    const snapshot = availableSnapshot(stores);
    stores.driver.saveTopicView({ ...snapshot.topic, title: "Changed", viewVersion: snapshot.topic.viewVersion + 1 });
    expect(reserveCards(stores, "intent-stale", snapshot)).toEqual({ outcome: "stale", reason: "projection_changed" });
    expect(redeliveryReplies(stores)).toHaveLength(0);
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM primary_card_redeliveries").get()).toEqual({ count: 0 });
  });

  it("rolls back the Main effect and Answer sequence when Answer reservation fails", () => {
    stores = createTestStoreBundle();
    prepareActivePrimary(stores);
    seedCommandIntent(stores, "intent-rollback");
    const snapshot = availableSnapshot(stores);
    stores.driver.database.exec(`CREATE TRIGGER reject_redelivery_answer BEFORE INSERT ON outbound_replies
      WHEN NEW.projection_key LIKE 'primary-redelivery:answer:%'
      BEGIN SELECT RAISE(ABORT, 'forced answer reservation failure'); END;`);

    expect(() => reserveCards(stores!, "intent-rollback", snapshot)).toThrow(/forced answer reservation failure/);
    expect(redeliveryReplies(stores)).toHaveLength(0);
    expect(stores.driver.database.prepare("SELECT sequence FROM answer_pages WHERE prompt_id='p1' AND page_index=0").get()).toEqual({ sequence: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM primary_card_redeliveries").get()).toEqual({ count: 0 });
  });
});

function prepareActivePrimary(bundle: TestStoreBundle): void {
  bundle.driver.createPendingBinding({
    id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1",
    rootMessageId: "root-1", title: "Task", creatorOpenId: "user-1"
  });
  bundle.driver.updateBinding("b1", {
    state: "active", lifecycle: "active", attachment: "attached", generation: 1,
    paneId: "w1:p1", statusMessageId: "main-1", statusCardSequence: 0
  });
  bundle.driver.saveTopicView({
    ...initialTopicView("b1"), bindingGeneration: 1, title: "Task", workspaceId: "w1",
    paneId: "w1:p1", phase: "running", activePromptId: "p1", viewVersion: 4, deliveredVersion: 4
  });
  const view = createQueuedRunCard({
    promptId: "p1", bindingId: "b1", bindingGeneration: 1, title: "Task",
    workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 0,
    occurredAt: "2026-10-01T00:00:00.000Z"
  });
  bundle.driver.acceptPrompt({
    prompt: { id: "p1", bindingId: "b1", larkMessageId: "request-1", actorOpenId: "user-1", body: "work" },
    view, rootMessageId: "root-1", answerCard: { initial: true }
  });
  const create = bundle.driver.listPendingOutboundReplies().find((reply) => reply.promptId === "p1" && reply.kind === "stream_card_create");
  if (!create) throw new Error("expected initial Answer creation");
  bundle.driver.markOutboundReplyDelivered(create.id, "answer-1", "answer-card-1");
  bundle.driver.database.prepare("UPDATE prompt_jobs SET state='running', observation_state='attached' WHERE id='p1'").run();
  const run = bundle.driver.loadRunCard("p1");
  if (!run) throw new Error("expected Run Card");
  bundle.driver.saveRunCard({ ...run, phase: "running", viewVersion: 3 });
}

function seedCommandIntent(bundle: TestStoreBundle, id: string): void {
  const timestamp = "2026-10-01T00:01:00.000Z";
  bundle.driver.database.prepare(`INSERT INTO swarm_command_intents(
    id, idempotency_key, lane_key, command_json, context_json, replay_policy,
    state, attempt_count, created_at, updated_at
  ) VALUES (?, ?, 'binding:b1', '{}', '{}', 'reconcilable', 'executing', 1, ?, ?)`)
    .run(id, `command:${id}`, timestamp, timestamp);
}

function prepareHistoricalPrompt(bundle: TestStoreBundle, promptId: string, answerMessageId: string): void {
  const view = createQueuedRunCard({
    promptId, bindingId: "b1", bindingGeneration: 1, title: "History", workspaceId: "w1",
    paneId: "w1:p1", requestText: "history", queuePosition: 0,
    occurredAt: "2026-10-01T00:02:00.000Z"
  });
  bundle.driver.acceptPrompt({
    prompt: { id: promptId, bindingId: "b1", larkMessageId: `request-${promptId}`, actorOpenId: "user-1", body: "history" },
    view, rootMessageId: "root-1", answerCard: { initial: promptId }
  });
  const create = bundle.driver.listPendingOutboundReplies().find((reply) => reply.promptId === promptId && reply.kind === "stream_card_create");
  if (!create) throw new Error("expected historical Answer creation");
  bundle.driver.markOutboundReplyDelivered(create.id, answerMessageId, `card-${promptId}`);
  bundle.driver.database.prepare("UPDATE prompt_jobs SET state='delivered', observation_state='completed', created_at=? WHERE id=?")
    .run("9999-10-01T00:02:00.000Z", promptId);
  bundle.driver.database.prepare("UPDATE run_cards SET phase='completed', view_version=2 WHERE prompt_id=?").run(promptId);
  bundle.driver.database.prepare("UPDATE answer_pages SET state='finished' WHERE prompt_id=?").run(promptId);
}

function availableSnapshot(bundle: TestStoreBundle) {
  const snapshot = bundle.primaryCardRedelivery.loadSnapshot({ bindingId: "b1", expectedBindingGeneration: 1 });
  if (snapshot.outcome !== "available") throw new Error(`expected available snapshot, got ${snapshot.reason}`);
  return snapshot;
}

function reserveCards(bundle: TestStoreBundle, commandIntentId: string, snapshot: ReturnType<typeof availableSnapshot>) {
  return bundle.primaryCardRedelivery.reserve({
    commandIntentId, snapshot, mainCard: { surface: "main" },
    answerCard: snapshot.answer ? { surface: "answer" } : null
  });
}

function redeliveryReplies(bundle: TestStoreBundle) {
  return bundle.driver.database.prepare("SELECT * FROM outbound_replies WHERE projection_key LIKE 'primary-redelivery:%'").all();
}

function nativeInputExecutionRows(bundle: TestStoreBundle) {
  return {
    inputs: bundle.driver.database.prepare("SELECT id, state, batch_id FROM prompt_inputs ORDER BY id").all(),
    batches: bundle.driver.database.prepare("SELECT id, state, execution_prompt_id FROM native_input_batches ORDER BY id").all(),
    members: bundle.driver.database.prepare("SELECT batch_id, prompt_input_id, ordinal FROM native_input_batch_members ORDER BY batch_id, ordinal").all(),
    prompts: bundle.driver.database.prepare(`SELECT id, state, observation_state, dispatched_at, native_submission_id
      FROM prompt_jobs ORDER BY id`).all()
  };
}

function preparedPlan(reply: OutboundReply): PreparedDeliveryPlan {
  const intent = reply.kind === "card_reply"
    ? { kind: "message.reply.view", purpose: "session-status", rootMessageId: reply.rootMessageId, view: {}, idempotencyKey: reply.idempotencyKey }
    : { kind: "surface.replace", purpose: "session-status", messageId: reply.rootMessageId, view: {}, ...(reply.cardSequence === null ? {} : { sequence: reply.cardSequence }) };
  return {
    protocolVersion: 1,
    gatewayId: reply.gatewayId,
    profileId: reply.gatewayProfileId,
    rendererRevision: 1,
    operation: intent.kind,
    intent
  };
}
