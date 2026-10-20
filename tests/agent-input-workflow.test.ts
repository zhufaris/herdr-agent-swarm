import { describe, expect, it, vi } from "vitest";
import { AgentInputDrainer } from "../src/coordinator/agent-input-drainer.js";
import { AgentInputWorkflow } from "../src/coordinator/agent-input-workflow.js";
import type { AgentInputCorePort } from "../src/domain/ports/agent-input.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";

describe("AgentInputWorkflow", () => {
  it("records an immutable source intent before submitting it through Core", async () => {
    const stores = createTestStoreBundle();
    const submit = vi.fn<AgentInputCorePort["submit"]>(async (input) => ({
      outcome: "receipt",
      receipt: {
        submissionId: input.submissionId,
        paneId: input.paneId,
        terminalId: input.terminalId,
        agentKind: input.agentKind,
        sessionId: input.sessionId,
        state: "prepared",
        turnId: null,
        startedAt: null,
        terminalState: null,
        createdAt: 1,
        updatedAt: 1
      }
    }));
    const core: AgentInputCorePort = {
      async capabilities() { return { agentInputSubmissionV2: true, agentInputSubmissionV3: true }; },
      submit,
      async queryReceipt() { return { outcome: "absent" }; }
    };
    const workflow = new AgentInputWorkflow({
      store: stores.agentInputs,
      drainer: new AgentInputDrainer({ store: stores.agentInputs, core, now: () => "2026-10-04T06:10:01.000Z" }),
      capability: { snapshot: () => ({ required: true, detected: true, supported: true, ready: true, error: null }) },
      idFactory: () => "submission-1",
      now: () => "2026-10-04T06:10:00.000Z"
    });

    await expect(workflow.submit(request())).resolves.toEqual({
      outcome: "accepted",
      submissionId: "submission-1",
      state: "prepared"
    });
    expect(stores.agentInputs.get("submission-1")).toMatchObject({
      ingressSource: "feishu:primary",
      sourceMessageKey: "message-1",
      text: "  /model gpt-x  ",
      state: "prepared"
    });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      submissionId: "submission-1",
      text: "  /model gpt-x  "
    }));
  });

  it("resumes an already atomically admitted intent without admitting a second input", async () => {
    const stores = createTestStoreBundle();
    const input = {
      schemaVersion: 2 as const,
      text: "trusted server choice",
      choice: { actionSetId: "actions-1", optionId: "revise", sourceMessageId: "review-message-1" }
    };
    stores.agentInputs.admit({
      submissionId: "completion-choice:actions-1:revise", ingressSource: "feishu:primary",
      sourceMessageKey: "completion-choice:v1:actions-1:revise", actor: request().actor,
      input, text: "trusted server choice", owner: request().owner, paneId: "w1:primary", terminalId: "terminal-1",
      expectedAgentKind: "traex", expectedSessionId: "session-1", recordedAt: "2026-10-04T06:10:00.000Z"
    });
    const submit = vi.fn<AgentInputCorePort["submit"]>(async (input) => ({
      outcome: "receipt", receipt: { submissionId: input.submissionId, paneId: input.paneId, terminalId: input.terminalId,
        agentKind: input.agentKind, sessionId: input.sessionId, state: "prepared", turnId: null, startedAt: null,
        terminalState: null, createdAt: 1, updatedAt: 1 }
    }));
    const workflow = new AgentInputWorkflow({
      store: stores.agentInputs,
      drainer: new AgentInputDrainer({ store: stores.agentInputs, core: {
        async capabilities() { return { agentInputSubmissionV2: true, agentInputSubmissionV3: true, agentInputTypedMessageV1: true }; }, submit,
        async queryReceipt() { return { outcome: "absent" }; }
      }, now: () => "2026-10-04T06:10:01.000Z" }),
      capability: { snapshot: () => ({ required: true, detected: true, supported: true, ready: true, error: null }) }
    });

    await expect(workflow.resume("completion-choice:actions-1:revise")).resolves.toEqual({
      outcome: "accepted", submissionId: "completion-choice:actions-1:revise", state: "prepared"
    });
    await expect(workflow.resume("completion-choice:actions-1:revise")).resolves.toEqual({
      outcome: "duplicate", submissionId: "completion-choice:actions-1:revise", state: "prepared"
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ input }));
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM submission_intents WHERE source_message_key='completion-choice:v1:actions-1:revise'").get()).toEqual({ count: 1 });
  });

  it("creates no speculative card and renders the Working Turn Card from canonical evidence", async () => {
    const stores = createTestStoreBundle();
    stores.driver.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    stores.driver.updateBinding("binding-1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:primary" });
    const turnCard = vi.fn((view: { state: string }) => ({ cardState: view.state }));
    stores.driver.capabilityModules().conversationSegments.setInitialTurnCardRenderer?.(turnCard as never);
    const core: AgentInputCorePort = {
      async capabilities() { return { agentInputSubmissionV2: true, agentInputSubmissionV3: true }; },
      async submit(input) {
        return {
          outcome: "receipt",
          receipt: {
            submissionId: input.submissionId, paneId: input.paneId, terminalId: input.terminalId,
            agentKind: input.agentKind, sessionId: input.sessionId, state: "prepared", turnId: null,
            startedAt: null, terminalState: null, createdAt: 1, updatedAt: 1
          }
        };
      },
      async queryReceipt() { return { outcome: "absent" }; }
    };
    const workflow = new AgentInputWorkflow({
      store: stores.agentInputs,
      drainer: new AgentInputDrainer({ store: stores.agentInputs, core, now: () => "2026-10-04T07:00:01.000Z" }),
      capability: { snapshot: () => ({ required: true, detected: true, supported: true, ready: true, error: null }) },
      idFactory: () => "submission-card-1",
      now: () => "2026-10-04T07:00:00.000Z"
    });

    await workflow.submit(request());

    expect(turnCard).not.toHaveBeenCalled();
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM input_card_views").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segments").get()).toEqual({ count: 0 });
    expect(stores.driver.listPendingOutboundReplies()).toHaveLength(0);

    stores.coreEvents.ingestBatch({
      laneId: "live:session-1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: "cursor-1", latestCursor: "cursor-1", ingestedAt: "2026-10-04T07:00:02.000Z",
      events: [{
        schemaVersion: 1, eventId: "human-event-1", cursor: "cursor-1", sourceId: "source-1",
        agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-04T07:00:02.000Z",
        payload: { type: "human_message", message_id: "human-1", text: "  /model gpt-x  ", truncated: false, submission_id: "submission-card-1" }
      }]
    });

    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM input_card_views").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT state,submission_id,root_message_id FROM conversation_segments").get())
      .toEqual({ state: "working", submission_id: "submission-card-1", root_message_id: "root" });
    expect(stores.driver.listPendingOutboundReplies()).toHaveLength(1);
    const create = stores.driver.listPendingOutboundReplies()[0]!;
    expect(create).toMatchObject({ kind: "card_reply", rootMessageId: "root" });
    expect(stores.driver.database.prepare("SELECT projection_key FROM outbound_replies WHERE id=?").get(create.id))
      .toEqual({ projection_key: "turn-card:segment:submission-card-1:page:0" });
    expect(JSON.parse(create.payload)).toEqual({ cardState: "working" });
    expect(stores.driver.database.prepare("SELECT pending_reply_id FROM conversation_segment_pages").get())
      .toEqual({ pending_reply_id: create.id });
  });

  it("admits Feishu input without rendering or reserving a Turn Card before canonical evidence", async () => {
    const stores = createTestStoreBundle();
    const core: AgentInputCorePort = {
      async capabilities() { return { agentInputSubmissionV2: true, agentInputSubmissionV3: true }; },
      async submit(input) { return { outcome: "receipt", receipt: { submissionId: input.submissionId, paneId: input.paneId, terminalId: input.terminalId, agentKind: input.agentKind, sessionId: input.sessionId, state: "prepared", turnId: null, startedAt: null, terminalState: null, createdAt: 1, updatedAt: 1 } }; },
      async queryReceipt() { return { outcome: "absent" }; }
    };
    const workflow = new AgentInputWorkflow({
      store: stores.agentInputs,
      drainer: new AgentInputDrainer({ store: stores.agentInputs, core, now: () => "2026-10-04T07:00:01.000Z" }),
      capability: { snapshot: () => ({ required: true, detected: true, supported: true, ready: true, error: null }) },
      idFactory: () => "submission-canonical-only",
      now: () => "2026-10-04T07:00:00.000Z"
    });
    await workflow.submit(request());
    expect(stores.agentInputs.get("submission-canonical-only")).toMatchObject({
      submissionId: "submission-canonical-only",
      state: "prepared"
    });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segments").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_pages").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM input_card_views").get()).toEqual({ count: 0 });
  });

  it("fails closed before recording input when the required Core capability is unavailable", async () => {
    const stores = createTestStoreBundle();
    const submit = vi.fn<AgentInputCorePort["submit"]>();
    const workflow = new AgentInputWorkflow({
      store: stores.agentInputs,
      drainer: new AgentInputDrainer({ store: stores.agentInputs, core: {
        async capabilities() { return { agentInputSubmissionV2: false }; },
        submit,
        async queryReceipt() { return { outcome: "absent" }; }
      } }),
      capability: { snapshot: () => ({
        required: true, detected: true, supported: false, ready: false,
        error: "Herdr Core does not advertise agent_input_submission_v3"
      }) },
      idFactory: () => "must-not-be-recorded"
    });

    await expect(workflow.submit(request())).rejects.toThrow("Herdr Core does not advertise agent_input_submission_v3");
    expect(stores.agentInputs.get("must-not-be-recorded")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it("submits B independently while A remains uncertain at the Core effect boundary", async () => {
    const stores = createTestStoreBundle();
    let releaseA!: () => void;
    const holdA = new Promise<void>((resolve) => { releaseA = resolve; });
    const submit = vi.fn<AgentInputCorePort["submit"]>(async (input) => {
      if (input.submissionId === "submission-a") {
        await holdA;
        return { outcome: "uncertain", failure: { code: "transport_timeout", detail: null } };
      }
      return {
        outcome: "receipt",
        receipt: {
          submissionId: input.submissionId, paneId: input.paneId, terminalId: input.terminalId,
          agentKind: input.agentKind, sessionId: input.sessionId, state: "prepared", turnId: null,
          startedAt: null, terminalState: null, createdAt: 2, updatedAt: 2
        }
      };
    });
    const core: AgentInputCorePort = {
      async capabilities() { return { agentInputSubmissionV2: true, agentInputSubmissionV3: true }; },
      submit,
      async queryReceipt() { return { outcome: "absent" }; }
    };
    const ids = ["submission-a", "submission-b"];
    const workflow = new AgentInputWorkflow({
      store: stores.agentInputs,
      drainer: new AgentInputDrainer({ store: stores.agentInputs, core, now: () => "2026-10-04T06:20:01.000Z" }),
      capability: { snapshot: () => ({ required: true, detected: true, supported: true, ready: true, error: null }) },
      idFactory: () => ids.shift()!,
      now: () => "2026-10-04T06:20:00.000Z"
    });

    const a = workflow.submit(request());
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ submissionId: "submission-a" })));
    const b = workflow.submit({ ...request(), sourceMessageKey: "message-2", text: "B" });

    await expect(b).resolves.toMatchObject({ submissionId: "submission-b", state: "prepared" });
    expect(stores.agentInputs.get("submission-a")).toMatchObject({ state: "attempting" });
    releaseA();
    await expect(a).resolves.toMatchObject({ submissionId: "submission-a", state: "uncertain" });
  });
});

function request() {
  return {
    ingressSource: "feishu:primary",
    sourceMessageKey: "message-1",
    actor: { kind: "human" as const, id: "operator", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic", rootMessageId: "root" },
    text: "  /model gpt-x  ",
    owner: { kind: "primary" as const, id: "binding-1", generation: 1 },
    paneId: "w1:primary",
    terminalId: "terminal-1",
    expectedAgentKind: "traex" as const,
    expectedSessionId: "session-1"
  };
}
