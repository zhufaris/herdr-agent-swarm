import { describe, expect, it, vi } from "vitest";
import { PromptAdmissionWorkflow } from "../src/coordinator/prompt-admission-workflow.js";
import { primaryPresentation } from "./helpers/presentation.js";

const binding = { id: "binding", projectId: "project", workspaceId: "workspace", paneId: "workspace:p0", rootMessageId: "root", topicId: "topic", title: "Primary", agentKind: "traex", state: "active", lifecycle: "active", generation: 3 };
const message = { eventId: "event", messageId: "message", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue", mentionsBot: false, isRootMessage: false };

function setup(overrides: Record<string, unknown> = {}) {
  const effects = [{ kind: "outbound-wake" as const }, { kind: "prompt-wake" as const, bindingId: binding.id }];
  const store = {
    countPendingPrompts: vi.fn(() => 2),
    acceptPromptWithEffects: vi.fn((input: any) => ({ result: { inserted: true, prompt: input.prompt, view: input.view }, commitState: "committed", consumeEffects: () => effects })),
    audit: vi.fn(), ...overrides
  };
  const lifecycleEvents = { publish: vi.fn(async () => undefined) };
  const outboundWork = { wake: vi.fn(), subscribe: vi.fn() };
  const scheduler = { wake: vi.fn(), subscribe: vi.fn() };
  const outbound = { enqueueCard: vi.fn(async () => undefined) };
  const workflow = new PromptAdmissionWorkflow({
    config: { projects: [{ id: "project", displayName: "Project", description: "Project", workspaceId: "workspace", cwd: "/repo" }], maxQueueDepth: 20 },
    store, routing: { isBindingThreadAlias: vi.fn(() => false) }, primaryState: { activeTurn: vi.fn(() => ({ promptId: "parent" })) },
    lifecycleEvents, outbound, outboundWork, scheduler, presentation: primaryPresentation
  } as never);
  return { workflow, store, outbound, outboundWork, scheduler };
}

describe("PromptAdmissionWorkflow", () => {
  it("owns atomic Prompt acceptance and post-commit effects", async () => {
    const h = setup();
    const accepted = await h.workflow.accept(binding as never, message);
    expect(accepted).toEqual({ promptId: expect.any(String) });
    expect(h.store.acceptPromptWithEffects).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.objectContaining({ bindingId: "binding", larkMessageId: "message", body: "continue" }),
      view: expect.objectContaining({ bindingGeneration: 3, conversionParentPromptId: "parent", queuePosition: 3 }),
      rootMessageId: "root", maxQueueDepth: 20, expectedBindingGeneration: 3
    }));
    expect(h.outboundWork.wake).toHaveBeenCalledOnce();
    expect(h.scheduler.wake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "binding" });
    expect(h.store.audit).toHaveBeenCalledWith({ actorOpenId: "operator", action: "prompt.queue", target: "binding", outcome: "success" });
  });

  it("returns the existing durable Prompt without repeating post-commit effects", async () => {
    const h = setup({ acceptPromptWithEffects: vi.fn((input: any) => ({ result: { inserted: false, prompt: { ...input.prompt, id: "existing" }, view: input.view }, commitState: "committed", consumeEffects: vi.fn(() => { throw new Error("must not consume"); }) })) });
    await expect(h.workflow.accept(binding as never, message)).resolves.toEqual({ promptId: "existing" });
    expect(h.outboundWork.wake).not.toHaveBeenCalled();
    expect(h.store.audit).not.toHaveBeenCalled();
  });

  it("uses the completed project selection identity for initial Prompt idempotency", async () => {
    const h = setup();
    const selection = { id: "selection", commandMessageId: "command-message", chatId: "chat", actorOpenId: "operator", initialPromptText: "initial work" };
    await h.workflow.acceptInitial(binding as never, selection as never);
    expect(h.store.acceptPromptWithEffects).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.objectContaining({ larkMessageId: "command-message", body: "initial work" }) }));
  });

  it("reserves durable feedback and returns null when the queue is full", async () => {
    const h = setup({ acceptPromptWithEffects: vi.fn(() => { throw new Error("This topic's prompt queue is full"); }) });
    await expect(h.workflow.accept(binding as never, message)).resolves.toBeNull();
    expect(h.outbound.enqueueCard).toHaveBeenCalledWith("root", "rejected:message", expect.any(Object));
  });
});
