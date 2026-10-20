import { describe, expect, it, vi } from "vitest";
import { PrimaryCardRedeliveryWorkflow } from "../src/coordinator/primary-card-redelivery.js";
import type { PrimaryCardRedeliverySnapshot } from "../src/domain/ports/primary-card-redelivery.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";

describe("PrimaryCardRedeliveryWorkflow", () => {
  it("renders the fenced Main and selected active Answer page before one atomic reservation", () => {
    const snapshot = primarySnapshot();
    const reserve = vi.fn(() => ({ outcome: "scheduled" as const, mainScheduled: true as const, answerScheduled: true }));
    const loadSnapshot = vi.fn(() => snapshot);
    const wake = vi.fn();
    const presentation = presentationFixture();
    const workflow = new PrimaryCardRedeliveryWorkflow({
      store: { loadSnapshot, reserve }, mainCards: { getProjectionGapSummary: vi.fn(() => gapSummary()) },
      answerPages: answerPageFacts(), presentation, wakeOutbound: wake, answerPageLimit: 9_000
    });

    expect(workflow.redeliver({ commandIntentId: "intent-1", bindingId: "b1", expectedBindingGeneration: 1 }))
      .toEqual({ outcome: "scheduled", mainScheduled: true, answerScheduled: true });
    const selectedView = {
      ...snapshot.answer!.run,
      answerMessageId: "answer-1", answerCardId: "card-1", answerElementId: "element-1",
      answerPageIndex: 1, answerPageStart: 9_000
    };
    expect(presentation.mainCard).toHaveBeenCalledWith(snapshot.topic, { gapWarning: "⚠ 有 1 条更新未能实时展示，当前内容已同步到最新状态。" });
    expect(presentation.answerStreamContent).toHaveBeenCalledWith(selectedView);
    expect(presentation.answerStreamPage).toHaveBeenCalledWith("complete answer", 9_000, 9_000);
    expect(presentation.answerCard).toHaveBeenCalledWith(selectedView, {
      pageNumber: 2, initialContent: "page two", streaming: true,
      gapWarning: "⚠ 有 1 条更新未能实时展示，当前内容已同步到最新状态。"
    });
    expect(reserve).toHaveBeenCalledWith({
      commandIntentId: "intent-1", snapshot,
      mainCard: { card: "main" }, answerCard: { card: "answer" }
    });
    expect(wake).toHaveBeenCalledOnce();
  });

  it("schedules Main only without invoking Answer rendering when no page is eligible", () => {
    const snapshot = { ...primarySnapshot(), answer: null } satisfies PrimaryCardRedeliverySnapshot;
    const reserve = vi.fn(() => ({ outcome: "scheduled" as const, mainScheduled: true as const, answerScheduled: false }));
    const presentation = presentationFixture();
    const workflow = new PrimaryCardRedeliveryWorkflow({
      store: { loadSnapshot: vi.fn(() => snapshot), reserve }, mainCards: {}, answerPages: {},
      presentation, wakeOutbound: vi.fn(), answerPageLimit: 9_000
    });

    expect(workflow.redeliver({ commandIntentId: "intent-1", bindingId: "b1", expectedBindingGeneration: 1 }))
      .toEqual({ outcome: "scheduled", mainScheduled: true, answerScheduled: false });
    expect(presentation.answerCard).not.toHaveBeenCalled();
    expect(presentation.finalAnswer).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ answerCard: null }));
  });

  it("renders a finished page as a bounded final Answer snapshot", () => {
    const base = primarySnapshot();
    const snapshot: PrimaryCardRedeliverySnapshot = {
      ...base,
      answer: {
        ...base.answer!,
        run: { ...base.answer!.run, phase: "completed" },
        page: { ...base.answer!.page, state: "finished" },
        nextPageStart: 18_000
      }
    };
    const reserve = vi.fn(() => ({ outcome: "scheduled" as const, mainScheduled: true as const, answerScheduled: true }));
    const presentation = presentationFixture();
    const workflow = new PrimaryCardRedeliveryWorkflow({
      store: { loadSnapshot: vi.fn(() => snapshot), reserve }, mainCards: {}, answerPages: {},
      presentation, wakeOutbound: vi.fn(), answerPageLimit: 9_000
    });

    workflow.redeliver({ commandIntentId: "intent-final", bindingId: "b1", expectedBindingGeneration: 1 });

    expect(presentation.finalAnswerPage).toHaveBeenCalledWith("complete answer", 9_000, 18_000);
    expect(presentation.finalAnswer).toHaveBeenCalledWith(expect.objectContaining({
      answerElementId: "element-1", answerPageIndex: 1, phase: "completed"
    }), { pageNumber: 2, initialContent: "final page", gapWarning: null, completionActions: null });
    expect(presentation.answerCard).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ answerCard: { card: "final-answer" } }));
  });

  it.each([
    ["fixed", { id: "actions-fixed", state: "available" as const, mentionOpenId: "ou_actor", ownerKind: "primary-prompt" as const, ownerId: "p1", ownerGeneration: 1, cardMessageId: "answer-1" }],
    ["dynamic", { id: "actions-dynamic", state: "available" as const, mentionOpenId: "ou_actor", ownerKind: "primary-prompt" as const, ownerId: "p1", ownerGeneration: 1, cardMessageId: "answer-1", choiceSpecification: { version: 1 as const, defaultOptionId: "one", options: [{ id: "one", label: "方案一", message: "default" }, { id: "two", label: "方案二", message: "2" }] } }]
  ])("preserves still-valid %s completion actions in final Answer redelivery", (_kind, completionActions) => {
    const base = primarySnapshot();
    const snapshot: PrimaryCardRedeliverySnapshot = {
      ...base,
      answer: {
        ...base.answer!, completionActions,
        run: { ...base.answer!.run, phase: "completed" },
        page: { ...base.answer!.page, state: "finished" }
      }
    };
    const presentation = presentationFixture();
    const workflow = new PrimaryCardRedeliveryWorkflow({
      store: { loadSnapshot: vi.fn(() => snapshot), reserve: vi.fn(() => ({ outcome: "scheduled", mainScheduled: true, answerScheduled: true })) },
      mainCards: {}, answerPages: {}, presentation, wakeOutbound: vi.fn(), answerPageLimit: 9_000
    });

    workflow.redeliver({ commandIntentId: `intent-${_kind}`, bindingId: "b1", expectedBindingGeneration: 1 });

    expect(presentation.finalAnswer).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ completionActions }));
  });

  it("retries one stale render race with a fresh snapshot", () => {
    const first = primarySnapshot();
    const second = { ...first, topic: { ...first.topic, title: "New", viewVersion: 5 } };
    const loadSnapshot = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const reserve = vi.fn()
      .mockReturnValueOnce({ outcome: "stale", reason: "projection_changed" })
      .mockReturnValueOnce({ outcome: "scheduled", mainScheduled: true, answerScheduled: true });
    const presentation = presentationFixture();
    const workflow = new PrimaryCardRedeliveryWorkflow({
      store: { loadSnapshot, reserve }, mainCards: {}, answerPages: answerPageFacts(),
      presentation, wakeOutbound: vi.fn(), answerPageLimit: 9_000
    });

    expect(workflow.redeliver({ commandIntentId: "intent-1", bindingId: "b1", expectedBindingGeneration: 1 }))
      .toMatchObject({ outcome: "scheduled" });
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(presentation.mainCard).toHaveBeenLastCalledWith(second.topic, { gapWarning: null });
  });

  it("does not wake delivery for duplicate or unavailable operations", () => {
    const snapshot = primarySnapshot();
    const wake = vi.fn();
    const store = {
      loadSnapshot: vi.fn()
        .mockReturnValueOnce(snapshot)
        .mockReturnValueOnce({ outcome: "unavailable", reason: "stale_binding" }),
      reserve: vi.fn(() => ({ outcome: "duplicate" as const, mainScheduled: true as const, answerScheduled: true }))
    };
    const workflow = new PrimaryCardRedeliveryWorkflow({
      store, mainCards: {}, answerPages: answerPageFacts(), presentation: presentationFixture(),
      wakeOutbound: wake, answerPageLimit: 9_000
    });

    expect(workflow.redeliver({ commandIntentId: "intent-1", bindingId: "b1", expectedBindingGeneration: 1 }))
      .toMatchObject({ outcome: "duplicate" });
    expect(workflow.redeliver({ commandIntentId: "intent-2", bindingId: "b1", expectedBindingGeneration: 1 }))
      .toEqual({ outcome: "unavailable", reason: "stale_binding" });
    expect(wake).not.toHaveBeenCalled();
  });
});

