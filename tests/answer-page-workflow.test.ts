import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnswerPageWorkflow } from "../src/coordinator/answer-page-workflow.js";
import { applicationPresentation, primaryPresentation } from "./helpers/presentation.js";
import { answerElementId, createQueuedRunCard } from "../src/domain/run-card-view.js";
import { ANSWER_STREAM_PAGE_LIMIT, answerStreamContent } from "../src/runtime/answer-stream.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import type { PreparedDeliveryClaim } from "../src/domain/delivery.js";
import type { DeliveryFailureMetadata } from "../src/domain/types.js";

function withHumanReviewChoice(answer: string): string {
  return `${answer}\n\n\`\`\`herdr-choice-list\n{"version":2,"intent":"human_review","question":"请选择下一步。","default":"approve","options":[{"id":"approve","label":"批准","message":"default"},{"id":"continue","label":"继续","message":"继续。"},{"id":"reject","label":"拒绝","message":"拒绝。"}]}\n\`\`\``;
}

function claimRingDelivery(store: SqliteBindingStore, replyId: string, _dueAt: string | null = null): PreparedDeliveryClaim {
  if (!store.database.prepare("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='bridge_write_fence'").get()) {
    const lease = store.acquireInstanceLease("answer-page-workflow-test", new Date().toISOString(), "2099-01-01T00:00:00.000Z");
    if (!lease) throw new Error("Expected test Ring lease");
    store.activateWriteFence(lease.ownerId, lease.fencingToken);
  }
  const hydrated = store.preparedDeliveries.hydratePreparedDelivery(replyId);
  if (hydrated.status !== "prepared") throw new Error(`Expected prepared delivery ${replyId}, got ${hydrated.status}: ${JSON.stringify(store.getOutboundReply(replyId))}`);
  const at = "2098-01-01T00:00:00.000Z";
  let claim = store.preparedDeliveries.claimPreparedDelivery({ delivery: hydrated.delivery, at, expiresAt: "2098-01-01T00:01:00.000Z" });
  if (!claim) {
    store.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 100, at });
    claim = store.preparedDeliveries.claimPreparedDelivery({ delivery: hydrated.delivery, at, expiresAt: "2098-01-01T00:01:00.000Z" });
  }
  if (!claim) {
    const heads = store.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 100, at });
    const rows = store.database.prepare(`SELECT reply.id,reply.kind,reply.state,reply.stream_page_index,reply.projection_key,reply.scope_key,
      reply.delivery_owner_kind,reply.delivery_owner_id,reply.delivery_owner_generation,reply.delivery_owner_session_generation,
      recovery.action,recovery.state AS recovery_state,recovery.replacement_reply_id
      FROM outbound_replies reply LEFT JOIN delivery_recoveries recovery
        ON recovery.failed_reply_id=reply.id OR recovery.replacement_reply_id=reply.id
      WHERE reply.scope_key=(SELECT scope_key FROM outbound_replies WHERE id=?) ORDER BY reply.delivery_order`).all(replyId);
    throw new Error(`Expected claimable Ring delivery ${replyId}: ${JSON.stringify({ reply: store.getOutboundReply(replyId), heads, rows })}`);
  }
  return claim;
}

function settleRingDelivery(store: SqliteBindingStore, target: string | PreparedDeliveryClaim, messageId: string, cardId?: string, topicId?: string): boolean {
  const claim = typeof target === "string" ? claimRingDelivery(store, target) : target;
  return store.preparedDeliveries.acknowledgePreparedDelivery(claim, { messageId, surfaceId: cardId ?? null, threadId: topicId ?? null });
}

function failRingDelivery(store: SqliteBindingStore, target: string | PreparedDeliveryClaim, error: string, metadata: DeliveryFailureMetadata, retryDelayMs = 0) {
  const claim = typeof target === "string" ? claimRingDelivery(store, target) : target;
  const outcome = store.preparedDeliveries.failPreparedDelivery(claim, { error, metadata, retryAt: new Date(Date.now() + retryDelayMs).toISOString() });
  const reply = store.getOutboundReply(claim.replyId)!;
  const recovery = store.database.prepare("SELECT action FROM delivery_recoveries WHERE failed_reply_id=?").get(claim.replyId) as { action: string } | undefined;
  const quarantine = store.database.prepare("SELECT action,lane_class FROM outbox_lane_quarantines WHERE failed_reply_id=?").get(claim.replyId) as { action: string; lane_class: string } | undefined;
  return { ...reply, reply, action: outcome === "retry" ? "retry" : recovery?.action ?? quarantine?.action, laneClass: quarantine?.lane_class };
}

function readyStore(path = ":memory:"): SqliteBindingStore {
  const store = new SqliteBindingStore(path);
  store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
  store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1" });
  const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
  store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
  store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");
  store.database.prepare("UPDATE answer_pages SET delivery_mode = 'streaming' WHERE prompt_id = 'p1'").run();
  return store;
}

