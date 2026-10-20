import { describe, expect, it, vi } from "vitest";
import { WorkerSessionThreadWorkflow } from "../src/coordinator/worker-session-thread-workflow.js";
import { applicationPresentation } from "./helpers/presentation.js";

const message = (text = "work") => ({ eventId: "event", messageId: "message", parentMessageId: null, chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text, mentionsBot: true, isRootMessage: false });
const active = (patch: Record<string, unknown> = {}) => ({ kind: "active" as const, target: { threadId: "thread", workerId: "worker", workerName: "reviewer", workerSessionGeneration: 1, projectId: "project", runtimeGeneration: 2, paneId: "worker-pane", agentKind: "traex" as const, nativeSessionId: null, parentBindingId: "binding", parentBindingGeneration: 1, parentPaneId: "primary-pane", rootMessageId: "worker-root", mode: "canonical-main" as const, view: { workerName: "reviewer" }, activeTurn: null, ...patch } });

function setup(resolution: object = { kind: "none" }) {
  const store = { resolveScope: vi.fn(() => resolution), reserveLegacyEntry: vi.fn(() => ({ kind: "reserved" as const })) };
  const messaging = { submit: vi.fn(async () => ({ inserted: true, card: { queuePosition: 2 } })), steer: vi.fn(async () => ({ status: "delivered", durableResult: true })), interrupt: vi.fn(async () => ({ status: "interrupted", durableResult: true })) };
  const agentInput = { submit: vi.fn(async () => ({ outcome: "accepted" as const, submissionId: "submission-1", state: "prepared" as const })) };
  const herdr = { getPane: vi.fn(async () => ({ paneId: "worker-pane", terminalId: "worker-terminal", agentKind: "traex", agentSession: null })) };
  const outbound = { enqueueCard: vi.fn(async () => undefined) }; const wakeOutbound = vi.fn(); const gatewayEffects = { shareConversation: vi.fn(async () => ({ messageId: "shared" })) };
  const workflow = new WorkerSessionThreadWorkflow({ gatewayId: "feishu:primary", adminOpenIds: ["operator"], store: store as never, messaging: messaging as never, agentInput, herdr, outbound: outbound as never, wakeOutbound, gatewayEffects, presentation: applicationPresentation });
  return { workflow, store, messaging, agentInput, herdr, outbound, wakeOutbound, gatewayEffects };
}

