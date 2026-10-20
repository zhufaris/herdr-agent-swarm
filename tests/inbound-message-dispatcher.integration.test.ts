import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { DurableInboundPipeline } from "../src/coordinator/durable-inbound-pipeline.js";
import { InboundMessageRoutingWorkflow } from "../src/coordinator/inbound-message-routing-workflow.js";
import type { BindingProvisioningWorkflowPort } from "../src/coordinator/binding-provisioning-workflow.js";
import type { SwarmCommandRuntime } from "../src/coordinator/swarm-command-gateway.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { InProcessInboundWorkNotifier } from "../src/events/inbound-work-notifier.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";
import { primaryPresentation } from "./helpers/presentation.js";

describe("DurableInboundPipeline durable FIFO", () => {
  it("deduplicates durable ingress latency correlation before submission admission", async () => {
    const stores = createTestStoreBundle();
    const route = vi.fn(async () => ({ decision: "agent-input", disposition: "agent_input_accepted" as const, submissionId: "submission-dedupe" }));
    const pipeline = new DurableInboundPipeline({
      chatId: "chat", allowedOpenIds: ["operator"], store: stores.inboundDispatch, router: { route },
      inboundWork: new InProcessInboundWorkNotifier(), logger: pino({ enabled: false }), deliveryTrace: stores.driver.capabilityModules().deliveryTrace
    });
    pipeline.start();
    try {
      const input = message("dedupe", "CANARY_PRIVATE_INGRESS_BODY");
      await pipeline.receive(input);
      await pipeline.receive(input);
      await vi.waitFor(() => expect(route).toHaveBeenCalledOnce());
      expect(stores.driver.capabilityModules().deliveryTrace.snapshot()).toMatchObject({ traces: 1, completed: 0 });
      expect(JSON.stringify(stores.driver.capabilityModules().deliveryTrace.snapshot())).not.toContain("CANARY_PRIVATE_INGRESS_BODY");
    } finally { await pipeline.stop(); stores.driver.close(); }
  });

  it("durably defers a capacity-blocked scope without blocking another scope", async () => {
    const stores = createTestStoreBundle();
    const inspection = stores.driver;
    const routed: string[] = [];
    let capacityAvailable = false;
    const router = { route: vi.fn(async (input: ReturnType<typeof message>) => {
      routed.push(input.eventId);
      if (input.eventId === "a-first" && !capacityAvailable) return { decision: "prompt", disposition: "deferred" as const };
      return { decision: "test", disposition: "command_completed" as const };
    }) };
    const records: Array<Record<string, unknown>> = [];
    const logger = pino({ level: "trace" }, { write(chunk: string) { records.push(JSON.parse(chunk) as Record<string, unknown>); } });
    const pipeline = new DurableInboundPipeline({ chatId: "chat", allowedOpenIds: ["operator"], store: stores.inboundDispatch, router, inboundWork: new InProcessInboundWorkNotifier(), logger });
    try {
      stores.inboundDispatch.recordInboundMessage({ ...message("a-first", "one"), rootMessageId: "scope-a" });
      stores.inboundDispatch.recordInboundMessage({ ...message("a-second", "two"), rootMessageId: "scope-a" });
      stores.inboundDispatch.recordInboundMessage({ ...message("b-first", "independent"), rootMessageId: "scope-b" });

      pipeline.start();

      await vi.waitFor(() => expect(inspection.database.prepare("SELECT state FROM inbound_messages WHERE event_id = 'b-first'").get()).toEqual({ state: "accepted" }));
      expect(routed).toContain("a-first");
      expect(routed).toContain("b-first");
      expect(routed).not.toContain("a-second");
      expect(inspection.database.prepare("SELECT event_id, state, error FROM inbound_messages ORDER BY event_id").all()).toEqual([
        { event_id: "a-first", state: "received", error: null },
        { event_id: "a-second", state: "received", error: null },
        { event_id: "b-first", state: "accepted", error: null }
      ]);
      expect(pipeline.snapshot()).toMatchObject({ state: "retry_wait", retryAttempt: 1, lastFailureAt: null, lastFailure: null });
      expect(records.filter(({ level }) => level === 50 || level === 40)).toEqual([]);

      capacityAvailable = true;
      await vi.waitFor(() => expect(inspection.database.prepare("SELECT event_id, state FROM inbound_messages WHERE scope_key = ? ORDER BY created_at, event_id").all("root:scope-a")).toEqual([
        { event_id: "a-first", state: "accepted" },
        { event_id: "a-second", state: "accepted" }
      ]), { timeout: 1_000 });
      expect(routed.lastIndexOf("a-first")).toBeLessThan(routed.indexOf("a-second"));
      expect(routed.filter((eventId) => eventId === "a-second")).toHaveLength(1);
      expect(routed.filter((eventId) => eventId === "b-first")).toHaveLength(1);
      expect(pipeline.snapshot()).toMatchObject({ lastFailureAt: null, lastFailure: null });
    } finally { await pipeline.stop(); inspection.close(); }
  });

  it("routes an independent scope while another Core submission is in flight", async () => {
    const stores = createTestStoreBundle();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started: string[] = [];
    const router = { route: vi.fn(async (input: ReturnType<typeof message>) => {
      started.push(input.eventId);
      if (input.eventId === "a-first") await firstBlocked;
      return { decision: "agent-input", disposition: "agent_input_accepted" as const, submissionId: `submission-${input.eventId}` };
    }) };
    const pipeline = new DurableInboundPipeline({
      chatId: "chat", allowedOpenIds: ["operator"], store: stores.inboundDispatch, router,
      inboundWork: new InProcessInboundWorkNotifier(), logger: pino({ enabled: false })
    });
    stores.inboundDispatch.recordInboundMessage({ ...message("a-first", "first"), rootMessageId: "scope-a" });
    stores.inboundDispatch.recordInboundMessage({ ...message("a-second", "second"), rootMessageId: "scope-a" });
    stores.inboundDispatch.recordInboundMessage({ ...message("b-first", "independent"), rootMessageId: "scope-b" });
    pipeline.start();
    try {
      await vi.waitFor(() => expect(stores.driver.database.prepare("SELECT state FROM inbound_messages WHERE event_id='b-first'").get()).toEqual({ state: "accepted" }));
      expect(started).toContain("a-first");
      expect(started).toContain("b-first");
      expect(started).not.toContain("a-second");
      expect(stores.driver.database.prepare("SELECT state FROM inbound_messages WHERE event_id='a-first'").get()).toEqual({ state: "processing" });
      releaseFirst();
      await vi.waitFor(() => expect(stores.driver.database.prepare("SELECT event_id,state FROM inbound_messages WHERE scope_key='root:scope-a' ORDER BY created_at,event_id").all()).toEqual([
        { event_id: "a-first", state: "accepted" },
        { event_id: "a-second", state: "accepted" }
      ]));
      expect(started.indexOf("a-first")).toBeLessThan(started.indexOf("a-second"));
    } finally {
      releaseFirst(); await pipeline.stop(); stores.driver.close();
    }
  });

  it("loads the compact oversized marker from SQLite and terminally accepts its route", async () => {
    const stores = createTestStoreBundle();
    const inboundWork = new InProcessInboundWorkNotifier();
    const route = vi.fn(async () => ({ decision: "input-too-large", disposition: "rejected" as const }));
    const pipeline = new DurableInboundPipeline({ chatId: "chat", allowedOpenIds: ["operator"], store: stores.inboundDispatch, router: { route }, inboundWork, logger: pino({ enabled: false }) });
    try {
      pipeline.start();
      await pipeline.receive(message("oversized", "x".repeat(12_001)));
      await vi.waitFor(() => expect(route).toHaveBeenCalledWith(expect.objectContaining({ eventId: "oversized", text: "", inputTooLarge: true })));
      const row = stores.driver.database.prepare("SELECT payload_json, state FROM inbound_messages WHERE event_id = ?").get("oversized") as { payload_json: string; state: string };
      expect(JSON.parse(row.payload_json)).toMatchObject({ text: "", inputTooLarge: true });
      expect(row.state).toBe("accepted");
    } finally { await pipeline.stop(); stores.driver.close(); }
  });

  it("submits bound Primary Agent Input even while the legacy Prompt capacity is full", async () => {
    const source = { ...message("independent-input", "continue independently"), rootMessageId: "scope-active" };
    const stores = createTestStoreBundle();
    stores.driver.createPendingBinding({ id: "binding-reopen", projectId: "default", workspaceId: "w1", chatId: "chat", topicId: null, rootMessageId: "scope-reopen", title: "Recovered Primary" });
    stores.driver.updateBinding("binding-reopen", {
      rootMessageId: "scope-active", paneId: "w1:p1", traexSessionId: "terminal-1",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1",
      state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working"
    });
    const capacityHolder = createQueuedRunCard({
      promptId: "capacity-holder", bindingId: "binding-reopen", bindingGeneration: 1,
      title: "holder", workspaceId: "w1", paneId: "w1:p1", requestText: "holder",
      queuePosition: 1, occurredAt: "2026-10-02T01:00:00.000Z"
    });
    stores.driver.acceptPrompt({
      prompt: { id: capacityHolder.promptId, bindingId: capacityHolder.bindingId, larkMessageId: "capacity-holder-message", ingressSource: "feishu", actorOpenId: "operator", body: "holder" },
      view: capacityHolder, rootMessageId: "scope-active", answerCard: {}
    });
    stores.inboundDispatch.recordInboundMessage(source);
    const logger = pino({ enabled: false });
    const notUsed = async (): Promise<never> => { throw new Error("not used by active Binding routing"); };
    const provisioning: BindingProvisioningWorkflowPort = {
      selectProject: notUsed, provisionDefaultProject: notUsed, ensureOrchestrator: notUsed,
      shareOrchestratorThread: notUsed, completeSelection: notUsed, attach: notUsed,
      reset: notUsed, reattach: notUsed, replace: notUsed, discover: notUsed, recover: notUsed
    };
    const agentInput = { submit: vi.fn(async () => ({ outcome: "accepted" as const, submissionId: "submission-1", state: "prepared" as const })) };
    const router = new InboundMessageRoutingWorkflow({
      config: capacityDeferralConfig(),
      routing: stores.inboundRouting,
      promptAdmission: { accept: notUsed, acceptInitial: notUsed },
      agentInput,
      outbound: { enqueueCard: notUsed },
      logger,
      presentation: primaryPresentation,
      provisioning,
      swarmCommands: { submit: notUsed } satisfies Pick<SwarmCommandRuntime, "submit">
    });
    const pipeline = new DurableInboundPipeline({ chatId: "chat", allowedOpenIds: ["operator"], store: stores.inboundDispatch, router, inboundWork: new InProcessInboundWorkNotifier(), logger });
    pipeline.start();
    try {
      await vi.waitFor(() => expect(stores.driver.database.prepare("SELECT state, error FROM inbound_messages WHERE event_id = ?").get(source.eventId)).toEqual({ state: "accepted", error: null }));
      expect(agentInput.submit).toHaveBeenCalledWith(expect.objectContaining({
        sourceMessageKey: source.messageId,
        text: source.text,
        owner: { kind: "primary", id: "binding-reopen", generation: 1 }
      }));
      expect(stores.driver.getPromptInputBySource("feishu", source.messageId)).toBeNull();
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM prompt_inputs").get()).toEqual({ count: 0 });
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM native_input_batches").get()).toEqual({ count: 0 });
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual({ count: 1 });
    } finally {
      await pipeline.stop(); stores.driver.close();
    }
  });

  it("continues an independent scope when an earlier scope is retryable", async () => {
    const stores = createTestStoreBundle();
    const accepted: string[] = [];
    const router = { route: vi.fn(async (input: ReturnType<typeof message>) => {
      if (input.eventId === "a-stopped-worker") throw new Error("Target instance is not running");
      accepted.push(input.eventId); return { decision: "test", disposition: "command_completed" as const };
    }) };
    const pipeline = new DurableInboundPipeline({ chatId: "chat", allowedOpenIds: ["operator"], store: stores.inboundDispatch, router, inboundWork: new InProcessInboundWorkNotifier(), logger: pino({ enabled: false }) });
    try {
      stores.inboundDispatch.recordInboundMessage({ ...message("a-stopped-worker", "hi"), rootMessageId: "stopped-worker-root" });
      stores.inboundDispatch.recordInboundMessage({ ...message("b-later-stopped-worker", "later"), rootMessageId: "stopped-worker-root" });
      stores.inboundDispatch.recordInboundMessage({ ...message("z-new", "/swarm new"), rootMessageId: "new-root" });
      pipeline.start();
      await vi.waitFor(() => expect(accepted).toEqual(["z-new"]));
      expect(stores.driver.database.prepare("SELECT event_id, state, error FROM inbound_messages ORDER BY event_id").all()).toEqual([
        { event_id: "a-stopped-worker", state: "received", error: "Target instance is not running" },
        { event_id: "b-later-stopped-worker", state: "received", error: null },
        { event_id: "z-new", state: "accepted", error: null }
      ]);
      await vi.waitFor(() => expect(pipeline.snapshot()).toMatchObject({ state: "retry_wait", retryAttempt: 1 }));
    } finally { await pipeline.stop(); stores.driver.close(); }
  });

  it("accepts a durable rejection result and continues the FIFO", async () => {
    const stores = createTestStoreBundle();
    const routed: string[] = [];
    const router = { route: vi.fn(async (input: ReturnType<typeof message>) => { routed.push(input.eventId); return { decision: "test", disposition: input.eventId === "rejected" ? "rejected" as const : "command_completed" as const }; }) };
    const pipeline = new DurableInboundPipeline({ chatId: "chat", allowedOpenIds: ["operator"], store: stores.inboundDispatch, router, inboundWork: new InProcessInboundWorkNotifier(), logger: pino({ enabled: false }) });
    try {
      stores.inboundDispatch.recordInboundMessage(message("rejected", "bad target"));
      stores.inboundDispatch.recordInboundMessage(message("next", "/instances"));
      pipeline.start();
      await vi.waitFor(() => expect(routed).toHaveLength(2));
      expect(new Set(routed)).toEqual(new Set(["next", "rejected"]));
      expect(stores.driver.database.prepare("SELECT state FROM inbound_messages ORDER BY event_id").all()).toEqual([{ state: "accepted" }, { state: "accepted" }]);
    } finally { await pipeline.stop(); stores.driver.close(); }
  });

  it("waits for an executing route during shutdown and leaves no processing row", async () => {
    const stores = createTestStoreBundle();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const pipeline = new DurableInboundPipeline({ chatId: "chat", allowedOpenIds: ["operator"], store: stores.inboundDispatch, router: { route: async () => { await blocked; return { decision: "test", disposition: "command_completed" as const }; } }, inboundWork: new InProcessInboundWorkNotifier(), logger: pino({ enabled: false }) });
    pipeline.start();
    const receiving = pipeline.receive(message("shutdown", "work"));
    await vi.waitFor(() => expect(stores.driver.database.prepare("SELECT state FROM inbound_messages WHERE event_id = 'shutdown'").get()).toEqual({ state: "processing" }));
    let stopped = false; const stopping = pipeline.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve)); expect(stopped).toBe(false);
    release(); await receiving; await stopping;
    expect(stores.driver.database.prepare("SELECT state FROM inbound_messages WHERE event_id = 'shutdown'").get()).toEqual({ state: "accepted" });
    stores.driver.close();
  });
});

function message(eventId: string, text: string) {
  return { eventId, messageId: `${eventId}-message`, parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: null, actorOpenId: "operator", text, mentionsBot: false, isRootMessage: true };
}
function capacityDeferralConfig(): Pick<BridgeConfig, "lark" | "projects" | "defaultProjectId" | "maxQueueDepth"> {
  return {
    lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", requestTimeoutMs: 1_000, allowedOpenIds: ["operator"], adminOpenIds: ["operator"] },
    projects: [{ id: "default", displayName: "Default", description: "Default project", workspaceId: "w1", cwd: "/repo" }],
    defaultProjectId: "default",
    maxQueueDepth: 1
  };
}
