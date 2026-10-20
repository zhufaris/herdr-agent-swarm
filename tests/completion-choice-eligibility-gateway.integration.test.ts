import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionChoiceEligibility } from "../src/runtime/completion-choice-eligibility.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import {
  CompletionChoiceEligibilityGateway,
  callCompletionChoiceEligibilityGateway,
  type CompletionChoiceEligibilityRequest
} from "../src/runtime/completion-choice-eligibility-gateway.js";
import { COMPLETION_CHOICE_REPAIR_REASON } from "../src/runtime/completion-choice-hook.js";
import { runCompletionChoiceHook, runCompletionChoiceStopHook } from "../src/cli/completion-choice-stop-hook.js";

const gateways: CompletionChoiceEligibilityGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
});

async function socketPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "choice-eligibility-")), "gateway.sock");
}

const request: CompletionChoiceEligibilityRequest = { paneId: "workspace:pane" };

describe("CompletionChoiceEligibilityGateway", () => {
  it("serves a bounded identity-only request over a private socket", async () => {
    const path = await socketPath();
    const eligibility = { isEligible: vi.fn().mockResolvedValue(true) };
    const gateway = new CompletionChoiceEligibilityGateway(path, eligibility, pino({ enabled: false }));
    gateways.push(gateway);
    await gateway.start();

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(callCompletionChoiceEligibilityGateway(path, request, { timeoutMs: 250 })).resolves.toBe(true);
    await expect(runCompletionChoiceStopHook(JSON.stringify({
      last_assistant_message: "请选择方案 1、2 或 3；回复 default 即选择方案 1。",
      stop_hook_active: false
    }), path, {
      HERDR_ENV: "1", HERDR_PANE_ID: request.paneId, HERDR_BRIDGE_BINDING_ID: "binding",
      HERDR_BRIDGE_GENERATION: "2", HERDR_PROJECT_ID: "project"
    })).resolves.toEqual({
      decision: "block",
      reason: COMPLETION_CHOICE_REPAIR_REASON
    });
    expect(eligibility.isEligible).toHaveBeenCalledWith({ paneId: request.paneId });
    expect(JSON.stringify(eligibility.isEligible.mock.calls)).not.toContain("assistant");
  });

  it("activates inline mode without forwarding the submitted prompt to the eligibility socket", async () => {
    const path = await socketPath();
    const eligibility = { isEligible: vi.fn().mockResolvedValue(true) };
    const gateway = new CompletionChoiceEligibilityGateway(path, eligibility, pino({ enabled: false }));
    gateways.push(gateway);
    await gateway.start();

    await expect(runCompletionChoiceHook(JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "Do not send this prompt to the eligibility socket."
    }), path, {
      HERDR_ENV: "1", HERDR_PANE_ID: request.paneId, HERDR_BRIDGE_BINDING_ID: "binding",
      HERDR_BRIDGE_GENERATION: "2", HERDR_PROJECT_ID: "project"
    })).resolves.toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining("$herdr-choice-list:herdr-choice-list")
      }
    });
    expect(eligibility.isEligible).toHaveBeenCalledWith({ paneId: request.paneId });
    expect(JSON.stringify(eligibility.isEligible.mock.calls)).not.toContain("Do not send");
  });

  it("ignores legacy owner fields and rejects malformed or oversized frames", async () => {
    const path = await socketPath();
    const eligibility = { isEligible: vi.fn().mockResolvedValue(true) };
    const gateway = new CompletionChoiceEligibilityGateway(path, eligibility, pino({ enabled: false }), { idleTimeoutMs: 50, maxRequestBytes: 512 });
    gateways.push(gateway);
    await gateway.start();

    await expect(rawCall(path, `${JSON.stringify({ ...request, ownerId: "other", generation: 99, projectId: "other" })}\n`)).resolves.toMatchObject({ eligible: true });
    await expect(rawCall(path, `${JSON.stringify({ ownerId: "other", generation: 99, projectId: "other" })}\n`)).resolves.toMatchObject({ eligible: false });
    await expect(rawCall(path, `${"x".repeat(513)}\n`)).resolves.toBeNull();
    expect(eligibility.isEligible).toHaveBeenCalledTimes(1);
    expect(eligibility.isEligible).toHaveBeenCalledWith(request);
  });

  it("times out fail-open and removes its socket during graceful shutdown", async () => {
    const path = await socketPath();
    const gateway = new CompletionChoiceEligibilityGateway(path, { isEligible: () => new Promise<boolean>(() => undefined) }, pino({ enabled: false }), { idleTimeoutMs: 50 });
    gateways.push(gateway);
    await gateway.start();

    await expect(callCompletionChoiceEligibilityGateway(path, request, { timeoutMs: 20 })).resolves.toBe(false);
    await gateway.stop();
    gateways.splice(gateways.indexOf(gateway), 1);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(callCompletionChoiceEligibilityGateway(path, request, { timeoutMs: 20 })).resolves.toBe(false);
  });

  it("rolls back a failed start so a later start can retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "choice-eligibility-retry-"));
    const missingDirectory = join(root, "missing");
    const path = join(missingDirectory, "gateway.sock");
    const gateway = new CompletionChoiceEligibilityGateway(path, { isEligible: vi.fn().mockResolvedValue(true) }, pino({ enabled: false }));
    gateways.push(gateway);

    await expect(gateway.start()).rejects.toBeDefined();
    await mkdir(missingDirectory);
    await gateway.start();
    await expect(callCompletionChoiceEligibilityGateway(path, request, { timeoutMs: 250 })).resolves.toBe(true);
  });

  it("coalesces concurrent eligibility probes for the same pane", async () => {
    const path = await socketPath();
    let resolveEligibility: ((value: boolean) => void) | undefined;
    const eligibility = { isEligible: vi.fn(() => new Promise<boolean>((resolve) => { resolveEligibility = resolve; })) };
    const gateway = new CompletionChoiceEligibilityGateway(path, eligibility, pino({ enabled: false }));
    gateways.push(gateway);
    await gateway.start();

    const first = callCompletionChoiceEligibilityGateway(path, request, { timeoutMs: 250 });
    const second = callCompletionChoiceEligibilityGateway(path, request, { timeoutMs: 250 });
    await vi.waitFor(() => expect(eligibility.isEligible).toHaveBeenCalledTimes(1));
    resolveEligibility!(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(eligibility.isEligible).toHaveBeenCalledWith({ paneId: request.paneId });
  });

  it("probes different panes independently", async () => {
    const path = await socketPath();
    const eligibility = { isEligible: vi.fn().mockResolvedValue(true) };
    const gateway = new CompletionChoiceEligibilityGateway(path, eligibility, pino({ enabled: false }));
    gateways.push(gateway);
    await gateway.start();

    await expect(Promise.all([
      callCompletionChoiceEligibilityGateway(path, { paneId: "workspace:first" }, { timeoutMs: 250 }),
      callCompletionChoiceEligibilityGateway(path, { paneId: "workspace:second" }, { timeoutMs: 250 })
    ])).resolves.toEqual([true, true]);
    expect(eligibility.isEligible).toHaveBeenCalledTimes(2);
    expect(eligibility.isEligible).toHaveBeenCalledWith({ paneId: "workspace:first" });
    expect(eligibility.isEligible).toHaveBeenCalledWith({ paneId: "workspace:second" });
  });

  it("allows a later probe after a timed-out probe", async () => {
    const path = await socketPath();
    const eligibility = { isEligible: vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(() => undefined))
      .mockResolvedValueOnce(true) };
    const gateway = new CompletionChoiceEligibilityGateway(path, eligibility, pino({ enabled: false }), { eligibilityTimeoutMs: 20 });
    gateways.push(gateway);
    await gateway.start();

    await expect(callCompletionChoiceEligibilityGateway(path, request, { timeoutMs: 250 })).resolves.toBe(false);
    await expect(callCompletionChoiceEligibilityGateway(path, request, { timeoutMs: 250 })).resolves.toBe(true);
    expect(eligibility.isEligible).toHaveBeenCalledTimes(2);
  });

  it("carries a Pane-only eligible attached Primary through Hook, durable Choice, and one inline final card", async () => {
    const fixture = await createAttachedPrimaryFixture({ creatorOpenId: "ou_attacher", ingressSource: "feishu", actorOpenId: "ou_prompt" });
    try {
      await expect(runCompletionChoiceHook(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Choose the next action." }), fixture.path, {
        HERDR_ENV: "1", HERDR_PANE_ID: fixture.paneId
      })).resolves.toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining("$herdr-choice-list") } });

      const actions = completePrimaryChoice(fixture.store, fixture.promptId)!;
      expect(actions).toMatchObject({ state: "available", mentionOpenId: "ou_prompt" });
      expect(fixture.store.database.prepare("SELECT COUNT(*) AS count FROM completion_action_sets WHERE owner_kind = 'primary-prompt' AND owner_id = ? AND state = 'available'").get(fixture.promptId)).toEqual({ count: 1 });
      expect(fixture.store.reserveFinalAnswerCardUpdate({ promptId: fixture.promptId, pageIndex: 0, cardId: "answer-card", messageId: "answer-message", card: { actionSetId: actions.id } })).toBe("reserved");
      const finalCard = fixture.store.listPendingOutboundReplies().find(({ promptId, kind }) => promptId === fixture.promptId && kind === "card_update")!;
      expect(fixture.store.markOutboundReplyDelivered(finalCard.id, "answer-message", "answer-card")).toBe(true);
      expect(fixture.store.markOutboundReplyDelivered(finalCard.id, "answer-message", "answer-card")).toBe(false);
      expect(fixture.store.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("primary-next-input:"))).toHaveLength(0);
      expect(fixture.store.database.prepare(`SELECT state,notification_reply_id FROM completion_notification_obligations
        WHERE owner_kind='primary-prompt' AND owner_id=?`).get(fixture.promptId)).toEqual({ state: "suppressed", notification_reply_id: null });
      expect(fixture.store.database.prepare("SELECT state FROM completion_action_sets WHERE id=?").get(actions.id)).toEqual({ state: "available" });
    } finally {
      fixture.store.close();
    }
  });

  it("keeps a Pane-only eligible Answer when no trusted review actor exists without actions or mention", async () => {
    const fixture = await createAttachedPrimaryFixture({ creatorOpenId: null, ingressSource: "internal", actorOpenId: "system:actor" });
    try {
      await expect(runCompletionChoiceHook(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Choose the next action." }), fixture.path, {
        HERDR_ENV: "1", HERDR_PANE_ID: fixture.paneId
      })).resolves.toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining("$herdr-choice-list") } });

      expect(completePrimaryChoice(fixture.store, fixture.promptId)).toBeNull();
      expect(fixture.store.loadRunCard(fixture.promptId)).toMatchObject({ phase: "completed", answer: "Completed." });
      expect(fixture.store.database.prepare("SELECT COUNT(*) AS count FROM completion_action_sets WHERE owner_kind = 'primary-prompt' AND owner_id = ? AND state = 'available'").get(fixture.promptId)).toEqual({ count: 0 });
      expect(fixture.store.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("primary-next-input:"))).toHaveLength(0);
    } finally {
      fixture.store.close();
    }
  });
});

