import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { DeliveryRecoveryWorkflow } from "../src/coordinator/delivery-recovery-workflow.js";
import { OperationsQueryWorkflow } from "../src/coordinator/operations-query-workflow.js";
import type { Binding, IncomingLarkCardAction, IncomingLarkMessage } from "../src/domain/types.js";
import type { TopicViewState } from "../src/domain/topic-view.js";

const message: IncomingLarkMessage = { eventId: "event-1", messageId: "message-1", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "user", text: "/swarm panes", mentionsBot: true, isRootMessage: false };
const action: IncomingLarkCardAction = { messageId: "directory-card", chatId: "chat", operatorOpenId: "user", value: {} };

describe("topic pane directory workflow", () => {
  it("lists only current-chat attached active panes carrying a main-card identity", async () => {
    const selected = activeBinding("selected");
    const presentation = { topicPanes: vi.fn(() => ({ card: "directory" })), spaces: vi.fn(), sessions: vi.fn(), failures: vi.fn() };
    const outbound = { enqueueCard: vi.fn(async () => {}) };
    const workflow = new OperationsQueryWorkflow({
      config: { projects: [] }, herdr: { listPanes: vi.fn() }, outbound, presentation, logger: pino({ enabled: false }),
      store: { listBindings: () => [selected, { ...activeBinding("other-chat"), chatId: "other" }, { ...activeBinding("detached"), attachment: "orphaned" }, { ...activeBinding("missing-card"), statusMessageId: null }], loadTopicView: (id) => id === "selected" ? topic("selected") : null, listFailures: () => [], listSessions: () => [] }
    });

    await workflow.listTopicPanes(message);

    expect(presentation.topicPanes).toHaveBeenCalledWith([expect.objectContaining({ bindingId: "selected", bindingGeneration: 3, paneId: "work:p1", sourceMainMessageId: "om-main" })]);
    expect(outbound.enqueueCard).toHaveBeenCalledWith("root", "panes:message-1:0", { card: "directory" });
  });

  it("revalidates the callback identity and enqueues the main card through the durable outbox", async () => {
    const binding = activeBinding("selected");
    const outbound = { enqueueCard: vi.fn(async () => {}), enqueueCardUpdate: vi.fn(async () => {}) };
    const audit = vi.fn();
    const workflow = new DeliveryRecoveryWorkflow({
      store: { getBinding: () => binding, loadTopicView: () => topic("selected"), audit, dismissDeadLetter: vi.fn(), listFailures: vi.fn(() => []), retryDeadLetter: vi.fn() },
      lark: { replyText: vi.fn(), shareThread: vi.fn() }, outbound, outboundWork: { wake: vi.fn(), subscribe: vi.fn(() => () => {}) },
      presentation: { mainCard: vi.fn(() => ({ card: "main" })), failures: vi.fn(() => []) }, logger: pino({ enabled: false })
    });

    await expect(workflow.sendPaneCard(action, { bindingId: "selected", bindingGeneration: 3, paneId: "work:p1", sourceMainMessageId: "om-main" })).resolves.toBe("sent");
    expect(outbound.enqueueCard).toHaveBeenCalledWith("directory-card", "pane-card-send:directory-card:selected:3:om-main", { card: "main" }, "selected");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "pane.card.send", outcome: "accepted" }));

    await expect(workflow.sendPaneCard(action, { bindingId: "selected", bindingGeneration: 2, paneId: "work:p1", sourceMainMessageId: "om-main" })).resolves.toBe("stale");
    expect(outbound.enqueueCard).toHaveBeenCalledTimes(1);
  });
});

function activeBinding(id: string): Binding {
  return { id, projectId: "project", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task", paneId: "work:p1", statusMessageId: "om-main", generation: 3, state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working" } as Binding;
}

function topic(bindingId: string): TopicViewState {
  return { bindingId, title: "Task", workspaceId: "workspace", spaceName: "Core" } as TopicViewState;
}
