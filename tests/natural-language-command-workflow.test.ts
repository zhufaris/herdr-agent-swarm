import { describe, expect, it, vi } from "vitest";
import { NaturalLanguageCommandWorkflow } from "../src/coordinator/natural-language-command-workflow.js";
import { cardKitApplicationPresentation } from "../src/cards/cardkit-application-presentation.js";

const message = { eventId: "event-1", messageId: "message-1", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "admin", text: "停止当前任务", mentionsBot: true, isRootMessage: false };
const target = { version: 1, kind: "swarm", bindingId: "b1", bindingGeneration: 2, paneId: "w1:p1", terminalId: null, nativeSession: null, activePromptId: "prompt-1" } as const;

function harness() {
  const store = { stageNaturalLanguageCommandConfirmation: vi.fn(), getNaturalLanguageCommandConfirmation: vi.fn(), decideNaturalLanguageCommandConfirmation: vi.fn(), confirmNaturalLanguageSwarmCommand: vi.fn() };
  const context = { chatId: "chat", topicId: "topic", rootMessageId: "root", sourceMessageId: "message-1", actorOpenId: "admin", projectId: "p1", workspaceId: "w1", primary: { bindingId: "b1", bindingGeneration: 2, paneId: "w1:p1", terminalId: null, nativeSession: null, activePromptId: "prompt-1" } };
  const swarmCommands = { resolve: vi.fn(() => ({ outcome: "resolved", laneKey: "binding:b1", binding: null, context, target })), submit: vi.fn(async ({ command }) => command.kind === "status" ? { outcome: "query-completed", commandKind: command.kind } : command.kind === "stop" ? { outcome: "confirmation-required", commandKind: command.kind, context } : { outcome: "accepted", commandKind: command.kind, intent: { id: "intent-direct", state: "accepted" } }), wakeAcceptedIntent: vi.fn() };
  const workflow = new NaturalLanguageCommandWorkflow({ store: store as never, outbound: { enqueueCard: vi.fn() }, outboundWork: { wake: vi.fn() }, presentation: cardKitApplicationPresentation, swarmCommands: swarmCommands as never, now: () => new Date("2026-09-19T00:00:00.000Z"), idFactory: () => "confirmation-1" });
  return { workflow, store, swarmCommands };
}