async function createAttachedPrimaryFixture(input: { creatorOpenId: string | null; ingressSource: "feishu" | "internal"; actorOpenId: string }) {
  const store = new SqliteBindingStore(":memory:");
  const paneId = "workspace:pane";
  const promptId = `prompt-${input.actorOpenId.replace(/[^a-z]/g, "") || "none"}`;
  store.createPendingBinding({ id: "binding", projectId: "project", workspaceId: "workspace", chatId: "chat", topicId: `topic-${promptId}`, rootMessageId: `root-${promptId}`, title: "Attached", creatorOpenId: input.creatorOpenId });
  store.updateBinding("binding", { paneId, traexSessionId: "terminal", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working" });
  const view = createQueuedRunCard({ promptId, bindingId: "binding", bindingGeneration: 1, title: "Choose", workspaceId: "workspace", paneId, requestText: "Choose the next action.", queuePosition: 1, occurredAt: "2026-10-07T00:00:00.000Z" });
  store.acceptPrompt({ prompt: { id: promptId, bindingId: "binding", larkMessageId: `message-${promptId}`, ingressSource: input.ingressSource, actorOpenId: input.actorOpenId, body: view.requestText }, view, rootMessageId: `root-${promptId}`, answerCard: {} });
  store.updatePrompt(promptId, "submitted");
  const path = await socketPath();
  const eligibility = new CompletionChoiceEligibility(store.capabilityModules().instance, {
    inspectPane: async () => ({ paneId, workspaceId: "workspace", cwd: "/repo", label: "pre-existing", agentState: "working", agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session" }, foregroundExecutables: ["traex"] })
  });
  const gateway = new CompletionChoiceEligibilityGateway(path, eligibility, pino({ enabled: false }));
  gateways.push(gateway);
  await gateway.start();
  return { store, paneId, promptId, path };
}

function completePrimaryChoice(store: SqliteBindingStore, promptId: string) {
  const create = store.listPendingOutboundReplies().find(({ promptId: candidate, kind }) => candidate === promptId && kind === "stream_card_create")!;
  store.markOutboundReplyDelivered(create.id, "answer-message", "answer-card");
  store.updatePrompt(promptId, "running");
  store.completeTurn({ promptId, bindingId: "binding", answer: "Completed.\n\n```herdr-choice-list\n{\"version\":2,\"intent\":\"human_review\",\"question\":\"是否继续？\",\"default\":\"yes\",\"options\":[{\"id\":\"yes\",\"label\":\"继续\",\"message\":\"default\"}]}\n```", occurredAt: "2026-10-07T00:00:01.000Z", outputFingerprint: `choice-${promptId}` });
  return store.preparePrimaryCompletionActionSet({ promptId, pageIndex: 0, cardId: "answer-card", messageId: "answer-message" });
}

function rawCall(path: string, frame: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let output = "";
    const timer = setTimeout(() => { socket.destroy(); resolve(null); }, 200);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(frame));
    socket.on("data", (chunk) => { output += chunk; });
    socket.once("error", () => { clearTimeout(timer); resolve(null); });
    socket.once("close", () => {
      clearTimeout(timer);
      try { resolve(output ? JSON.parse(output) as Record<string, unknown> : null); }
      catch { resolve(null); }
    });
  });
}