describe("WorkerSessionThreadWorkflow", () => {
  it("returns unhandled for a non-Worker scope", async () => {
    const { workflow, messaging } = setup();
    await expect(workflow.handleMessage(message())).resolves.toEqual({ handled: false });
    expect(messaging.submit).not.toHaveBeenCalled();
  });

  it("owns and rejects a stale Worker root", async () => {
    const { workflow, outbound, messaging } = setup({ kind: "stale", threadId: "old" });
    await expect(workflow.handleMessage(message())).resolves.toEqual({ handled: true, disposition: "rejected" });
    expect(outbound.enqueueCard).toHaveBeenCalledWith("worker-root", "rejected:message", expect.any(Object));
    expect(messaging.submit).not.toHaveBeenCalled();
  });

  it("submits first-session Worker text as one independently fenced Agent Input", async () => {
    const { workflow, messaging, agentInput, herdr, outbound } = setup(active());
    await expect(workflow.handleMessage(message("new task"))).resolves.toEqual({ handled: true, disposition: "agent_input_accepted" });
    expect(herdr.getPane).toHaveBeenCalledWith("worker-pane");
    expect(agentInput.submit).toHaveBeenCalledWith({
      ingressSource: "feishu:primary",
      sourceMessageKey: "message",
      actor: { kind: "human", id: "operator", gatewayId: "feishu:primary", chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root" },
      text: "new task",
      owner: { kind: "worker", id: "worker", generation: 2 },
      paneId: "worker-pane",
      terminalId: "worker-terminal",
      expectedAgentKind: "traex",
      expectedSessionId: null
    });
    expect(messaging.submit).not.toHaveBeenCalled();
    expect(outbound.enqueueCard).not.toHaveBeenCalled();
  });

  it("preserves the exact existing Worker session fence", async () => {
    const { workflow, agentInput, herdr } = setup(active({ nativeSessionId: "session-1" }));
    herdr.getPane.mockResolvedValue({ paneId: "worker-pane", terminalId: "worker-terminal", agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } });

    await expect(workflow.handleMessage(message("continue"))).resolves.toEqual({ handled: true, disposition: "agent_input_accepted" });

    expect(agentInput.submit).toHaveBeenCalledWith(expect.objectContaining({ expectedSessionId: "session-1" }));
  });

  it("converges duplicate Worker source delivery through Agent Input", async () => {
    const { workflow, agentInput, outbound } = setup(active());
    agentInput.submit.mockResolvedValue({ outcome: "duplicate", submissionId: "submission-1", state: "prepared" });

    await expect(workflow.handleMessage(message("same task"))).resolves.toEqual({ handled: true, disposition: "agent_input_accepted" });

    expect(agentInput.submit).toHaveBeenCalledOnce();
    expect(outbound.enqueueCard).not.toHaveBeenCalled();
  });

  it("routes non-reserved slash text to the Worker Agent", async () => {
    const { workflow, agentInput } = setup(active());

    await expect(workflow.handleMessage(message("/compact"))).resolves.toEqual({ handled: true, disposition: "agent_input_accepted" });

    expect(agentInput.submit).toHaveBeenCalledWith(expect.objectContaining({ text: "/compact" }));
  });

  it("rejects unsupported Worker Agent kinds before Pane observation or admission", async () => {
    const { workflow, agentInput, herdr } = setup(active({ agentKind: "codex" }));

    await expect(workflow.handleMessage(message("work"))).resolves.toEqual({ handled: true, disposition: "rejected" });

    expect(herdr.getPane).not.toHaveBeenCalled();
    expect(agentInput.submit).not.toHaveBeenCalled();
  });

  it("rejects a changed Worker runtime fence before Agent Input admission", async () => {
    const { workflow, agentInput, herdr } = setup(active({ nativeSessionId: "session-1" }));
    herdr.getPane.mockResolvedValue({ paneId: "worker-pane", terminalId: "worker-terminal", agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-2" } });

    await expect(workflow.handleMessage(message("work"))).resolves.toEqual({ handled: true, disposition: "rejected" });

    expect(agentInput.submit).not.toHaveBeenCalled();
  });

  it("uses the exact active turn for steer and stop", async () => {
    const { workflow, messaging, agentInput, herdr } = setup(active({ activeTurn: { id: "turn", state: "running" } }));
    await workflow.handleMessage(message("/steer focus"));
    await workflow.handleMessage({ ...message("/stop"), messageId: "stop" });
    expect(messaging.steer).toHaveBeenCalledWith(expect.objectContaining({ targetInstanceId: "worker", targetTurnId: "turn", text: "focus" }));
    expect(messaging.interrupt).toHaveBeenCalledWith(expect.objectContaining({ targetInstanceId: "worker", targetTurnId: "turn" }));
    expect(herdr.getPane).not.toHaveBeenCalled();
    expect(agentInput.submit).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "reserved" }, "已提交", 1], [{ kind: "pending" }, "已受理", 0], [{ kind: "existing", rootMessageId: "root" }, "已打开", 0], [{ kind: "stale" }, "已变化", 0]
  ] as const)("maps publication %j to stable callback feedback", async (decision, copy, wakes) => {
    const { workflow, store, wakeOutbound } = setup(); store.reserveLegacyEntry.mockReturnValue(decision);
    const result = await workflow.publishFromCard({ messageId: "card", chatId: "chat", operatorOpenId: "operator", value: {} }, { instanceId: "worker", runtimeGeneration: 2, workerSessionGeneration: 1, conversationKey: "binding:binding", bindingId: "binding", bindingGeneration: 1 });
    expect(result.toast?.content).toContain(copy); expect(wakeOutbound).toHaveBeenCalledTimes(wakes);
  });

  it("shares an existing Worker Thread instead of creating another one", async () => {
    const { workflow, store, gatewayEffects, wakeOutbound } = setup();
    store.reserveLegacyEntry.mockReturnValue({ kind: "existing", rootMessageId: "worker-root" });

    await expect(workflow.publishFromCard({ messageId: "card", chatId: "chat", operatorOpenId: "operator", value: {} }, { instanceId: "worker", runtimeGeneration: 2, workerSessionGeneration: 1, conversationKey: "binding:binding", bindingId: "binding", bindingGeneration: 1 })).resolves.toEqual({ toast: { type: "success", content: "已打开 Worker Thread。" } });

    expect(gatewayEffects.shareConversation).toHaveBeenCalledWith({ conversationId: "worker-root", messageId: "card", targetConversationId: "chat", purpose: "group-thread" });
    expect(wakeOutbound).not.toHaveBeenCalled();
  });
});