describe("natural-language command workflow", () => {
  it("stages a literal clear as an actor-bound frozen confirmation", async () => {
    const h = harness();
    h.store.stageNaturalLanguageCommandConfirmation.mockImplementation((input) => ({ outcome: "staged", confirmation: input.confirmation }));

    await h.workflow.requestSwarmConfirmation({ ...message, text: "/swarm clear" }, { kind: "clear" }, h.swarmCommands.resolve(message, { kind: "clear" }).context);

    expect(h.store.stageNaturalLanguageCommandConfirmation).toHaveBeenCalledWith(expect.objectContaining({ confirmation: expect.objectContaining({ actorOpenId: "admin", envelope: { version: 1, family: "swarm", command: { kind: "clear" } }, frozenTarget: target }) }));
    const card = h.store.stageNaturalLanguageCommandConfirmation.mock.calls[0]![0].outbox.card;
    expect(JSON.stringify(card)).toContain("Pane ID、token、名称、位置、Thread 和 Workers 均会保留");
  });

  it("executes queries and recoverable mutations directly but stages destructive mutations", async () => {
    const h = harness();
    await h.workflow.handle(message, { outcome: "command", source: "deterministic", family: "swarm", command: { kind: "status" } });
    expect(h.swarmCommands.submit).toHaveBeenCalledWith({ source: "natural-language", message, command: { kind: "status" } });
    await h.workflow.handle(message, { outcome: "command", source: "deterministic", family: "swarm", command: { kind: "rename", title: "Next" } });
    expect(h.store.stageNaturalLanguageCommandConfirmation).not.toHaveBeenCalled();

    h.store.stageNaturalLanguageCommandConfirmation.mockImplementation((input) => ({ outcome: "staged", confirmation: input.confirmation }));
    await h.workflow.handle(message, { outcome: "command", source: "deterministic", family: "swarm", command: { kind: "stop" } });
    expect(h.store.stageNaturalLanguageCommandConfirmation).toHaveBeenCalledWith(expect.objectContaining({ confirmation: expect.objectContaining({ id: "confirmation-1", frozenTarget: target, state: "pending", expiresAt: "2026-09-19T00:10:00.000Z" }) }));
    expect(h.swarmCommands.submit).toHaveBeenCalledTimes(3);
  });

  it("atomically accepts a confirmed Swarm intent and wakes that durable lane", async () => {
    const h = harness();
    const confirmation = { id: "confirmation-1", sourceMessageId: "message-1", actorOpenId: "admin", chatId: "chat", topicId: "topic", rootMessageId: "root", envelope: { version: 1, family: "swarm", command: { kind: "stop" } }, frozenTarget: target, state: "pending", expiresAt: "2026-09-19T00:10:00.000Z", resultDetail: null, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z", resolvedAt: null } as const;
    h.store.getNaturalLanguageCommandConfirmation.mockReturnValue(confirmation);
    const intent = { id: "intent-1", laneKey: "binding:b1" };
    h.store.confirmNaturalLanguageSwarmCommand.mockReturnValue({ outcome: "consumed", confirmation: { ...confirmation, state: "consumed" }, commandIntent: { outcome: "accepted", intent } });

    await expect(h.workflow.decide({ messageId: "card", chatId: "chat", operatorOpenId: "admin", value: {} }, "confirmation-1", "confirm")).resolves.toEqual({ toast: { type: "success", content: "已确认，命令已提交。" } });
    expect(h.store.confirmNaturalLanguageSwarmCommand).toHaveBeenCalledOnce();
    expect(h.store.confirmNaturalLanguageSwarmCommand).toHaveBeenCalledWith(expect.objectContaining({ resolvedTarget: target }));
    expect(h.swarmCommands.wakeAcceptedIntent).toHaveBeenCalledWith(intent);
    expect(h.swarmCommands.submit).not.toHaveBeenCalled();
  });

  it("does not consume a confirmation after authorization is lost", async () => {
    const h = harness();
    h.store.getNaturalLanguageCommandConfirmation.mockReturnValue({ id: "confirmation-1", sourceMessageId: "message-1", actorOpenId: "admin", chatId: "chat", topicId: "topic", rootMessageId: "root", envelope: { version: 1, family: "swarm", command: { kind: "stop" } }, frozenTarget: target, state: "pending", expiresAt: "2026-09-19T00:10:00.000Z", resultDetail: null, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z", resolvedAt: null });
    h.swarmCommands.resolve.mockReturnValue({ outcome: "rejected", code: "creator_required", message: "denied" });
    await expect(h.workflow.decide({ messageId: "card", chatId: "chat", operatorOpenId: "admin", value: {} }, "confirmation-1", "confirm")).resolves.toEqual({ toast: { type: "error", content: "denied" } });
    expect(h.store.confirmNaturalLanguageSwarmCommand).not.toHaveBeenCalled();
  });

  it("does not invoke a Worker effect when a same-name replacement misses the frozen target", async () => {
    const store = { stageNaturalLanguageCommandConfirmation: vi.fn(), getNaturalLanguageCommandConfirmation: vi.fn(), decideNaturalLanguageCommandConfirmation: vi.fn(), confirmNaturalLanguageSwarmCommand: vi.fn() };
    const frozenTarget = { version: 1, kind: "worker", instanceId: "worker-old", instanceGeneration: 1, workerSessionGeneration: 2, parentBindingId: "b1", parentBindingGeneration: 2, parentPaneId: "w1:p1" } as const;
    const resolvedTarget = { ...frozenTarget, instanceId: "worker-new" };
    const confirmation = { id: "confirmation-1", sourceMessageId: "message-1", actorOpenId: "admin", chatId: "chat", topicId: "topic", rootMessageId: "root", envelope: { version: 1, family: "instance", command: { kind: "stop_instance", name: "reviewer" } }, frozenTarget, state: "pending", expiresAt: "2026-09-19T00:10:00.000Z", resultDetail: null, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z", resolvedAt: null } as const;
    store.getNaturalLanguageCommandConfirmation.mockReturnValue(confirmation);
    store.decideNaturalLanguageCommandConfirmation.mockReturnValue({ outcome: "stale", confirmation: { ...confirmation, state: "cancelled", resultDetail: "stale_context" } });
    const instanceInteractions = { resolveNaturalLanguageMutationTarget: vi.fn(() => ({ outcome: "resolved", instance: { id: "worker-new" }, binding: { id: "b1" }, target: resolvedTarget })), handleCommand: vi.fn() };
    const workflow = new NaturalLanguageCommandWorkflow({ store: store as never, outbound: { enqueueCard: vi.fn() }, outboundWork: { wake: vi.fn() }, presentation: cardKitApplicationPresentation, swarmCommands: harness().swarmCommands as never, instanceInteractions: instanceInteractions as never, now: () => new Date("2026-09-19T00:00:00.000Z") });

    await expect(workflow.decide({ messageId: "card", chatId: "chat", operatorOpenId: "admin", value: {} }, "confirmation-1", "confirm")).resolves.toEqual({ toast: { type: "warning", content: "该确认已失效，请重新发送请求。" } });
    expect(store.decideNaturalLanguageCommandConfirmation).toHaveBeenCalledWith(expect.objectContaining({ resolvedTarget }));
    expect(instanceInteractions.handleCommand).not.toHaveBeenCalled();
  });

  it("durably rejects an unreadable persisted envelope without resolving or executing a target", async () => {
    const h = harness();
    const handleCommand = vi.fn();
    h.store.getNaturalLanguageCommandConfirmation.mockReturnValue(null);
    h.store.decideNaturalLanguageCommandConfirmation.mockReturnValue({ outcome: "stale", confirmation: null });
    const workflow = new NaturalLanguageCommandWorkflow({ store: h.store as never, outbound: { enqueueCard: vi.fn() }, outboundWork: { wake: vi.fn() }, presentation: cardKitApplicationPresentation, swarmCommands: h.swarmCommands as never, instanceInteractions: { resolveNaturalLanguageMutationTarget: vi.fn(), handleCommand } as never, now: () => new Date("2026-09-19T00:00:00.000Z") });

    await expect(workflow.decide({ messageId: "card", chatId: "chat", operatorOpenId: "admin", value: {} }, "malformed", "confirm")).resolves.toEqual({ toast: { type: "warning", content: "该确认已失效，请重新发送请求。" } });
    expect(h.store.decideNaturalLanguageCommandConfirmation).toHaveBeenCalledWith({ id: "malformed", decision: "confirm", actorOpenId: "admin", chatId: "chat", decidedAt: "2026-09-19T00:00:00.000Z" });
    expect(h.swarmCommands.resolve).not.toHaveBeenCalled();
    expect(h.store.confirmNaturalLanguageSwarmCommand).not.toHaveBeenCalled();
    expect(handleCommand).not.toHaveBeenCalled();
  });

  it("cancels without loading or parsing the persisted envelope or target", async () => {
    const h = harness();
    h.store.decideNaturalLanguageCommandConfirmation.mockReturnValue({ outcome: "cancelled", confirmation: null });
    await expect(h.workflow.decide({ messageId: "card", chatId: "chat", operatorOpenId: "admin", value: {} }, "malformed", "cancel")).resolves.toEqual({ toast: { type: "success", content: "已取消，不会执行命令。" } });
    expect(h.store.getNaturalLanguageCommandConfirmation).not.toHaveBeenCalled();
    expect(h.store.decideNaturalLanguageCommandConfirmation).toHaveBeenCalledWith({ id: "malformed", decision: "cancel", actorOpenId: "admin", chatId: "chat", decidedAt: "2026-09-19T00:00:00.000Z" });
  });
});