describe("AnswerPageWorkflow", () => {
  it("renders a catch-up warning while an Answer delivery gap awaits its exact snapshot checkpoint", async () => {
    const store = readyStore();
    try {
      store.database.prepare("UPDATE answer_pages SET delivery_mode = 'static' WHERE prompt_id = 'p1'").run();
      const initial = store.loadRunCard("p1")!;
      store.saveRunCard({ ...initial, phase: "running", answer: "canonical answer", answerSegments: ["canonical answer"], viewVersion: initial.viewVersion + 1 });
      expect(store.reserveStaticAnswerCardUpdate({ promptId: "p1", pageIndex: 0, messageId: "answer-1", card: { content: "rejected" } })).toBe("reserved");
      const failed = store.listPendingOutboundReplies()[0]!;
      store.markOutboundReplyFailedWithQuarantine(failed.id, "rejected", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230099" });

      await new AnswerPageWorkflow(store, vi.fn(), primaryPresentation).converge("p1");

      const [catchUp] = store.listPendingOutboundReplies();
      expect(catchUp).toMatchObject({ kind: "card_update", cardRole: "answer", laneKey: "gateway:feishu:primary:answer:p1:0" });
      expect(catchUp!.payload.match(/有 1 条更新未能实时展示/g)).toHaveLength(1);
      expect(catchUp!.payload).toContain("当前内容已同步到最新状态");
      expect(store.getProjectionGapSummary({ bindingId: "b1", promptId: "p1", pageIndex: 0 }).openDelivery).toBe(1);
    } finally { store.close(); }
  });

  it("prioritizes one projection-omission warning over delivery catch-up wording", async () => {
    const store = readyStore();
    try {
      store.database.prepare("UPDATE answer_pages SET delivery_mode = 'static' WHERE prompt_id = 'p1'").run();
      const view = store.loadRunCard("p1")!;
      store.saveRunCard({ ...view, phase: "running", answer: "canonical answer", answerSegments: ["canonical answer"], viewVersion: view.viewVersion + 1 });
      store.database.prepare(`INSERT INTO projection_gaps(
        stage,owner_kind,owner_id,source_item_id,failure_class,failure_code,first_failed_at,last_failed_at
      ) VALUES ('core_projection','binding','b1','event-1','projection','reducer_failed','now','now')`).run();

      await new AnswerPageWorkflow(store, vi.fn(), primaryPresentation).converge("p1");

      const [snapshot] = store.listPendingOutboundReplies();
      expect(snapshot!.payload.match(/有 1 条过程更新未能展示/g)).toHaveLength(1);
      expect(snapshot!.payload).toContain("后续消息仍在同步");
      expect(snapshot!.payload).not.toContain("当前内容已同步到最新状态");
    } finally { store.close(); }
  });

  it("checkpoints a timeline page only after its durable card update is delivered", async () => {
    const store = readyStore();
    try {
      const view = store.loadRunCard("p1")!;
      store.saveRunCard({ ...view, phase: "running", timelineItems: [
        { kind: "agent_message", id: "message:one", sequence: 1, markdown: "Before tool" },
        { kind: "tool", id: "tool:one", sequence: 2, category: "read", label: "src/store.ts", resultPreview: "found", state: "succeeded" }
      ], viewVersion: view.viewVersion + 1 });
      const wake = vi.fn();
      const workflow = new AnswerPageWorkflow(store, wake, primaryPresentation);

      await workflow.converge("p1");
      const [update] = store.listPendingOutboundReplies();
      expect(update).toMatchObject({ kind: "card_update", rootMessageId: "answer-1", cardSequence: 1 });
      expect(update!.payload).toContain("📖 Read src/store.ts");
      expect(store.getAnswerTimelinePage("p1", 0)).toMatchObject({ deliveredCursor: null, pending: true });

      await workflow.converge("p1");
      expect(store.listPendingOutboundReplies()).toHaveLength(1);
      store.markOutboundReplyDelivered(update!.id, "answer-1");
      expect(store.getAnswerTimelinePage("p1", 0)).toMatchObject({ deliveredCursor: null, pending: false, deliveredItems: expect.arrayContaining([expect.objectContaining({ id: "tool:one" })]) });
      await workflow.converge("p1");
      expect(store.listPendingOutboundReplies()).toEqual([]);
    } finally { store.close(); }
  });

  it("revises a timeline delivery when rendering changes without a view-version change", () => {
    const store = readyStore();
    try {
      const view = store.loadRunCard("p1")!;
      const items = [{ kind: "agent_message" as const, id: "message:one", sequence: 1, markdown: "visible" }];
      store.saveRunCard({ ...view, phase: "running", timelineItems: items, viewVersion: view.viewVersion + 1 });
      expect(store.reserveAnswerTimelineCard({ promptId: "p1", pageIndex: 0, messageId: "answer-1", card: { content: "before" }, cursor: null, items })).toBe("reserved");
      const first = store.listPendingOutboundReplies()[0]!;
      store.markOutboundReplyDelivered(first.id, "answer-1");

      const changedItems = [{ ...items[0]!, markdown: "visible after sanitization" }];
      expect(store.reserveAnswerTimelineCard({ promptId: "p1", pageIndex: 0, messageId: "answer-1", card: { content: "after" }, cursor: null, items: changedItems })).toBe("reserved");

      expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({
        idempotencyKey: `${first.idempotencyKey}:revision:2`,
        payload: JSON.stringify({ content: "after" })
      })]);
      expect(store.database.prepare("SELECT projection_key, snapshot_revision FROM outbound_replies WHERE idempotency_key = ?").get(`${first.idempotencyKey}:revision:2`)).toEqual({
        projection_key: "answer-timeline:p1:0", snapshot_revision: 2
      });
    } finally { store.close(); }
  });

  it("continues a timeline at an item cursor without splitting its Tool panel", async () => {
    const store = readyStore();
    try {
      const view = store.loadRunCard("p1")!;
      store.saveRunCard({ ...view, phase: "running", timelineItems: [
        { kind: "final_answer", id: "message:long", sequence: 1, markdown: "line\n".repeat(Math.ceil(ANSWER_STREAM_PAGE_LIMIT / 5)) },
        { kind: "tool", id: "tool:one", sequence: 2, category: "command", label: "npm test", command: "npm test", resultPreview: "passed", state: "succeeded" }
      ], viewVersion: view.viewVersion + 1 });
      const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);

      await workflow.converge("p1");
      const firstUpdate = store.listPendingOutboundReplies()[0]!;
      expect(firstUpdate.payload).not.toContain("npm test");
      store.markOutboundReplyDelivered(firstUpdate.id, "answer-1");
      await workflow.converge("p1");

      const pending = store.listPendingOutboundReplies();
      expect(pending.filter(({ kind }) => kind === "stream_card_create")).toHaveLength(1);
      const continuation = pending.find(({ kind }) => kind === "stream_card_create")!;
      expect(continuation.payload).toContain("npm test");
      expect(store.getAnswerTimelinePage("p1", 1).startCursor).toMatchObject({ itemIndex: expect.any(Number), markdownOffset: expect.any(Number) });
      await workflow.converge("p1");
      expect(store.listPendingOutboundReplies().filter(({ kind }) => kind === "stream_card_create")).toHaveLength(1);
    } finally { store.close(); }
  });

  it("projects a late Tool result onto the active page without patching its frozen source page", async () => {
    const store = readyStore();
    try {
      const initial = store.loadRunCard("p1")!;
      const runningTool = { kind: "tool" as const, id: "tool:late", sequence: 1, category: "command" as const, label: "npm test", command: "npm test", state: "running" as const };
      store.saveRunCard({ ...initial, phase: "running", timelineItems: [
        runningTool,
        { kind: "final_answer", id: "message:long", sequence: 2, markdown: "line\n".repeat(Math.ceil(ANSWER_STREAM_PAGE_LIMIT / 5)) }
      ], viewVersion: initial.viewVersion + 1 });
      const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);

      await workflow.converge("p1");
      const first = store.listPendingOutboundReplies()[0]!;
      store.markOutboundReplyDelivered(first.id, "answer-1");
      await workflow.converge("p1");
      const continuationBatch = store.listPendingOutboundReplies();
      for (const reply of continuationBatch) {
        if (reply.kind === "stream_card_create") store.markOutboundReplyDelivered(reply.id, "answer-2", "card-2");
        else store.markOutboundReplyDelivered(reply.id, reply.rootMessageId ?? "answer-1");
      }
      expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ pageIndex: 0, state: "frozen" }), expect.objectContaining({ pageIndex: 1, state: "active" })]);

      const current = store.loadRunCard("p1")!;
      store.saveRunCard({ ...current, timelineItems: [{ ...runningTool, state: "succeeded", resultPreview: "all tests passed" }, current.timelineItems[1]!], viewVersion: current.viewVersion + 1 });
      await workflow.converge("p1");

      const [lateUpdate] = store.listPendingOutboundReplies();
      expect(lateUpdate).toMatchObject({ kind: "card_update", rootMessageId: "answer-2" });
      expect(lateUpdate!.payload).toContain("npm test");
      expect(lateUpdate!.payload).not.toContain("更新自第 1 页");
      expect(lateUpdate!.payload).toContain("all tests passed");
      expect(lateUpdate!.payload).not.toContain('"rootMessageId":"answer-1"');
      store.markOutboundReplyDelivered(lateUpdate!.id, "answer-2");
      await workflow.converge("p1");
      const later = store.listPendingOutboundReplies();
      expect(later.some((reply) => reply.rootMessageId === "answer-1")).toBe(false);
      expect(later.filter((reply) => reply.payload.includes("all tests passed"))).toHaveLength(1);
    } finally { store.close(); }
  });

  it("projects late Subagent content onto the active continuation without patching its frozen source page", async () => {
    const store = readyStore();
    try {
      const initial = store.loadRunCard("p1")!;
      const runningAgent = { kind: "status" as const, id: "agent:reviewer", sequence: 2, label: "Agent · reviewer", state: "running" as const };
      store.saveRunCard({ ...initial, phase: "running", timelineItems: [
        { kind: "agent_message", id: "message:long", sequence: 1, markdown: "line\n".repeat(Math.ceil(ANSWER_STREAM_PAGE_LIMIT / 5)) },
        runningAgent
      ], viewVersion: initial.viewVersion + 1 });
      const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);

      await workflow.converge("p1");
      const first = store.listPendingOutboundReplies()[0]!;
      store.markOutboundReplyDelivered(first.id, "answer-1");
      await workflow.converge("p1");
      for (const reply of store.listPendingOutboundReplies()) {
        if (reply.kind === "stream_card_create") store.markOutboundReplyDelivered(reply.id, "answer-2", "card-2");
        else store.markOutboundReplyDelivered(reply.id, reply.rootMessageId ?? "answer-1");
      }
      expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ pageIndex: 0, state: "frozen" }), expect.objectContaining({ pageIndex: 1, state: "active" })]);

      const current = store.loadRunCard("p1")!;
      store.saveRunCard({ ...current, timelineItems: [current.timelineItems[0]!, { ...runningAgent, state: "completed", detail: "Reviewed the complete change.", detailTruncated: false }], viewVersion: current.viewVersion + 1 });
      await workflow.converge("p1");

      const [lateUpdate] = store.listPendingOutboundReplies();
      expect(lateUpdate).toMatchObject({ kind: "card_update", rootMessageId: "answer-2" });
      expect(lateUpdate!.payload).toContain("Reviewed the complete change.");
      expect(lateUpdate!.payload).not.toContain('"rootMessageId":"answer-1"');
    } finally { store.close(); }
  });

  describe("immutable Answer snapshots", () => {
    it("does not requeue an unchanged delivered static snapshot on convergence", async () => {
      const store = readyStore();
      try {
        store.database.prepare("UPDATE answer_pages SET delivery_mode = 'static' WHERE prompt_id = 'p1'").run();
        const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
        await workflow.converge("p1");
        const first = store.listPendingOutboundReplies()[0]!;
        expect(first).toMatchObject({ kind: "card_update", cardSequence: 1 });
        store.markOutboundReplyDelivered(first.id, "answer-1");
        await workflow.converge("p1");
        expect(store.listPendingOutboundReplies()).toEqual([]);
        expect(store.getOutboundReply(first.id)).toMatchObject({ payload: first.payload, viewVersion: first.viewVersion, state: "delivered", attemptCount: 1 });
      } finally { store.close(); }
    });

    it("preserves rejection evidence for unchanged final content", () => {
      const store = readyStore();
      try {
        store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = 'p1'").run();
        const input = { promptId: "p1", pageIndex: 0, cardId: "card-1", messageId: "answer-1", card: { schema: "2.0" } };
        expect(store.reserveFinalAnswerCardUpdate(input)).toBe("reserved");
        const first = store.listPendingOutboundReplies()[0]!;
        store.markOutboundReplyFailedWithQuarantine(first.id, "content rejected", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "230028" });
        expect(store.getOutboundReply(first.id)).toMatchObject({ state: "dead_letter", larkErrorCode: "230028" });
        const failed = store.getOutboundReply(first.id);
        expect(store.reserveFinalAnswerCardUpdate(input)).toBe("waiting");
        expect(store.getOutboundReply(first.id)).toEqual(failed);
        expect(store.listPendingOutboundReplies()).toEqual([]);
      } finally { store.close(); }
    });

    it.each(["230031", "230001"])("freezes an expired Answer target rejected with %s and converges through a new static CardKit page", async (larkErrorCode) => {
      const store = readyStore();
      try {
        store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = 'p1'").run();
        const source = primaryPresentation.answerStreamContent(store.loadRunCard("p1")!);
        const input = { promptId: "p1", pageIndex: 0, cardId: "card-1", messageId: "answer-1", card: { content: "first" }, source };
        expect(store.reserveFinalAnswerCardUpdate(input)).toBe("reserved");
        const first = store.listPendingOutboundReplies()[0]!;
        const claim = claimRingDelivery(store, first.id);
        expect(failRingDelivery(store, claim, "message expired", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode, recoveryKind: "expired_view_target" })).toMatchObject({
          action: "expired_view_target", state: "dead_letter"
        });

        const advanced = store.loadRunCard("p1")!;
        store.saveRunCard({ ...advanced, viewVersion: advanced.viewVersion + 1 });
        expect(store.reserveFinalAnswerCardUpdate({ ...input, card: { content: "newer" } })).toBe("waiting");
        expect(store.listPendingOutboundReplies()).toEqual([]);
        expect(store.database.prepare("SELECT state, action FROM delivery_recoveries WHERE failed_reply_id = ?").get(first.id)).toEqual({ state: "unresolved", action: "expired_view_target" });
        expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ pageIndex: 0, state: "frozen", deliveryMode: "static" })]);

        const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
        await workflow.converge("p1");
        const replacement = store.listPendingOutboundReplies()[0]!;
        expect(replacement).toMatchObject({ kind: "stream_card_create", promptId: "p1" });
        expect(JSON.parse(replacement.payload).stream).toMatchObject({ pageIndex: 1, deliveryMode: "static" });
        settleRingDelivery(store, replacement.id, "answer-2", "card-2");

        await workflow.converge("p1");
        const catchUp = store.listPendingOutboundReplies()[0]!;
        expect(catchUp).toMatchObject({ kind: "card_update", rootMessageId: "answer-2" });
        settleRingDelivery(store, catchUp.id, "answer-2");
        expect(store.database.prepare("SELECT state, action FROM delivery_recoveries WHERE failed_reply_id = ?").get(first.id)).toEqual({ state: "recovered", action: "expired_view_target" });
        expect(store.database.prepare("SELECT state FROM projection_gaps WHERE source_item_id=?").get(first.id)).toEqual({ state: "compensated" });
      } finally { store.close(); }
    });

    it("dismisses only unclaimed successors after an expired Answer target rejection", () => {
      const store = readyStore();
      try {
        store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = 'p1'").run();
        const target = { promptId: "p1", pageIndex: 0, cardId: "card-1", messageId: "answer-1" };
        expect(store.reserveFinalAnswerCardUpdate({ ...target, card: { content: "first" } })).toBe("reserved");
        const first = store.listPendingOutboundReplies()[0]!;
        const claim = claimRingDelivery(store, first.id);
        expect(store.reserveFinalAnswerCardUpdate({ ...target, card: { content: "second" } })).toBe("reserved");

        failRingDelivery(store, claim, "message expired", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230031", recoveryKind: "expired_view_target" });

        expect(store.listPendingOutboundReplies()).toEqual([]);
        expect(store.database.prepare("SELECT state FROM outbound_replies WHERE projection_key = ? ORDER BY snapshot_revision").all(`answer-final-fold:p1:0:card-1`)).toEqual([{ state: "dead_letter" }, { state: "dismissed" }]);
      } finally { store.close(); }
    });

    it("does not resend identical final payload when only the view version advances", () => {
      const store = readyStore();
      try {
        store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = 'p1'").run();
        const input = { promptId: "p1", pageIndex: 0, cardId: "card-1", messageId: "answer-1", card: { schema: "2.0" } };
        store.reserveFinalAnswerCardUpdate(input);
        const first = store.listPendingOutboundReplies()[0]!;
        store.markOutboundReplyDelivered(first.id, "answer-1");
        expect(store.reserveFinalAnswerCardUpdate(input)).toBe("waiting");
        const view = store.loadRunCard("p1")!;
        store.saveRunCard({ ...view, viewVersion: view.viewVersion + 1 });
        expect(store.reserveFinalAnswerCardUpdate(input)).toBe("waiting");
        expect(store.getOutboundReply(first.id)).toMatchObject({ state: "delivered", payload: first.payload });
        expect(store.listPendingOutboundReplies()).toEqual([]);
      } finally { store.close(); }
    });
  });

  it("coalesces an untouched A-B-A burst to the newest monotonic revision", () => {
    const store = readyStore();
    try {
      store.database.prepare("UPDATE answer_pages SET delivery_mode = 'static' WHERE prompt_id = 'p1'").run();
      const input = { promptId: "p1", pageIndex: 0, messageId: "answer-1", card: { content: "A" } };
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("reserved");
      expect(store.reserveStaticAnswerCardUpdate({ ...input, card: { content: "B" } })).toBe("reserved");
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("reserved");

      const pending = store.listPendingOutboundReplies();
      expect(pending.map((row) => JSON.parse(row.payload).content)).toEqual(["A"]);
      expect(store.database.prepare("SELECT snapshot_revision, state FROM outbound_replies WHERE projection_key IS NOT NULL ORDER BY snapshot_revision").all()).toEqual([
        { snapshot_revision: 1, state: "dismissed" },
        { snapshot_revision: 2, state: "dismissed" },
        { snapshot_revision: 3, state: "pending" }
      ]);
      expect(store.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 10, at: "2098-01-01T00:00:00.000Z" }).items).toEqual([expect.objectContaining({ replyId: pending[0]!.id })]);
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("waiting");
    } finally { store.close(); }
  });

  it("normalizes an unchanged legacy first revision before returning waiting", () => {
    const store = readyStore();
    try {
      store.database.prepare("UPDATE answer_pages SET delivery_mode = 'static' WHERE prompt_id = 'p1'").run();
      const input = { promptId: "p1", pageIndex: 0, messageId: "answer-1", card: { content: "A" } };
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("reserved");
      store.database.prepare("UPDATE outbound_replies SET projection_key = NULL WHERE idempotency_key = 'answer-static:p1:0:answer-1'").run();

      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("waiting");
      expect(store.database.prepare("SELECT projection_key FROM outbound_replies WHERE idempotency_key = 'answer-static:p1:0:answer-1'").get()).toEqual({ projection_key: "answer-static:p1:0:answer-1" });
    } finally { store.close(); }
  });

  it.each(["delivered", "dismissed"] as const)("preserves a %s snapshot when reserving changed content", (state) => {
    const store = readyStore();
    try {
      store.database.prepare("UPDATE answer_pages SET delivery_mode = 'static' WHERE prompt_id = 'p1'").run();
      const input = { promptId: "p1", pageIndex: 0, messageId: "answer-1", card: { content: "A" } };
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("reserved");
      const first = store.listPendingOutboundReplies()[0]!;
      if (state === "delivered") store.markOutboundReplyDelivered(first.id, "answer-1");
      else store.database.prepare("UPDATE outbound_replies SET state = 'dismissed' WHERE id = ?").run(first.id);

      expect(store.reserveStaticAnswerCardUpdate({ ...input, card: { content: "B" } })).toBe("reserved");
      expect(store.database.prepare("SELECT snapshot_revision, state FROM outbound_replies WHERE projection_key IS NOT NULL ORDER BY snapshot_revision").all()).toEqual([
        { snapshot_revision: 1, state },
        { snapshot_revision: 2, state: "pending" }
      ]);
    } finally { store.close(); }
  });

  it.each([
    ["attempted", "attempt_count = 1"],
    ["checkpointed", "card_id_checkpoint = 'card-checkpoint'"]
  ])("preserves an untouched-looking snapshot once it was %s", (_state, mutation) => {
    const store = readyStore();
    try {
      store.database.prepare("UPDATE answer_pages SET delivery_mode = 'static' WHERE prompt_id = 'p1'").run();
      const input = { promptId: "p1", pageIndex: 0, messageId: "answer-1", card: { content: "A" } };
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("reserved");
      const first = store.listPendingOutboundReplies()[0]!;
      store.database.prepare(`UPDATE outbound_replies SET ${mutation} WHERE id = ?`).run(first.id);

      expect(store.reserveStaticAnswerCardUpdate({ ...input, card: { content: "B" } })).toBe("reserved");
      expect(store.database.prepare("SELECT snapshot_revision FROM outbound_replies WHERE projection_key IS NOT NULL ORDER BY snapshot_revision").all()).toEqual([{ snapshot_revision: 1 }, { snapshot_revision: 2 }]);
    } finally { store.close(); }
  });

  it("cascades evidence for a coalesced snapshot and retains the newest evidence", () => {
    const store = readyStore();
    try {
      store.database.prepare("UPDATE answer_pages SET delivery_mode = 'static' WHERE prompt_id = 'p1'").run();
      const base = { promptId: "p1", pageIndex: 0, messageId: "answer-1" };
      expect(store.reserveStaticAnswerCardUpdate({ ...base, card: { content: "A" }, source: "source A" })).toBe("reserved");
      const first = store.listPendingOutboundReplies()[0]!;
      store.database.prepare("INSERT INTO delivery_recoveries(failed_reply_id, snapshot_revision, state, failure_class, reason, action, created_at, updated_at) VALUES ('failed-source', 1, 'replacement_pending', 'permanent', 'test', 'rebuild_answer', 'now', 'now')").run();
      store.database.prepare("INSERT INTO answer_recovery_links(failed_reply_id, prompt_id, binding_generation, source_page_index, replacement_page_index, source_start, source_end, source_hash) VALUES ('failed-source', 'p1', 1, 0, 0, 0, 8, 'hash')").run();
      store.database.prepare("INSERT INTO answer_recovery_candidates(failed_reply_id, reply_id) VALUES ('failed-source', ?)").run(first.id);

      expect(store.reserveStaticAnswerCardUpdate({ ...base, card: { content: "B" }, source: "source B" })).toBe("reserved");
      const second = store.listPendingOutboundReplies()[0]!;
      expect(store.getOutboundReply(first.id)).toMatchObject({
        state: "dismissed",
        error: "Coalesced unclaimed prompt snapshot before first attempt",
        payload: JSON.stringify({ content: "A" }),
        viewVersion: 1
      });
      expect(store.database.prepare("SELECT source_hash FROM answer_delivery_coverage WHERE reply_id = ?").get(first.id)).toEqual({
        source_hash: expect.any(String)
      });
      expect(store.database.prepare("SELECT failed_reply_id FROM answer_recovery_candidates WHERE reply_id = ?").get(first.id)).toEqual({
        failed_reply_id: "failed-source"
      });
      expect(store.database.prepare("SELECT failed_reply_id FROM answer_recovery_candidates WHERE reply_id = ?").get(second.id)).toBeUndefined();
      expect(store.database.prepare("SELECT source_hash FROM answer_delivery_coverage WHERE reply_id = ?").get(second.id)).toEqual({ source_hash: expect.any(String) });
    } finally { store.close(); }
  });

  it("preserves a pending snapshot referenced by an active recovery", () => {
    const store = readyStore();
    try {
      store.database.prepare("UPDATE answer_pages SET delivery_mode = 'static' WHERE prompt_id = 'p1'").run();
      const input = { promptId: "p1", pageIndex: 0, messageId: "answer-1", card: { content: "A" } };
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("reserved");
      const first = store.listPendingOutboundReplies()[0]!;
      store.database.prepare("INSERT INTO delivery_recoveries(failed_reply_id, snapshot_revision, state, failure_class, reason, action, replacement_reply_id, created_at, updated_at) VALUES ('failed-target', 1, 'replacement_pending', 'permanent', 'test', 'rebuild_answer', ?, 'now', 'now')").run(first.id);

      expect(store.reserveStaticAnswerCardUpdate({ ...input, card: { content: "B" } })).toBe("reserved");
      expect(store.database.prepare("SELECT snapshot_revision FROM outbound_replies WHERE projection_key IS NOT NULL ORDER BY snapshot_revision").all()).toEqual([{ snapshot_revision: 1 }, { snapshot_revision: 2 }]);
    } finally { store.close(); }
  });

  it("preserves an in-flight static snapshot while coalescing its untouched successors", () => {
    const store = readyStore();
    try {
      store.database.prepare("UPDATE answer_pages SET delivery_mode = 'static' WHERE prompt_id = 'p1'").run();
      const input = { promptId: "p1", pageIndex: 0, messageId: "answer-1", card: { content: "A" } };
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("reserved");
      const first = store.listPendingOutboundReplies()[0]!;
      const claim = claimRingDelivery(store, first.id);
      expect(store.reserveStaticAnswerCardUpdate({ ...input, card: { content: "B" } })).toBe("reserved");
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("reserved");
      expect(store.listPendingOutboundReplies().map((row) => JSON.parse(row.payload).content)).toEqual(["A", "A"]);
      expect(store.database.prepare("SELECT snapshot_revision, state FROM outbound_replies WHERE projection_key IS NOT NULL ORDER BY snapshot_revision").all()).toEqual([
        { snapshot_revision: 1, state: "pending" },
        { snapshot_revision: 2, state: "dismissed" },
        { snapshot_revision: 3, state: "pending" }
      ]);
      expect(settleRingDelivery(store, claim, "answer-1")).toBe(true);
      expect(store.listPendingOutboundReplies().map((row) => JSON.parse(row.payload).content)).toEqual(["A"]);
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("waiting");
      store.pruneDeliveredOutboundReplies("2099-01-01T00:00:00.000Z", 100);
      expect(store.getOutboundReply(first.id)).toBeNull();
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("waiting");
    } finally { store.close(); }
  });

  it.each(["full", "short", "rewritten", "generation"] as const)("requires a matching %s streaming replacement coverage receipt", async (scenario) => {
    const store = readyStore();
    try {
      const original = "original answer content";
      store.saveRunCard({ ...store.loadRunCard("p1")!, answer: original, answerSegments: [original], viewVersion: 2 });
      const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
      await workflow.converge("p1");
      const failed = store.listPendingOutboundReplies()[0]!;
      failRingDelivery(store, failed.id, "closed", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "300309", recoveryKind: "closed_answer_stream" });
      await workflow.converge("p1");
      const replacement = store.listPendingOutboundReplies()[0]!;
      expect(JSON.parse(replacement.payload).stream).toMatchObject({ deliveryMode: "static" });
      settleRingDelivery(store, replacement.id, "answer-2", "card-2");
      expect(store.getActiveAnswerPage("p1")).toMatchObject({ pageIndex: 1, deliveryMode: "static", messageId: "answer-2", cardId: "card-2" });
      expect(store.getOperationalSummary()).toMatchObject({ unresolvedDeadLetters: 1, deliveryRecoveries: { replacement_pending: 1, recovered: 0 } });
      const answer = scenario === "short" ? "original" : scenario === "rewritten" ? "different answer content" : `${original} appended`;
      store.saveRunCard({ ...store.loadRunCard("p1")!, answer, answerSegments: [answer], viewVersion: 3 });
      await workflow.converge("p1");
      const update = store.listPendingOutboundReplies()[0]!;
      expect(update).toMatchObject({ kind: "card_update", rootMessageId: "answer-2" });
      const first = claimRingDelivery(store, update.id);
      expect(() => store.database.prepare("UPDATE answer_delivery_coverage SET source_hash = 'wrong' WHERE reply_id = ?").run(update.id)).toThrow("immutable_answer_coverage");
      failRingDelivery(store, first, "temporary", { failureClass: "transient", httpStatus: 503, larkErrorCode: null });
      const retry = claimRingDelivery(store, update.id);
      expect(settleRingDelivery(store, first, "answer-2")).toBe(false);
      expect(store.getOperationalSummary().deliveryRecoveries.recovered).toBe(0);
      if (scenario === "generation") store.database.prepare("UPDATE bindings SET generation = generation + 1 WHERE id = 'b1'").run();
      settleRingDelivery(store, retry, "answer-2");
      expect(store.getOperationalSummary().deliveryRecoveries.recovered).toBe(scenario === "full" ? 1 : 0);
      expect(store.getOperationalSummary().unresolvedDeadLetters).toBe(scenario === "full" ? 0 : 1);
      expect(store.listAnswerPages("p1")[0]).toMatchObject({ state: "frozen", messageId: "answer-1" });
    } finally { store.close(); }
  });

  it("retains a Herdr human message canonically without rendering it on the Answer Card", async () => {
    const store = readyStore();
    try {
      const original = "original answer content";
      store.saveRunCard({ ...store.loadRunCard("p1")!, answer: original, answerSegments: [original], viewVersion: 2 });
      const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
      await workflow.converge("p1");
      const failed = store.listPendingOutboundReplies()[0]!;
      failRingDelivery(store, failed.id, "closed", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "300309", recoveryKind: "closed_answer_stream" });

      await workflow.converge("p1");
      const replacement = store.listPendingOutboundReplies()[0]!;
      settleRingDelivery(store, replacement.id, "answer-2", "card-2");
      const view = store.loadRunCard("p1")!;
      store.saveRunCard({ ...view, timelineItems: [
        { kind: "agent_message", id: "agent:1", sequence: 1, markdown: original },
        { kind: "human_message", id: "human:2", sequence: 2, markdown: "继续完善恢复逻辑" }
      ], viewVersion: view.viewVersion + 1 });

      await workflow.converge("p1");

      const pending = store.listPendingOutboundReplies();
      expect(pending.every((reply) => !reply.payload.includes("👤 **你**") && !reply.payload.includes("继续完善恢复逻辑"))).toBe(true);
      expect(store.loadRunCard("p1")?.timelineItems).toContainEqual({ kind: "human_message", id: "human:2", sequence: 2, markdown: "继续完善恢复逻辑" });
      expect(store.getActiveAnswerPage("p1")).toMatchObject({ pageIndex: 1 });
    } finally { store.close(); }
  });

  it("does not infer closed-stream recovery from a raw Lark code", async () => {
    const store = readyStore();
    try {
      store.saveRunCard({ ...store.loadRunCard("p1")!, answer: "partial answer", answerSegments: ["partial answer"], viewVersion: 2 });
      const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
      await workflow.converge("p1");
      const failed = store.listPendingOutboundReplies()[0]!;

      expect(failRingDelivery(store, failed.id, "closed", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "300309" })).toMatchObject({
        action: "blocked", laneClass: "answer_stream"
      });
      expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ pageIndex: 0, state: "active", deliveryMode: "streaming", messageId: "answer-1" })]);
      expect(store.listPendingOutboundReplies()).toEqual([]);
    } finally { store.close(); }
  });

  it("does not rebuild a frozen static Answer during startup without exact recovery evidence", async () => {
    const store = readyStore();
    try {
      const current = store.loadRunCard("p1")!;
      store.saveRunCard({ ...current, phase: "failed", answer: "durable failure", answerSegments: ["durable failure"], viewVersion: 20 });
      store.database.prepare("UPDATE answer_pages SET state = 'frozen', delivery_mode = 'static', card_id = NULL WHERE prompt_id = 'p1' AND page_index = 0").run();
      const legacy = store.enqueueOutboundReply({
        id: "legacy-v20", idempotencyKey: "run-card:update:p1:answer:20", workClass: "live",
        bindingId: "b1", promptId: "p1", viewVersion: 20, streamPageIndex: 0, cardRole: "answer",
        rootMessageId: "answer-1", kind: "card_update", payload: JSON.stringify({ legacy: true })
      });
      store.markOutboundReplyDeadLetter(legacy.id, "obsolete target", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230001" });
      const before = store.database.prepare("SELECT id, idempotency_key, state, work_class FROM outbound_replies WHERE prompt_id = 'p1' ORDER BY created_at, id").all();
      const wake = vi.fn();

      await expect(new AnswerPageWorkflow(store, wake, primaryPresentation).converge("p1", "history")).resolves.toBeUndefined();

      expect(store.database.prepare("SELECT id, idempotency_key, state, work_class FROM outbound_replies WHERE prompt_id = 'p1' ORDER BY created_at, id").all()).toEqual(before);
      expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ pageIndex: 0, state: "frozen", deliveryMode: "static", messageId: "answer-1", cardId: null })]);
      expect(store.database.prepare("SELECT COUNT(*) AS count FROM delivery_recoveries WHERE action = 'rebuild_answer'").get()).toEqual({ count: 0 });
      expect(wake).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it("classifies an exact persisted-plan Answer rejection without a projection key", () => {
    const store = readyStore();
    try {
      const current = store.loadRunCard("p1")!;
      store.saveRunCard({ ...current, phase: "running", answer: "latest durable answer", answerSegments: ["latest durable answer"], viewVersion: 2 });
      const failed = store.enqueueOutboundReply({
        id: "run-card-expired-v2", idempotencyKey: "run-card:update:p1:answer:2", workClass: "live",
        bindingId: "b1", promptId: "p1", viewVersion: 2, streamPageIndex: 0, cardRole: "answer",
        rootMessageId: "answer-1", kind: "card_update", payload: JSON.stringify({ version: 2 })
      });
      store.prepareOutboundGatewayPlan(failed.id, {
        gatewayId: "feishu:primary",
        gatewayProfileId: "feishu-cardkit-v1",
        gatewayPlanJson: JSON.stringify({
          protocolVersion: 1,
          gatewayId: "feishu:primary",
          profileId: "feishu-cardkit-v1",
          rendererRevision: 1,
          operation: "surface.replace",
          intent: { kind: "surface.replace", purpose: "primary-answer", messageId: "answer-1", view: { schemaVersion: 1, fallbackText: "answer" } }
        })
      });

      expect(failRingDelivery(store,
        failed.id,
        "expired target",
        { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230001", recoveryKind: "expired_view_target", providerOperation: "update_card" }
      )).toMatchObject({ action: "expired_view_target", laneClass: "replaceable_card" });
      expect(store.hasPendingExpiredAnswerTarget("p1", 0)).toBe(true);
      expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ pageIndex: 0, state: "frozen", deliveryMode: "static" })]);
    } finally { store.close(); }
  });

  it("keeps a persisted-plan Answer rejection blocked when the target message disagrees", () => {
    const store = readyStore();
    try {
      const failed = store.enqueueOutboundReply({
        id: "run-card-wrong-target", idempotencyKey: "run-card:update:p1:answer:2", workClass: "live",
        bindingId: "b1", promptId: "p1", viewVersion: 2, streamPageIndex: 0, cardRole: "answer",
        rootMessageId: "answer-1", kind: "card_update", payload: JSON.stringify({ version: 2 })
      });
      store.prepareOutboundGatewayPlan(failed.id, {
        gatewayId: "feishu:primary",
        gatewayProfileId: "feishu-cardkit-v1",
        gatewayPlanJson: JSON.stringify({
          protocolVersion: 1,
          gatewayId: "feishu:primary",
          profileId: "feishu-cardkit-v1",
          rendererRevision: 1,
          operation: "surface.replace",
          intent: { kind: "surface.replace", purpose: "primary-answer", messageId: "another-answer", view: { schemaVersion: 1, fallbackText: "answer" } }
        })
      });

      expect(store.preparedDeliveries.hydratePreparedDelivery(failed.id)).toMatchObject({ status: "invalid" });
      expect(store.hasPendingExpiredAnswerTarget("p1", 0)).toBe(false);
      expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ pageIndex: 0, state: "active", deliveryMode: "streaming" })]);
    } finally { store.close(); }
  });

  it("retains cross-page recovery links and coverage across reopen and outbox pruning", async () => {
    const directory = mkdtempSync(join(tmpdir(), "answer-evidence-"));
    const path = join(directory, "state.sqlite");
    let store = readyStore(path);
    try {
      store.saveRunCard({ ...store.loadRunCard("p1")!, answer: "persisted content", answerSegments: ["persisted content"], viewVersion: 2 });
      let workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
      await workflow.converge("p1");
      const failed = store.listPendingOutboundReplies()[0]!;
      failRingDelivery(store, failed.id, "closed", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "300309", recoveryKind: "closed_answer_stream" });
      await workflow.converge("p1");
      const replacement = store.listPendingOutboundReplies()[0]!;
      settleRingDelivery(store, replacement.id, "answer-2", "card-2");
      store.pruneDeliveredOutboundReplies("2099-01-01T00:00:00.000Z", 100);
      expect(store.getOutboundReply(replacement.id)).not.toBeNull();
      store.close();
      store = new SqliteBindingStore(path);
      workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
      await workflow.converge("p1");
      const update = store.listPendingOutboundReplies()[0]!;
      settleRingDelivery(store, update.id, "answer-2");
      expect(store.getOperationalSummary().deliveryRecoveries.recovered).toBe(1);
      store.pruneDeliveredOutboundReplies("2099-01-01T00:00:00.000Z", 100);
      expect(store.getOutboundReply(replacement.id)).toBeNull();
      store.close();
      store = new SqliteBindingStore(path);
      expect(store.getOperationalSummary()).toMatchObject({ unresolvedDeadLetters: 0, deliveryRecoveries: { recovered: 1 } });
      expect(store.database.prepare("SELECT resolved_by_reply_id, resolved_message_id FROM delivery_recoveries WHERE failed_reply_id = ?").get(failed.id)).toMatchObject({ resolved_by_reply_id: update.id, resolved_message_id: "answer-2" });
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("reserves one content intent and wakes delivery", async () => {
    const store = readyStore();
    store.saveRunCard({ ...store.loadRunCard("p1")!, answer: "hello", answerSegments: ["hello"], viewVersion: 2 });
    const wake = vi.fn();
    await new AnswerPageWorkflow(store, wake, primaryPresentation, pino({ enabled: false })).converge("p1");
    expect(wake).toHaveBeenCalledOnce();
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    expect(store.getActiveAnswerPage("p1")?.sequence).toBe(1);
    await new AnswerPageWorkflow(store, wake, primaryPresentation).converge("p1");
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    store.close();
  });

  it("does nothing until the initial Answer card is delivered", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const wake = vi.fn();
    await new AnswerPageWorkflow(store, wake, primaryPresentation).converge("p1");
    expect(wake).not.toHaveBeenCalled();
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    store.close();
  });

  it("reserves one terminal finish across repeated convergence", async () => {
    const store = readyStore();
    const content = "⏳ 已接收请求\n\ndone";
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "done", answerSegments: ["done"], viewVersion: 2 });
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: store.getActiveAnswerPage("p1")!.elementId, content })).toBe("reserved");
    const [contentReply] = store.listPendingOutboundReplies();
    store.markOutboundReplyDelivered(contentReply!.id, "card-1");
    const wake = vi.fn();
    const workflow = new AnswerPageWorkflow(store, wake, primaryPresentation);

    await Promise.all([workflow.converge("p1"), workflow.converge("p1"), workflow.converge("p1")]);

    expect(store.listPendingOutboundReplies()).toEqual([
      expect.objectContaining({ kind: "stream_finish", viewVersion: 2 }),
      expect.objectContaining({ kind: "card_update", cardRole: "answer", cardSequence: 3 })
    ]);
    expect(store.getActiveAnswerPage("p1")?.sequence).toBe(3);
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("keeps the final Answer button-free and reserves one separate fresh review card", async () => {
    const store = readyStore();
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "session-1",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1", lastAgentState: "working"
    });
    store.updatePrompt("p1", "running");
    store.completeTurn({ promptId: "p1", bindingId: "b1", answer: withHumanReviewChoice("done"), occurredAt: "2026-10-01T00:00:01.000Z", outputFingerprint: "fp" });
    const content = answerStreamContent(store.loadRunCard("p1")!);
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: store.getActiveAnswerPage("p1")!.elementId, content })).toBe("reserved");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");

    await new AnswerPageWorkflow(store, vi.fn(), applicationPresentation).converge("p1");

    const finalAnswer = store.listPendingOutboundReplies().find(({ kind }) => kind === "card_update")!;
    const review = store.listPendingOutboundReplies().find(({ projectionKey }) => projectionKey?.startsWith("completion-review:"))!;
    expect(finalAnswer.payload).not.toContain("请选择下一步。");
    expect(finalAnswer.payload).not.toContain('"action":"completion_action"');
    expect(review).toMatchObject({ kind: "card_reply", rootMessageId: "root-1", targetRole: "operation_result" });
    expect(review.payload).toContain("请选择下一步。");
    expect(review.payload).toContain('"optionId":"approve"');
    expect(review.payload).toContain('"optionId":"continue"');
    expect(review.payload).toContain('"optionId":"reject"');
    expect(review.payload).toContain('"optionId":"ignore"');
    expect(store.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("primary-next-input:"))).toHaveLength(0);
    store.close();
  });

  it("consumes a fresh review choice without rewriting the historical Answer snapshot", async () => {
    const store = readyStore();
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "session-1",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1", lastAgentState: "working"
    });
    store.updatePrompt("p1", "running");
    store.completeTurn({ promptId: "p1", bindingId: "b1", answer: withHumanReviewChoice("done"), occurredAt: "2026-10-01T00:00:01.000Z", outputFingerprint: "fp" });
    const content = answerStreamContent(store.loadRunCard("p1")!);
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: store.getActiveAnswerPage("p1")!.elementId, content })).toBe("reserved");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    const workflow = new AnswerPageWorkflow(store, vi.fn(), applicationPresentation);
    await workflow.converge("p1");
    const final = store.listPendingOutboundReplies().find(({ kind }) => kind === "card_update")!;
    store.markOutboundReplyDelivered(final.id, "answer-message", "card-1");
    const review = store.listPendingOutboundReplies().find(({ projectionKey }) => projectionKey?.startsWith("completion-review:"))!;
    store.markOutboundReplyDelivered(review.id, "review-message", "review-card");
    const actionSet = store.database.prepare("SELECT id FROM completion_action_sets WHERE owner_id = 'p1'").get() as { id: string };
    const decision = store.capabilityModules().cardInteraction.decidePrimaryCompletionReview({
      actionSetId: actionSet.id, optionId: "approve", messageId: "review-message",
      actorOpenId: "u1", chatId: "c1", occurredAt: "2026-10-01T00:00:02.000Z"
    });

    await workflow.converge("p1");

    expect(decision).toMatchObject({ kind: "submission", inserted: true });
    expect(store.database.prepare("SELECT state,selected_choice_option_id FROM completion_action_sets WHERE id=?").get(actionSet.id)).toEqual({
      state: "consumed", selected_choice_option_id: "approve"
    });
    expect(store.listPendingOutboundReplies().filter(({ kind }) => kind === "card_update")).toHaveLength(1);
    expect(final.payload).not.toContain('"action":"completion_action"');
    store.close();
  });

  it("finishes a delivered recovery chunk at canonical EOF without creating an empty page", async () => {
    const store = readyStore();
    const completed = store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "done", answerSegments: ["done"], viewVersion: 2 });
    const content = answerStreamContent(completed);
    store.enqueueOutboundReply({
      id: "recovery-content", idempotencyKey: "startup-lite-content:failed-content", bindingId: "b1", promptId: "p1", viewVersion: 1, cardRole: "answer",
      rootMessageId: "card-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: store.getActiveAnswerPage("p1")!.elementId, content, sequence: 1, sourceEnd: content.length })
    });
    store.markOutboundReplyDelivered("recovery-content", "card-1");

    await new AnswerPageWorkflow(store, vi.fn(), primaryPresentation).converge("p1");

    expect(store.listPendingOutboundReplies()).toEqual([
      expect.objectContaining({ kind: "stream_finish", viewVersion: 2 }),
      expect.objectContaining({ kind: "card_update", cardRole: "answer" })
    ]);
    expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ pageIndex: 0, state: "active" })]);
    store.close();
  });

  it("continues exactly from a delivered recovery chunk source end", async () => {
    const store = readyStore();
    const answer = "x".repeat(12_000);
    const completed = store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer, answerSegments: [answer], viewVersion: 2 });
    const content = answerStreamContent(completed);
    const sourceEnd = 4_000;
    store.enqueueOutboundReply({
      id: "recovery-content", idempotencyKey: "startup-lite-content:failed-content", bindingId: "b1", promptId: "p1", viewVersion: 1, cardRole: "answer",
      rootMessageId: "card-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: store.getActiveAnswerPage("p1")!.elementId, content: content.slice(0, sourceEnd), sequence: 1, sourceEnd })
    });
    store.markOutboundReplyDelivered("recovery-content", "card-1");

    await new AnswerPageWorkflow(store, vi.fn(), primaryPresentation).converge("p1");

    expect(store.listPendingOutboundReplies()).toEqual([
      expect.objectContaining({ kind: "stream_finish" }),
      expect.objectContaining({ kind: "card_update", rootMessageId: "answer-1" }),
      expect.objectContaining({ kind: "stream_card_create", payload: expect.stringContaining(`\"pageStart\":${sourceEnd}`) })
    ]);
    expect(store.listAnswerPages("p1")).toEqual([
      expect.objectContaining({ pageIndex: 0, sourceStart: 0, state: "active" }),
      expect.objectContaining({ pageIndex: 1, sourceStart: sourceEnd, state: "creating" })
    ]);
    store.close();
  });

  it("updates a short frozen Answer Card to green exactly once after stream finish", async () => {
    const store = readyStore();
    const content = "⏳ 已接收请求\n\ndone";
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "done", answerSegments: ["done"], viewVersion: 2 });
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: page.elementId, content })).toBe("reserved");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);

    await workflow.converge("p1");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    await workflow.converge("p1");

    const [update] = store.listPendingOutboundReplies();
    expect(update).toMatchObject({ kind: "card_update", cardRole: "answer", rootMessageId: "answer-1" });
    expect(update?.payload).toContain('\"template\":\"green\"');
    await workflow.converge("p1");
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    store.close();
  });

  it("keeps the continuation element id when rebuilding a completed closed stream as a streaming card", async () => {
    const store = readyStore();
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "final answer", answerSegments: ["final answer"], viewVersion: 2 });
    const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
    await workflow.converge("p1");
    const failed = store.listPendingOutboundReplies()[0]!;
    failRingDelivery(store, failed.id, "closed", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "300309", recoveryKind: "closed_answer_stream" });

    await workflow.converge("p1");

    const [replacement] = store.listPendingOutboundReplies();
    const payload = JSON.parse(replacement!.payload) as { card: { body: { elements: Array<Record<string, unknown>> } }; stream: { elementId: string } };
    const expectedElementId = answerElementId("p1", 1);
    expect(replacement).toMatchObject({ kind: "stream_card_create", cardRole: "answer", rootMessageId: "root-1" });
    expect(payload.stream.elementId).toBe(expectedElementId);
    expect(payload.stream).toMatchObject({ deliveryMode: "static" });
    expect(payload.card.body.elements).toEqual(expect.arrayContaining([expect.objectContaining({ tag: "markdown", element_id: expectedElementId })]));

    store.markOutboundReplyFailedWithQuarantine(replacement!.id, "invalid legacy payload", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "invalid_card" });
    await workflow.converge("p1");

    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.getOutboundReply(replacement!.id)).toMatchObject({ state: "dead_letter", attemptCount: 1, error: "invalid legacy payload" });
    expect(store.getOperationalSummary().outboxQuarantines.active).toBe(1);
    store.close();
  });

  it("rebuilds a Primary Answer after Feishu confirms its stream target is defunct", async () => {
    const store = readyStore();
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "durable final answer", answerSegments: ["durable final answer"], viewVersion: 2 });
    const durableContent = primaryPresentation.answerStreamContent(store.loadRunCard("p1")!);
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({
      promptId: "p1",
      pageIndex: 0,
      cardId: "card-1",
      elementId: page.elementId,
      content: durableContent,
      source: durableContent
    })).toBe("reserved");
    const failed = store.listPendingOutboundReplies()[0]!;

    expect(failRingDelivery(store, failed.id, "target withdrawn", {
      failureClass: "permanent",
      effectCertainty: "rejected",
      httpStatus: 400,
      larkErrorCode: "230011",
      recoveryKind: "defunct_target"
    })).toMatchObject({ action: "rebuild_answer" });
    expect(store.listRecoverablePrimaryAnswerPromptIds(100)).toEqual(["p1"]);

    const wake = vi.fn();
    const workflow = new AnswerPageWorkflow(store, wake, primaryPresentation);
    await workflow.converge("p1");
    await workflow.converge("p1");

    const [replacement] = store.listPendingOutboundReplies();
    expect(replacement).toMatchObject({
      kind: "stream_card_create",
      cardRole: "answer",
      promptId: "p1",
      rootMessageId: "root-1"
    });
    expect(replacement?.payload).toContain("durable final answer");
    expect(store.listAnswerPages("p1")).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "frozen" }),
      expect.objectContaining({ pageIndex: 1, state: "creating" })
    ]);
    expect(wake).toHaveBeenCalledOnce();
    settleRingDelivery(store, replacement!.id, "answer-2", "card-2");
    expect(store.getActiveAnswerPage("p1")).toMatchObject({ pageIndex: 1, messageId: "answer-2", cardId: "card-2" });
    await workflow.converge("p1");
    const [catchUp] = store.listPendingOutboundReplies();
    expect(catchUp).toMatchObject({ kind: "card_update", rootMessageId: "answer-2" });
    settleRingDelivery(store, catchUp!.id, "answer-2");
    expect(store.database.prepare("SELECT state, action, resolved_by_reply_id FROM delivery_recoveries WHERE failed_reply_id = ?").get(failed.id)).toEqual({
      state: "recovered",
      action: "rebuild_answer",
      resolved_by_reply_id: catchUp!.id
    });
    expect(store.listRecoverablePrimaryAnswerPromptIds(100)).toEqual([]);
    store.close();
  });

  it("creates one configured-group recovery conversation when the rebuilt Primary Answer root is defunct", async () => {
    const store = readyStore();
    store.updateBinding("b1", {
      state: "active",
      lifecycle: "active",
      attachment: "attached",
      paneId: "w1:p1",
      statusMessageId: "primary-root"
    });
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "durable final answer", answerSegments: ["durable final answer"], viewVersion: 2 });
    const durableContent = primaryPresentation.answerStreamContent(store.loadRunCard("p1")!);
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({
      promptId: "p1",
      pageIndex: 0,
      cardId: "card-1",
      elementId: page.elementId,
      content: durableContent,
      source: durableContent
    })).toBe("reserved");
    const failedContent = store.listPendingOutboundReplies()[0]!;
    expect(failRingDelivery(store, failedContent.id, "target withdrawn", {
      failureClass: "permanent",
      effectCertainty: "rejected",
      httpStatus: 400,
      larkErrorCode: "230011",
      recoveryKind: "defunct_target"
    })).toMatchObject({ action: "rebuild_answer" });
    expect(store.getOperationalSummary().projectionDeliveryRecovery).toMatchObject({
      backlog: 1,
      eligible: 1,
      awaitingAck: 0,
      byProjection: { primaryAnswer: 1, workerTask: 0 },
      oldestEligibleAt: expect.any(String),
      oldestEligibleAgeSeconds: expect.any(Number)
    });

    const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
    await workflow.converge("p1");
    const rebuilt = store.listPendingOutboundReplies().find(({ kind }) => kind === "stream_card_create")!;
    expect(failRingDelivery(store, rebuilt.id, "reply root deleted", {
      failureClass: "permanent",
      effectCertainty: "rejected",
      httpStatus: 400,
      larkErrorCode: "230019",
      recoveryKind: "defunct_target"
    })).toMatchObject({ state: "dead_letter", action: "create_recovery_conversation" });

    const recovery = store.listPendingOutboundReplies().find(({ kind }) => kind === "group_card_create")!;
    expect(recovery).toMatchObject({
      idempotencyKey: "projection-recovery-thread:primary-answer:p1:1",
      targetChatId: "c1",
      promptId: "p1",
      streamPageIndex: 1,
      threadAliasId: expect.any(String)
    });
    expect(store.getOperationalSummary().projectionDeliveryRecovery).toMatchObject({ backlog: 2, eligible: 0, awaitingAck: 2, exhausted: 0 });
    await workflow.converge("p1");
    expect(store.listPendingOutboundReplies().filter(({ kind }) => kind === "group_card_create")).toHaveLength(1);
    expect(settleRingDelivery(store, recovery.id, "recovery-root", undefined, "recovery-topic")).toBe(true);
    expect(store.findBindingByLarkScope("recovery-topic", "recovery-root")).toMatchObject({ id: "b1", chatId: "c1" });
    expect(store.getActiveAnswerPage("p1")).toMatchObject({
      pageIndex: 1,
      state: "active",
      messageId: "recovery-root",
      cardId: null,
      deliveryMode: "static"
    });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM delivery_recoveries WHERE replacement_reply_id = ? AND state = 'recovered'").get(recovery.id)).toEqual({ count: 2 });
    expect(store.getOperationalSummary().projectionDeliveryRecovery).toMatchObject({ backlog: 0, eligible: 0, awaitingAck: 0, recovered: 2, exhausted: 0 });
    expect(store.markOutboundReplyDelivered(rebuilt.id, "late-old-root", "late-old-card")).toBe(false);
    expect(store.getActiveAnswerPage("p1")).toMatchObject({ pageIndex: 1, messageId: "recovery-root" });

    await workflow.converge("p1");
    const [hydration] = store.listPendingOutboundReplies();
    expect(hydration).toMatchObject({
      kind: "card_update",
      cardRole: "answer",
      rootMessageId: "recovery-root",
      idempotencyKey: "answer-static:p1:1:recovery-root"
    });
    expect(hydration?.payload).toContain("durable final answer");
    expect(settleRingDelivery(store, hydration!.id, "recovery-root")).toBe(true);
    store.saveRunCard({
      ...store.loadRunCard("p1")!,
      answer: "durable final answer plus later output",
      answerSegments: ["durable final answer plus later output"],
      viewVersion: 3
    });
    await workflow.converge("p1");
    const [snapshot] = store.listPendingOutboundReplies();
    expect(snapshot).toMatchObject({
      kind: "card_update",
      cardRole: "answer",
      rootMessageId: "recovery-root",
      idempotencyKey: "answer-static:p1:1:recovery-root:revision:2"
    });
    expect(snapshot?.payload).toContain("later output");
    store.close();
  });

  it("refuses a top-level Primary Answer recovery conversation when current binding ownership is unproven", async () => {
    const store = readyStore();
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "durable final answer", answerSegments: ["durable final answer"], viewVersion: 2 });
    const durableContent = primaryPresentation.answerStreamContent(store.loadRunCard("p1")!);
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({
      promptId: "p1",
      pageIndex: 0,
      cardId: "card-1",
      elementId: page.elementId,
      content: durableContent,
      source: durableContent
    })).toBe("reserved");
    const failedContent = store.listPendingOutboundReplies()[0]!;
    failRingDelivery(store, failedContent.id, "target withdrawn", {
      failureClass: "permanent",
      effectCertainty: "rejected",
      httpStatus: 400,
      larkErrorCode: "230011",
      recoveryKind: "defunct_target"
    });
    await new AnswerPageWorkflow(store, vi.fn(), primaryPresentation).converge("p1");
    const rebuilt = store.listPendingOutboundReplies().find(({ kind }) => kind === "stream_card_create")!;

    expect(failRingDelivery(store, rebuilt.id, "reply root deleted", {
      failureClass: "permanent",
      effectCertainty: "rejected",
      httpStatus: 400,
      larkErrorCode: "230019",
      recoveryKind: "defunct_target"
    })).toMatchObject({ state: "dead_letter", action: "refuse_recovery_conversation" });
    expect(store.listPendingOutboundReplies().filter(({ kind }) => kind === "group_card_create")).toEqual([]);
    expect(store.database.prepare("SELECT state, action, replacement_reply_id FROM delivery_recoveries WHERE failed_reply_id = ?").get(failedContent.id)).toEqual({
      state: "unresolved",
      action: "refuse_recovery_conversation",
      replacement_reply_id: null
    });
    expect(store.getOperationalSummary().projectionDeliveryRecovery).toMatchObject({ backlog: 2, eligible: 0, awaitingAck: 0, exhausted: 2 });
    store.close();
  });

  it("retries an uncertain Primary Answer stream three times before rebuilding from durable content", async () => {
    const store = readyStore();
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "durable answer", answerSegments: ["durable answer"], viewVersion: 2 });
    const durableContent = primaryPresentation.answerStreamContent(store.loadRunCard("p1")!);
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({
      promptId: "p1",
      pageIndex: 0,
      cardId: "card-1",
      elementId: page.elementId,
      content: durableContent,
      source: durableContent
    })).toBe("reserved");
    const failed = store.listPendingOutboundReplies()[0]!;
    const uncertain = { failureClass: "unknown" as const, effectCertainty: "uncertain" as const, httpStatus: null, larkErrorCode: null };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      expect(failRingDelivery(store, failed.id, "connection reset", uncertain)).toMatchObject({
        state: "pending",
        action: "retry",
        reply: { attemptCount: attempt, effectCertainty: "uncertain" }
      });
      expect(store.listRecoverablePrimaryAnswerPromptIds(100)).toEqual([]);
    }

    expect(failRingDelivery(store, failed.id, "connection reset", uncertain)).toMatchObject({
      state: "dead_letter",
      action: "rebuild_answer",
      reply: { attemptCount: 3, effectCertainty: "uncertain" }
    });
    expect(store.listRecoverablePrimaryAnswerPromptIds(100)).toEqual(["p1"]);

    const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
    await workflow.converge("p1");
    const [replacement] = store.listPendingOutboundReplies();
    expect(replacement).toMatchObject({ kind: "stream_card_create", cardRole: "answer", promptId: "p1", rootMessageId: "root-1" });
    expect(replacement?.payload).toContain("durable answer");
    store.saveRunCard({ ...store.loadRunCard("p1")!, answer: "durable answer plus later output", answerSegments: ["durable answer plus later output"], viewVersion: 3 });
    settleRingDelivery(store, replacement!.id, "answer-2", "card-2");
    await workflow.converge("p1");
    const [catchUp] = store.listPendingOutboundReplies();
    expect(catchUp).toMatchObject({ kind: "card_update", rootMessageId: "answer-2" });
    expect(catchUp?.payload).toContain("later output");
    settleRingDelivery(store, catchUp!.id, "answer-2");
    expect(store.database.prepare("SELECT state, action FROM delivery_recoveries WHERE failed_reply_id = ?").get(failed.id)).toEqual({
      state: "recovered",
      action: "rebuild_answer"
    });
    store.close();
  });

  it("falls back to the latest durable Primary Answer snapshot when no delivery coverage exists", async () => {
    const store = readyStore();
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "final snapshot", answerSegments: ["final snapshot"], viewVersion: 2 });
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({
      promptId: "p1",
      pageIndex: 0,
      cardId: "card-1",
      elementId: page.elementId,
      content: "uncheckpointed content"
    })).toBe("reserved");
    const failed = store.listPendingOutboundReplies()[0]!;
    const uncertain = { failureClass: "unknown" as const, effectCertainty: "uncertain" as const, httpStatus: null, larkErrorCode: null };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      failRingDelivery(store, failed.id, "timeout", uncertain);
    }

    await new AnswerPageWorkflow(store, vi.fn(), primaryPresentation).converge("p1");

    const [replacement] = store.listPendingOutboundReplies();
    expect(replacement).toMatchObject({ kind: "stream_card_create", promptId: "p1" });
    expect(replacement?.payload).toContain("final snapshot");
    expect(store.database.prepare("SELECT source_start, source_end FROM answer_recovery_links WHERE failed_reply_id = ?").get(failed.id)).toEqual({
      source_start: 0,
      source_end: primaryPresentation.answerStreamContent(store.loadRunCard("p1")!).length
    });
    store.close();
  });

  it("upgrades a finished terminal page with folded code exactly once", async () => {
    const store = readyStore();
    const code = Array.from({ length: 81 }, (_, index) => `output line ${index}`).join("\n");
    const answer = `\`\`\`text\n${code}\n\`\`\``;
    const content = `⏳ 已接收请求\n\n${answer}`;
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer, answerSegments: [answer], viewVersion: 2 });
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: page.elementId, content })).toBe("reserved");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);

    await workflow.converge("p1");
    const [finish] = store.listPendingOutboundReplies();
    expect(finish).toMatchObject({ kind: "stream_finish" });
    store.markOutboundReplyDelivered(finish!.id, "card-1");

    await workflow.converge("p1");
    const [upgrade] = store.listPendingOutboundReplies();
    expect(upgrade).toMatchObject({ kind: "card_update", cardRole: "answer", rootMessageId: "answer-1", cardSequence: 3 });
    expect(upgrade?.payload).toContain("执行输出");
    expect(upgrade?.payload).toContain("81 行");
    store.markOutboundReplyDelivered(upgrade!.id, "answer-1");
    await workflow.converge("p1");
    expect(store.listPendingOutboundReplies()).toHaveLength(0);
    expect(store.listAnswerPages("p1")[0]).toMatchObject({ state: "finished", sequence: 3 });
    store.close();
  });

  it("preserves the last delivered continuation when the completed answer shrinks below its page start", async () => {
    const store = readyStore();
    const visibleContinuation = "the last visible continuation";
    const elementId = "answer_content_p1_1";
    store.database.exec("UPDATE answer_pages SET state = 'frozen' WHERE prompt_id = 'p1' AND page_index = 0");
    store.database.prepare("INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES ('p1', 1, 'answer-2', 'card-2', ?, 9351, 10, 'finished', 'streaming', 'now', 'now')").run(elementId);
    store.database.prepare("UPDATE run_cards SET answer_message_id = 'answer-2', answer_card_id = 'card-2', answer_element_id = ?, answer_page_index = 1, answer_page_start = 9351 WHERE prompt_id = 'p1'").run(elementId);
    store.enqueueOutboundReply({
      id: "visible-continuation", idempotencyKey: "visible-continuation", bindingId: "b1", promptId: "p1", viewVersion: 9, cardRole: "answer",
      rootMessageId: "card-2", kind: "stream_content", payload: JSON.stringify({ pageIndex: 1, elementId, content: visibleContinuation, sequence: 9 })
    });
    store.markOutboundReplyDelivered("visible-continuation", "card-2");
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "short final answer", answerSegments: ["short final answer"], viewVersion: 3 });
    const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);

    await workflow.converge("p1");

    const finalUpdate = store.listPendingOutboundReplies().find((reply) => reply.kind === "card_update")!;
    expect(finalUpdate).toMatchObject({ rootMessageId: "answer-2", cardRole: "answer" });
    expect(finalUpdate.payload).toContain(visibleContinuation);
    expect(finalUpdate.payload).not.toContain('"elements":[]');
    store.close();
  });

  it("appends changed final content while preserving the rejected revision", async () => {
    const store = readyStore();
    const code = Array.from({ length: 81 }, (_, index) => `output line ${index}`).join("\n");
    const answer = `\`\`\`text\n${code}\n\`\`\``;
    const content = `⏳ 已接收请求\n\n${answer}`;
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer, answerSegments: [answer], viewVersion: 2 });
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: page.elementId, content })).toBe("reserved");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
    await workflow.converge("p1");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    await workflow.converge("p1");
    const original = store.listPendingOutboundReplies()[0]!;
    failRingDelivery(store, original.id, "invalid card", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "bad_card" });
    const latestAnswer = `${answer}\n\nlatest terminal state`;
    store.saveRunCard({ ...store.loadRunCard("p1")!, answer: latestAnswer, answerSegments: [answer, "latest terminal state"], viewVersion: 3 });

    await workflow.converge("p1");

    const [reopened] = store.listPendingOutboundReplies();
    expect(reopened).toMatchObject({
      state: "pending", attemptCount: 0, error: null, failureClass: null, httpStatus: null, larkErrorCode: null, deadLetteredAt: null, autoRecoveryCount: 0, viewVersion: 3
    });
    expect(reopened!.payload).not.toBe(original.payload);
    expect(reopened!.payload).toContain("latest terminal state");
    expect(reopened!.id).not.toBe(original.id);
    expect(store.getOutboundReply(original.id)).toMatchObject({ state: "dead_letter", larkErrorCode: "bad_card" });
    expect(store.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 10, at: "2098-01-01T00:00:00.000Z" }).items).toEqual([expect.objectContaining({ replyId: original.id, status: "dead_letter" })]);
    const hydrated = store.preparedDeliveries.hydratePreparedDelivery(reopened!.id);
    if (hydrated.status !== "prepared") throw new Error(`Expected prepared replacement, got ${hydrated.status}`);
    expect(store.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2098-01-01T00:00:00.000Z" }).transitionedScopeKeys).toEqual(['["pane","w1","w1:p1"]']);
    expect(store.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 10, at: "2098-01-01T00:00:00.000Z" }).items).toEqual([expect.objectContaining({ replyId: reopened!.id, status: "ready" })]);
    expect(store.getAnswerPageDeliveryFacts("p1", 0).finalUpdateState).toBe("pending");
    settleRingDelivery(store, reopened!.id, "answer-1");
    expect(store.getAnswerPageDeliveryFacts("p1", 0).finalUpdateState).toBe("delivered");
    await workflow.converge("p1");
    const [finalRevision] = store.listPendingOutboundReplies();
    expect(finalRevision).toMatchObject({ kind: "card_update", rootMessageId: "answer-1", viewVersion: 3 });
    settleRingDelivery(store, finalRevision!.id, "answer-1");
    await workflow.converge("p1");
    expect(store.listPendingOutboundReplies()).toEqual([]);
    store.close();
  });

  it("does not reopen unchanged dismissed final content", async () => {
    const store = readyStore();
    const answer = `\`\`\`text\n${Array.from({ length: 81 }, (_, index) => `output line ${index}`).join("\n")}\n\`\`\``;
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer, answerSegments: [answer], viewVersion: 2 });
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: page.elementId, content: `⏳ 已接收请求\n\n${answer}` })).toBe("reserved");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
    await workflow.converge("p1");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    await workflow.converge("p1");
    const original = store.listPendingOutboundReplies()[0]!;
    store.database.prepare("UPDATE outbound_replies SET state = 'dismissed', error = 'superseded', attempt_count = 3 WHERE id = ?").run(original.id);

    await workflow.converge("p1");

    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.getOutboundReply(original.id)).toMatchObject({ state: "dismissed", attemptCount: 3, error: "superseded" });
    store.close();
  });
});
