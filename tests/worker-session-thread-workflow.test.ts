import { describe, expect, it, vi } from "vitest";
import { WorkerSessionThreadWorkflow } from "../src/coordinator/worker-session-thread-workflow.js";
import { applicationPresentation } from "./helpers/presentation.js";

const message = (text = "work") => ({ eventId: "event", messageId: "message", parentMessageId: null, chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text, mentionsBot: true, isRootMessage: false });
const active = (patch: Record<string, unknown> = {}) => ({ kind: "active" as const, target: { threadId: "thread", workerId: "worker", workerName: "reviewer", workerSessionGeneration: 1, projectId: "project", runtimeGeneration: 2, parentBindingId: "binding", parentBindingGeneration: 1, parentPaneId: "primary-pane", rootMessageId: "worker-root", mode: "canonical-main" as const, view: { workerName: "reviewer" }, activeTurn: null, ...patch } });

function setup(resolution: object = { kind: "none" }) {
  const store = { resolveScope: vi.fn(() => resolution), reserveLegacyEntry: vi.fn(() => ({ kind: "reserved" as const })) };
  const messaging = { submit: vi.fn(async () => ({ inserted: true, card: { queuePosition: 2 } })), steer: vi.fn(async () => ({ status: "delivered", durableResult: true })), interrupt: vi.fn(async () => ({ status: "interrupted", durableResult: true })) };
  const outbound = { enqueueCard: vi.fn(async () => undefined) }; const wakeOutbound = vi.fn();
  const workflow = new WorkerSessionThreadWorkflow({ adminOpenIds: ["operator"], store: store as never, messaging: messaging as never, outbound: outbound as never, wakeOutbound, presentation: applicationPresentation });
  return { workflow, store, messaging, outbound, wakeOutbound };
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

  it("submits ordinary text to the validated fixed Worker target", async () => {
    const { workflow, messaging, outbound } = setup(active());
    await expect(workflow.handleMessage(message("new task"))).resolves.toEqual({ handled: true, disposition: "prompt_queued" });
    expect(messaging.submit).toHaveBeenCalledWith(expect.objectContaining({ targetInstanceId: "worker", projectId: "project", content: { kind: "turn", text: "new task" }, source: { messageId: "message", rootMessageId: "worker-root" } }));
    expect(outbound.enqueueCard).toHaveBeenCalledWith("worker-root", "worker-thread:accepted:message", expect.any(Object));
  });

  it("uses the exact active turn for steer and stop", async () => {
    const { workflow, messaging } = setup(active({ activeTurn: { id: "turn", state: "running" } }));
    await workflow.handleMessage(message("/steer focus"));
    await workflow.handleMessage({ ...message("/stop"), messageId: "stop" });
    expect(messaging.steer).toHaveBeenCalledWith(expect.objectContaining({ targetInstanceId: "worker", targetTurnId: "turn", text: "focus" }));
    expect(messaging.interrupt).toHaveBeenCalledWith(expect.objectContaining({ targetInstanceId: "worker", targetTurnId: "turn" }));
  });

  it.each([
    [{ kind: "reserved" }, "已提交", 1], [{ kind: "pending" }, "已受理", 0], [{ kind: "existing", rootMessageId: "root" }, "已存在", 0], [{ kind: "stale" }, "已变化", 0]
  ] as const)("maps publication %j to stable callback feedback", async (decision, copy, wakes) => {
    const { workflow, store, wakeOutbound } = setup(); store.reserveLegacyEntry.mockReturnValue(decision);
    const result = await workflow.publishFromCard({ messageId: "card", chatId: "chat", operatorOpenId: "operator", value: {} }, { instanceId: "worker", runtimeGeneration: 2, workerSessionGeneration: 1, conversationKey: "binding:binding", bindingId: "binding", bindingGeneration: 1 });
    expect(result.toast?.content).toContain(copy); expect(wakeOutbound).toHaveBeenCalledTimes(wakes);
  });
});