function primarySnapshot(): PrimaryCardRedeliverySnapshot {
  const run = {
    ...createQueuedRunCard({
      promptId: "p1", bindingId: "b1", bindingGeneration: 1, title: "Task", workspaceId: "w1",
      paneId: "w1:p1", requestText: "work", queuePosition: 0, occurredAt: "2026-10-01T00:00:00.000Z"
    }),
    phase: "running" as const, answer: "complete answer", answerPageIndex: 1, answerPageStart: 9_000,
    viewVersion: 3
  };
  return {
    outcome: "available",
    topic: { ...initialTopicView("b1"), bindingGeneration: 1, title: "Task", viewVersion: 4 },
    answer: {
      run,
      page: {
        promptId: "p1", pageIndex: 1, messageId: "answer-1", cardId: "card-1", elementId: "element-1",
        sourceStart: 9_000, sequence: 2, state: "active", deliveryMode: "streaming",
        createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z"
      },
      nextPageStart: null,
      completionActions: null
    }
  };
}

function presentationFixture() {
  return {
    mainCard: vi.fn(() => ({ card: "main" })),
    answerCard: vi.fn(() => ({ card: "answer" })),
    finalAnswer: vi.fn(() => ({ card: "final-answer" })),
    answerStreamContent: vi.fn(() => "complete answer"),
    answerStreamPage: vi.fn(() => ({ page: "page two", nextPageStart: null })),
    finalAnswerPage: vi.fn(() => ({ page: "final page", nextPageStart: null })),
    answerTimelinePage: vi.fn(() => ({ items: [], nextCursor: null }))
  };
}

function answerPageFacts() {
  return {
    getProjectionGapSummary: vi.fn(() => gapSummary()),
    getAnswerTimelinePage: vi.fn(),
    listFrozenAnswerTimelineItems: vi.fn(() => [])
  };
}

function gapSummary() {
  return { openProjection: 0, openDelivery: 1, compensated: 0, oldestOpenAt: "2026-10-01T00:00:00.000Z" };
}
