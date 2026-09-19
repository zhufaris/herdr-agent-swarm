import { describe, expect, it, vi } from "vitest";
import { NaturalLanguageCommandWorkflow } from "../src/coordinator/natural-language-command-workflow.js";
import { cardKitApplicationPresentation } from "../src/cards/cardkit-application-presentation.js";

const message = { eventId: "event-1", messageId: "message-1", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "admin", text: "停止当前任务", mentionsBot: true, isRootMessage: false };

function harness() {
  const store = { stageNaturalLanguageCommandConfirmation: vi.fn(), getNaturalLanguageCommandConfirmation: vi.fn(), decideNaturalLanguageCommandConfirmation: vi.fn(), confirmNaturalLanguageSwarmCommand: vi.fn() };
  const swarmCommands = { resolve: vi.fn(() => ({ outcome: "resolved", laneKey: "binding:b1", binding: null, context: { chatId: "chat", topicId: "topic", rootMessageId: "root", sourceMessageId: "message-1", actorOpenId: "admin", projectId: "p1", workspaceId: "w1", primary: { bindingId: "b1", bindingGeneration: 2, paneId: "w1:p1", terminalId: null, nativeSession: null, activePromptId: "prompt-1" } } })), handle: vi.fn(), drainAcceptedIntent: vi.fn() };
  const workflow = new NaturalLanguageCommandWorkflow({ store: store as never, outbound: { enqueueCard: vi.fn() }, outboundWork: { wake: vi.fn() }, presentation: cardKitApplicationPresentation, swarmCommands: swarmCommands as never, now: () => new Date("2026-09-19T00:00:00.000Z"), idFactory: () => "confirmation-1" });
  return { workflow, store, swarmCommands };
}

describe("natural-language command workflow", () => {
  it("executes queries directly but stages mutations with frozen context", async () => {
    const h = harness();
    await h.workflow.handle(message, { outcome: "command", source: "deterministic", family: "swarm", command: { kind: "status" } });
    expect(h.swarmCommands.handle).toHaveBeenCalledOnce();

    h.store.stageNaturalLanguageCommandConfirmation.mockImplementation((input) => ({ outcome: "staged", confirmation: input.confirmation }));
    await h.workflow.handle(message, { outcome: "command", source: "deterministic", family: "swarm", command: { kind: "stop" } });
    expect(h.store.stageNaturalLanguageCommandConfirmation).toHaveBeenCalledWith(expect.objectContaining({ confirmation: expect.objectContaining({ id: "confirmation-1", expectedBindingId: "b1", expectedBindingGeneration: 2, state: "pending", expiresAt: "2026-09-19T00:10:00.000Z" }) }));
    expect(h.swarmCommands.handle).toHaveBeenCalledOnce();
  });

  it("atomically accepts a confirmed Swarm intent and drains that durable lane", async () => {
    const h = harness();
    const confirmation = { id: "confirmation-1", sourceMessageId: "message-1", actorOpenId: "admin", chatId: "chat", topicId: "topic", rootMessageId: "root", envelope: { version: 1, family: "swarm", command: { kind: "stop" } }, expectedBindingId: "b1", expectedBindingGeneration: 2, expectedInstanceId: null, expectedInstanceGeneration: null, state: "pending", expiresAt: "2026-09-19T00:10:00.000Z", resultDetail: null, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z", resolvedAt: null } as const;
    h.store.getNaturalLanguageCommandConfirmation.mockReturnValue(confirmation);
    const intent = { id: "intent-1", laneKey: "binding:b1" };
    h.store.confirmNaturalLanguageSwarmCommand.mockReturnValue({ outcome: "consumed", confirmation: { ...confirmation, state: "consumed" }, commandIntent: { outcome: "accepted", intent } });

    await expect(h.workflow.decide({ messageId: "card", chatId: "chat", operatorOpenId: "admin", value: {} }, "confirmation-1", "confirm")).resolves.toEqual({ toast: { type: "success", content: "已确认，命令已提交。" } });
    expect(h.store.confirmNaturalLanguageSwarmCommand).toHaveBeenCalledOnce();
    expect(h.swarmCommands.drainAcceptedIntent).toHaveBeenCalledWith(intent);
    expect(h.swarmCommands.handle).not.toHaveBeenCalled();
  });
});
