import { describe, expect, it, vi } from "vitest";
import { InitialAgentInputWorkflow } from "../src/coordinator/initial-agent-input-workflow.js";
import { primaryPresentation } from "./helpers/presentation.js";

const selection = {
  id: "selection-1", commandMessageId: "source-1", chatId: "chat", topicId: null, rootMessageId: "source-root",
  actorOpenId: "operator", initialPromptText: "start work"
};
const binding = {
  id: "binding-1", gatewayId: "feishu:primary", paneId: "w1:p1", traexSessionId: "terminal-1", agentKind: "traex",
  agentSessionAgent: null, agentSessionValue: null, generation: 2, rootMessageId: "primary-root"
};

function setup(result: { outcome: "accepted" | "duplicate" | "conflict"; submissionId: string; state: "prepared" | "cancelled" } = { outcome: "accepted", submissionId: "submission-1", state: "prepared" }) {
  const agentInput = { submit: vi.fn(async () => result) };
  const outbound = { enqueueCard: vi.fn(async () => undefined) };
  const workflow = new InitialAgentInputWorkflow({ agentInput: agentInput as never, outbound: outbound as never, presentation: primaryPresentation });
  return { workflow, agentInput, outbound };
}

describe("InitialAgentInputWorkflow", () => {
  it("preserves duplicate first-session bootstrap identity without a Prompt fallback", async () => {
    const { workflow, agentInput } = setup({ outcome: "duplicate", submissionId: "submission-1", state: "prepared" });

    await expect(workflow.submit(binding as never, selection as never)).resolves.toEqual({ outcome: "duplicate", submissionId: "submission-1" });

    expect(agentInput.submit).toHaveBeenCalledWith(expect.objectContaining({
      sourceMessageKey: "source-1", owner: { kind: "primary", id: "binding-1", generation: 2 },
      terminalId: "terminal-1", expectedAgentKind: "traex", expectedSessionId: null, text: "start work"
    }));
  });

  it("rejects an unsupported initial Agent kind visibly before admission", async () => {
    const { workflow, agentInput, outbound } = setup();

    await expect(workflow.submit({ ...binding, agentKind: "codex" } as never, selection as never)).resolves.toEqual({ outcome: "rejected", submissionId: null });

    expect(agentInput.submit).not.toHaveBeenCalled();
    expect(outbound.enqueueCard).toHaveBeenCalledWith("primary-root", "rejected:initial-agent-input:source-1", expect.any(Object));
  });
});
