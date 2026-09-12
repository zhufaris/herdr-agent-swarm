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

  it("limits a bound thread to its current project Space while preserving an unbound chat directory", async () => {
    const scoped = activeBinding("scoped");
    const sameSpace = { ...activeBinding("same-space"), projectId: "same-space-project", paneId: "work:p2", statusMessageId: "om-same" };
    const otherProject = { ...activeBinding("other-project"), projectId: "other-project", paneId: "work:p3", statusMessageId: "om-other" };
    const presentation = { topicPanes: vi.fn(() => ({ card: "directory" })), spaces: vi.fn(), sessions: vi.fn(), failures: vi.fn() };
    const outbound = { enqueueCard: vi.fn(async () => {}) };
    const workflow = new OperationsQueryWorkflow({
      config: { projects: [{ id: "project", displayName: "Project", spaceName: "core", description: "", workspaceId: "workspace", cwd: "/project" }, { id: "same-space-project", displayName: "Same Space", spaceName: "core", description: "", workspaceId: "workspace", cwd: "/same" }, { id: "other-project", displayName: "Other", spaceName: "other", description: "", workspaceId: "workspace", cwd: "/other" }] }, herdr: { listPanes: vi.fn() }, outbound, presentation, logger: pino({ enabled: false }),
      store: { listBindings: () => [scoped, sameSpace, otherProject], loadTopicView: (id) => topic(id), listFailures: () => [], listSessions: () => [] }
    });

    await workflow.listTopicPanes(message, scoped);
    expect(presentation.topicPanes).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ bindingId: "scoped" }), expect.objectContaining({ bindingId: "same-space" })]));
    expect(presentation.topicPanes).toHaveBeenLastCalledWith(expect.not.arrayContaining([expect.objectContaining({ bindingId: "other-project" })]));

    await workflow.listTopicPanes({ ...message, messageId: "unbound", topicId: null, rootMessageId: "unbound" });
    expect(presentation.topicPanes).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ bindingId: "scoped" }), expect.objectContaining({ bindingId: "same-space" }), expect.objectContaining({ bindingId: "other-project" })]));
  });

  it("revalidates the callback identity and reserves a group-root card through the durable outbox", async () => {
    const binding = activeBinding("selected");
    const reservePaneThreadAlias = vi.fn(() => "reserved" as const);
    const audit = vi.fn();
    const workflow = new DeliveryRecoveryWorkflow({
      store: { getBinding: () => binding, loadTopicView: () => topic("selected"), reservePaneThreadAlias, audit, dismissDeadLetter: vi.fn(), listFailures: vi.fn(() => []), retryDeadLetter: vi.fn() },
      gatewayEffects: { createConversation: vi.fn(), replyText: vi.fn(), shareConversation: vi.fn() }, outbound: { enqueueCardUpdate: vi.fn(async () => {}) }, outboundWork: { wake: vi.fn(), subscribe: vi.fn(() => () => {}) },
      presentation: { paneEntryCard: vi.fn(() => ({ card: "main-entry" })), failures: vi.fn(() => []) }, logger: pino({ enabled: false })
    });

    await expect(workflow.sendPaneCard(action, { bindingId: "selected", bindingGeneration: 3, paneId: "work:p1", sourceMainMessageId: "om-main" })).resolves.toBe("sent");
    expect(reservePaneThreadAlias).toHaveBeenCalledWith(expect.objectContaining({ publicationKey: "pane-card-send:directory-card:selected:3:om-main", targetChatId: "chat", card: { card: "main-entry" } }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "pane.card.send", outcome: "reserved" }));

    await expect(workflow.sendPaneCard(action, { bindingId: "selected", bindingGeneration: 2, paneId: "work:p1", sourceMainMessageId: "om-main" })).resolves.toBe("stale");
    expect(reservePaneThreadAlias).toHaveBeenCalledTimes(1);
  });
});

function activeBinding(id: string): Binding {
  return { id, projectId: "project", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task", paneId: "work:p1", statusMessageId: "om-main", generation: 3, state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working" } as Binding;
}

function topic(bindingId: string): TopicViewState {
  return { bindingId, title: "Task", workspaceId: "workspace", spaceName: "Core" } as TopicViewState;
}
