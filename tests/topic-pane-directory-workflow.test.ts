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
      store: { listBindings: () => [selected, { ...activeBinding("other-chat"), chatId: "other" }, { ...activeBinding("detached"), attachment: "orphaned" }, { ...activeBinding("missing-card"), statusMessageId: null }], listWorkerInstancesByParent: () => [{ id: "worker-1", name: "reviewer", generation: 4, workerSessionGeneration: 2, observedState: "working", runtimeRef: { paneId: "work:p2" } }], loadTopicView: (id) => id === "selected" ? topic("selected") : null, listFailures: () => [], listSessions: () => [] }
    });

    await workflow.listTopicPanes(message);

    expect(presentation.topicPanes).toHaveBeenCalledWith([expect.objectContaining({ bindingId: "selected", bindingGeneration: 3, paneId: "work:p1", sourceMainMessageId: "om-main" })]);
    expect(presentation.topicPanes).toHaveBeenCalledWith([expect.objectContaining({ workers: [expect.objectContaining({ workerName: "reviewer", paneId: "work:p2", runtimeGeneration: 4 })] })]);
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
      store: { listBindings: () => [scoped, sameSpace, otherProject], listWorkerInstancesByParent: () => [], loadTopicView: (id) => topic(id), listFailures: () => [], listSessions: () => [] }
    });

    await workflow.listTopicPanes(message, scoped);
    expect(presentation.topicPanes).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ bindingId: "scoped" }), expect.objectContaining({ bindingId: "same-space" })]));
    expect(presentation.topicPanes).toHaveBeenLastCalledWith(expect.not.arrayContaining([expect.objectContaining({ bindingId: "other-project" })]));

    await workflow.listTopicPanes({ ...message, messageId: "unbound", topicId: null, rootMessageId: "unbound" });
    expect(presentation.topicPanes).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ bindingId: "scoped" }), expect.objectContaining({ bindingId: "same-space" }), expect.objectContaining({ bindingId: "other-project" })]));
  });

  it("revalidates the callback identity and shares the canonical Primary thread without creating a Pane Entry alias", async () => {
    const binding = activeBinding("selected");
    const reservePaneThreadAlias = vi.fn(() => "reserved" as const);
    const audit = vi.fn();
    const shareConversation = vi.fn(async () => undefined);
    const workflow = new DeliveryRecoveryWorkflow({
      store: { getBinding: () => binding, resolveCanonicalWorkerThread: vi.fn(() => null), loadTopicView: () => topic("selected"), reservePaneThreadAlias, audit, dismissDeadLetter: vi.fn(), listFailures: vi.fn(() => []), retryDeadLetter: vi.fn() },
      gatewayEffects: { createConversation: vi.fn(), replyText: vi.fn(), shareConversation }, outbound: { enqueueCardUpdate: vi.fn(async () => {}) }, outboundWork: { wake: vi.fn(), subscribe: vi.fn(() => () => {}) },
      presentation: { paneEntryCard: vi.fn(() => ({ card: "main-entry" })), failures: vi.fn(() => []) }, logger: pino({ enabled: false })
    });

    await expect(workflow.forwardPaneThread(action, { kind: "pane-directory", action: "pane_primary_thread_forward", bindingId: "selected", bindingGeneration: 3, paneId: "work:p1", sourceMainMessageId: "om-main" })).resolves.toBe("sent");
    expect(shareConversation).toHaveBeenCalledWith({ conversationId: "topic", messageId: "directory-card", targetConversationId: "chat", purpose: "group-thread" });
    expect(reservePaneThreadAlias).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "pane.card.send", outcome: "shared" }));

    await expect(workflow.forwardPaneThread(action, { kind: "pane-directory", action: "pane_primary_thread_forward", bindingId: "selected", bindingGeneration: 2, paneId: "work:p1", sourceMainMessageId: "om-main" })).resolves.toBe("stale");
    expect(shareConversation).toHaveBeenCalledTimes(1);
  });

  it("shares only an exact active canonical Worker thread and never reserves a legacy entry", async () => {
    const reservePaneThreadAlias = vi.fn(() => "reserved" as const);
    const resolveCanonicalWorkerThread = vi.fn(() => ({ conversationId: "worker-topic" }));
    const audit = vi.fn();
    const shareConversation = vi.fn(async () => undefined);
    const workflow = new DeliveryRecoveryWorkflow({
      store: { getBinding: vi.fn(), resolveCanonicalWorkerThread, loadTopicView: vi.fn(), reservePaneThreadAlias, audit, dismissDeadLetter: vi.fn(), listFailures: vi.fn(() => []), retryDeadLetter: vi.fn() },
      gatewayEffects: { createConversation: vi.fn(), replyText: vi.fn(), shareConversation }, outbound: { enqueueCardUpdate: vi.fn(async () => {}) }, outboundWork: { wake: vi.fn(), subscribe: vi.fn(() => () => {}) },
      presentation: { paneEntryCard: vi.fn(), failures: vi.fn(() => []) }, logger: pino({ enabled: false })
    });
    const target = { kind: "pane-directory" as const, action: "pane_worker_thread_forward" as const, instanceId: "worker-1", generation: 4, workerSessionGeneration: 2, bindingId: "selected", bindingGeneration: 3, parentPaneId: "work:p1", sourceMainMessageId: "om-main" };

    await expect(workflow.forwardPaneThread(action, target)).resolves.toBe("sent");
    expect(resolveCanonicalWorkerThread).toHaveBeenCalledWith({ chatId: "chat", workerId: "worker-1", runtimeGeneration: 4, workerSessionGeneration: 2, parentBindingId: "selected", parentBindingGeneration: 3, parentPaneId: "work:p1", sourceMainMessageId: "om-main" });
    expect(shareConversation).toHaveBeenCalledWith({ conversationId: "worker-topic", messageId: "directory-card", targetConversationId: "chat", purpose: "group-thread" });
    expect(reservePaneThreadAlias).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "pane.worker.thread.forward", outcome: "shared" }));

    resolveCanonicalWorkerThread.mockReturnValueOnce(null);
    await expect(workflow.forwardPaneThread(action, target)).resolves.toBe("stale");
    expect(shareConversation).toHaveBeenCalledTimes(1);
  });
});

function activeBinding(id: string): Binding {
  return { id, projectId: "project", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task", paneId: "work:p1", statusMessageId: "om-main", generation: 3, state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working" } as Binding;
}

function topic(bindingId: string): TopicViewState {
  return { bindingId, title: "Task", workspaceId: "workspace", spaceName: "Core" } as TopicViewState;
}
