import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CoreEventEnvelope } from "../src/domain/core-event-inbox.js";
import type { SessionActivityProjectionContext } from "../src/domain/session-activity.js";
import { SqliteCapabilityGraph } from "../src/store/sqlite/capability-graph.js";
import { SqliteContext } from "../src/store/sqlite/context.js";
import { initialTopicView, updateTopicView } from "../src/domain/topic-view.js";
import { createWorkerMainView } from "../src/domain/worker-main-view.js";
import { prepareOutboundGatewayIntent } from "../src/events/outbound-gateway-intent.js";
import { translateMultiAgentToolLifecycle } from "../src/runtime/multi-agent-tool-lifecycle.js";
import { RETAINED_MULTI_AGENT_ACTIVITY_QUERY } from "../src/store/sqlite/session-activity-store.js";

function event(eventId: string, payload: Record<string, unknown>, turnId: string | null = "turn-1"): CoreEventEnvelope {
  return { schemaVersion: 1, eventId, cursor: `cursor:${eventId}`, sourceId: "ring-1", agentKind: "traex", sessionId: "session-1", turnId, occurredAt: "2026-10-08T00:00:00.000Z", payload };
}

function tokenUsagePayload(input: {
  responseTotal: number;
  turnTotal?: number;
  threadTotal?: number;
  modelContextWindow?: number;
  autoCompactLimit?: number;
}): Record<string, unknown> {
  const group = (totalTokens: number) => ({
    input_tokens: Math.max(totalTokens - 25, 0),
    cached_input_tokens: 10,
    cache_creation_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 5,
    total_tokens: totalTokens
  });
  return {
    type: "token_usage",
    response_id: "response-1",
    response: group(input.responseTotal),
    ...(input.turnTotal === undefined ? {} : { turn: group(input.turnTotal) }),
    ...(input.threadTotal === undefined ? {} : { thread: group(input.threadTotal) }),
    ...(input.modelContextWindow === undefined ? {} : { model_context_window: input.modelContextWindow }),
    ...(input.autoCompactLimit === undefined ? {} : { auto_compact_limit: input.autoCompactLimit })
  };
}

function contextSnapshotPayload(input: {
  model?: string;
  provider?: string;
  backendVariant?: string;
  effort?: string;
  cwd?: string;
  collaborationMode?: string;
  permissionMode?: string;
  currentDate?: string;
  timezone?: string;
  worktreePath?: string;
  worktreeState?: string;
  modelContextWindow?: number;
  autoCompactLimit?: number;
}): Record<string, unknown> {
  return {
    type: "context_snapshot",
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.backendVariant === undefined ? {} : { backend_variant: input.backendVariant }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.collaborationMode === undefined ? {} : { collaboration_mode: input.collaborationMode }),
    ...(input.permissionMode === undefined ? {} : { permission_mode: input.permissionMode }),
    ...(input.currentDate === undefined ? {} : { current_date: input.currentDate }),
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    ...(input.worktreePath === undefined ? {} : { worktree_path: input.worktreePath }),
    ...(input.worktreeState === undefined ? {} : { worktree_state: input.worktreeState }),
    ...(input.modelContextWindow === undefined ? {} : { model_context_window: input.modelContextWindow }),
    ...(input.autoCompactLimit === undefined ? {} : { auto_compact_limit: input.autoCompactLimit })
  };
}

function primaryContext(overrides: Partial<SessionActivityProjectionContext> = {}): SessionActivityProjectionContext {
  return {
    scope: { kind: "pane", workspaceId: "workspace-1", paneId: "primary-pane" },
    ownerFence: { kind: "primary", id: "binding-1", generation: 1, sessionGeneration: 1 },
    producer: { kind: "primary", id: "binding-1", runtimeGeneration: 1, sessionGeneration: 1, runtimePaneId: "primary-pane" },
    ...overrides
  };
}

function project(graph: SqliteCapabilityGraph, context: SessionActivityProjectionContext, laneSequence: number, item: CoreEventEnvelope) {
  return graph.sessionActivity.projectCanonicalEvent({
    context, laneId: "lane-1", laneSequence, sourceId: item.sourceId, sourceEpoch: "epoch-1",
    event: item, observedAt: "2026-10-08T00:00:01.000Z"
  });
}

function load(graph: SqliteCapabilityGraph, scope = primaryContext().scope, sessionEpoch = 1) {
  return graph.sessionActivity.load(scope, { bindingId: "binding-1", bindingGeneration: 1, sessionEpoch });
}

function activatePrimary(graph: SqliteCapabilityGraph): void {
  graph.bindings.createPendingBinding({ id: "binding-1", workspaceId: "workspace-1", chatId: "chat-1", topicId: "topic-1", rootMessageId: "root-1", title: "Primary" });
  graph.bindings.updateBinding("binding-1", {
    state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane",
    agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
  });
}

function connectPrepared(graph: SqliteCapabilityGraph): void {
  graph.outbox.setGatewayPlanPreparer((reply) => {
    const intent = prepareOutboundGatewayIntent(graph.outbox, reply).intent;
    return { protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1, operation: intent.kind, intent };
  });
  graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery() {} });
}

function activateWorker(context: SqliteContext): void {
  context.database.prepare(`INSERT INTO agent_instances(
    id,project_id,name,role,agent_kind,model,source_primary_pane_label,parent_binding_id,parent_binding_generation,parent_pane_id,parent_native_session_id,
    worker_session_lifecycle,worker_session_generation,desired_state,observed_state,workspace_lease_id,generation,herdr_workspace_id,pane_id,native_session_id,
    provisioning_checkpoint,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "worker-1", "project-1", "reviewer", "worker", "traex", null, null, "binding-1", 1, "primary-pane", "session-1",
    "active", 1, "running", "working", "lease-1", 1, "workspace-1", "worker-pane", "worker-session",
    "verified", "2026-10-08T00:00:00.000Z", "2026-10-08T00:00:00.000Z"
  );
}

function workerContext(overrides: Partial<SessionActivityProjectionContext> = {}): SessionActivityProjectionContext {
  return {
    scope: { kind: "pane", workspaceId: "workspace-1", paneId: "primary-pane" },
    ownerFence: { kind: "worker", id: "worker-1", generation: 1, sessionGeneration: 1, parent: { id: "binding-1", generation: 1, sessionGeneration: 1 } },
    producer: { kind: "worker", id: "worker-1", runtimeGeneration: 1, sessionGeneration: 1, runtimePaneId: "worker-pane" },
    ...overrides
  };
}

describe("Session Activity projection", () => {
  it("reports visible changes for displayed Session State facts", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const identity = primaryContext();

    expect(project(graph, identity, 1, event("model-only", { type: "model_changed", model: "GPT-5.6-Sol" }))).toEqual({ outcome: "projected", visibleChanged: true });
    expect(project(graph, identity, 1, event("model-only", { type: "model_changed", model: "GPT-5.6-Sol" }))).toEqual({ outcome: "duplicate", visibleChanged: false });
    expect(project(graph, identity, 1, event("same-sequence", { type: "model_changed", model: "stale" }))).toEqual({ outcome: "stale", visibleChanged: false });
    expect(project(graph, identity, 2, event("tool-only", { type: "tool_call", call_id: "call-1", name: "exec" }))).toEqual({ outcome: "projected", visibleChanged: false });
    expect(project(graph, identity, 3, event("ignored-message", { type: "message", channel: "commentary", text: "hidden" }))).toEqual({ outcome: "ignored", visibleChanged: false });
    expect(project(graph, identity, 4, event("agent-visible", { type: "agent_activity", agent_id: "reviewer", display_name: "Reviewer", model: "GPT-5.6-Sol", state: "running" }))).toEqual({ outcome: "projected", visibleChanged: true });
    expect(load(graph)?.items.find(({ itemId }) => itemId === "reviewer")?.label).toBe("Reviewer · GPT-5.6-Sol");
    expect(project(graph, identity, 5, event("compact-visible", { type: "context_compacted" }))).toEqual({ outcome: "projected", visibleChanged: true });
    context.close();
  });

  it("projects a successful multi-agent spawn Tool result as visible Subagent activity", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const call = event("spawn-call", {
      type: "tool_call",
      call_id: "call-spawn",
      name: "multi_agent_v1__spawn_agent",
      arguments: JSON.stringify({ agent_type: "explorer", model: "GPT-5.6-Terra", message: "private task" }),
      truncated: false
    });
    const result = event("spawn-result", {
      type: "tool_result",
      call_id: "call-spawn",
      text: JSON.stringify({
        agent_id: "01a124cd-f60f-7082-89f9-15e01e0ecad2",
        nickname: "Planck",
        execution: { total: 0, local_capacity: 0, provider_queue: 0, waiting_dependency: 0, waiting_approval: 0, items: [] }
      }),
      is_error: false,
      truncated: false
    });

    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-multi-agent", sourceId: call.sourceId, sourceEpoch: "epoch-1", agentKind: call.agentKind,
      sessionId: call.sessionId, sessionActivityContext: primaryContext(), afterCursor: "start",
      nextCursor: result.cursor, latestCursor: result.cursor, events: [call, result],
      ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");

    expect(load(graph)?.items).toContainEqual(expect.objectContaining({
      kind: "agent",
      itemId: "01a124cd-f60f-7082-89f9-15e01e0ecad2",
      label: "Planck · GPT-5.6-Terra",
      state: "started",
      terminal: false
    }));
    expect(JSON.stringify(load(graph))).not.toContain("private task");
    context.close();
  });

  it("projects the current collaboration tool names used by TraeX", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const ingest = (events: readonly CoreEventEnvelope[], afterCursor: string) => graph.coreEvents.ingestBatch({
      laneId: "lane-collaboration", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      sessionActivityContext: primaryContext(), afterCursor, nextCursor: events.at(-1)!.cursor, latestCursor: events.at(-1)!.cursor,
      events, ingestedAt: "2026-10-08T00:00:01.000Z"
    });
    const spawnCall = event("collaboration-spawn-call", {
      type: "tool_call", call_id: "collaboration-spawn", name: "collaboration__spawn_agent",
      arguments: JSON.stringify({ task_name: "worker_smoke_test", message: "private task" }), truncated: false
    });
    const spawnResult = event("collaboration-spawn-result", {
      type: "tool_result", call_id: "collaboration-spawn", text: JSON.stringify({ task_name: "/root/worker_smoke_test", nickname: "Halley" }),
      is_error: false, truncated: false
    });
    expect(ingest([spawnCall, spawnResult], "start")).toBe("accepted");
    expect(load(graph)?.items.find(({ kind, itemId }) => kind === "agent" && itemId === "/root/worker_smoke_test")).toMatchObject({
      label: "Halley", state: "started", terminal: false
    });

    const waitCall = event("collaboration-wait-call", {
      type: "tool_call", call_id: "collaboration-wait", name: "collaboration__wait_agent",
      arguments: JSON.stringify({ timeout_ms: 3_000 }), truncated: false
    });
    const waitResult = event("collaboration-wait-result", {
      type: "tool_result", call_id: "collaboration-wait", text: JSON.stringify({
        message: "Wait timed out.", timed_out: true,
        pending: { total: 1, provider_queue: 1, items: [{ target: "/root/worker_smoke_test", phase: "provider_queue", since_ms: 1_728_000_000_000, position: 1, operation: "model" }] },
        wake_reason: "timeout"
      }), is_error: false, truncated: false
    });
    expect(ingest([waitCall, waitResult], spawnResult.cursor)).toBe("accepted");
    expect(load(graph)?.items.find(({ kind, itemId }) => kind === "agent" && itemId === "/root/worker_smoke_test")).toMatchObject({ state: "started", terminal: false });

    const interruptCall = event("collaboration-interrupt-call", {
      type: "tool_call", call_id: "collaboration-interrupt", name: "collaboration__interrupt_agent",
      arguments: JSON.stringify({ target: "/root/worker_smoke_test" }), truncated: false
    });
    const interruptResult = event("collaboration-interrupt-result", {
      type: "tool_result", call_id: "collaboration-interrupt", text: JSON.stringify({ previous_status: "running" }),
      is_error: false, truncated: false
    });
    expect(ingest([interruptCall, interruptResult], waitResult.cursor)).toBe("accepted");
    expect(load(graph)?.items.find(({ kind, itemId }) => kind === "agent" && itemId === "/root/worker_smoke_test")).toMatchObject({ state: "interrupted", terminal: true });
    context.close();
  });

  it("advances exact multi-agent wait and close targets without replacing Tool activity", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const ingest = (events: readonly CoreEventEnvelope[], afterCursor: string) => graph.coreEvents.ingestBatch({
      laneId: "lane-multi-agent", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      sessionActivityContext: primaryContext(), afterCursor, nextCursor: events.at(-1)!.cursor, latestCursor: events.at(-1)!.cursor,
      events, ingestedAt: "2026-10-08T00:00:01.000Z"
    });
    const spawnCall = event("spawn-call", { type: "tool_call", call_id: "spawn", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({ model: "GPT-5.6-Terra" }), truncated: false });
    const spawnResult = event("spawn-result", { type: "tool_result", call_id: "spawn", text: JSON.stringify({ agent_id: "agent-a", nickname: "Planck" }), is_error: false, truncated: false });
    expect(ingest([spawnCall, spawnResult], "start")).toBe("accepted");
    const waitCall = event("wait-call", { type: "tool_call", call_id: "wait", name: "multi_agent_v1__wait_agent", arguments: JSON.stringify({ targets: ["agent-a"], timeout_ms: 30_000, return_on_activity: true }), truncated: false });
    const waitResult = event("wait-result", { type: "tool_result", call_id: "wait", text: JSON.stringify({ status: {}, timed_out: true, pending: { items: [{ target: "agent-a", phase: "model_running", since_ms: 1_728_000_000_000, operation: "run" }] }, wake_reason: "timeout" }), is_error: false, truncated: false });
    expect(ingest([waitCall, waitResult], spawnResult.cursor)).toBe("accepted");
    expect(load(graph)?.items.find(({ kind, itemId }) => kind === "agent" && itemId === "agent-a")).toMatchObject({ state: "running", terminal: false });
    expect(load(graph)?.items.find(({ kind, itemId }) => kind === "tool" && itemId === "wait")).toMatchObject({ state: "completed", terminal: true });

    const terminalCall = event("terminal-call", { type: "tool_call", call_id: "terminal", name: "multi_agent_v1__wait_agent", arguments: JSON.stringify({ targets: ["agent-a"], timeout_ms: 30_000 }), truncated: false });
    const terminalResult = event("terminal-result", { type: "tool_result", call_id: "terminal", text: JSON.stringify({ status: { "agent-a": { completed: "private final text" } }, timed_out: false, pending: { items: [] }, wake_reason: "terminal" }), is_error: false, truncated: false });
    expect(ingest([terminalCall, terminalResult], waitResult.cursor)).toBe("accepted");
    expect(JSON.stringify(load(graph))).not.toContain("private final text");
    const staleCall = event("stale-call", { type: "tool_call", call_id: "stale", name: "multi_agent_v1__wait_agent", arguments: JSON.stringify({ targets: ["agent-a"], timeout_ms: 30_000 }), truncated: false });
    const staleResult = event("stale-result", { type: "tool_result", call_id: "stale", text: JSON.stringify({ status: {}, timed_out: true, pending: { items: [{ target: "agent-a", phase: "tool_running", since_ms: 1_728_000_000_001, operation: "run" }] }, wake_reason: "timeout" }), is_error: false, truncated: false });
    expect(ingest([staleCall, staleResult], terminalResult.cursor)).toBe("accepted");
    expect(load(graph)?.items.find(({ kind, itemId }) => kind === "agent" && itemId === "agent-a")).toMatchObject({ state: "completed", terminal: true });
    expect(load(graph)?.items.filter(({ kind, itemId }) => kind === "agent" && itemId === "agent-a")).toHaveLength(1);

    const preserveCall = event("preserve-call", { type: "tool_call", call_id: "preserve", name: "multi_agent_v1__close_agent", arguments: JSON.stringify({ target: "agent-a" }), truncated: false });
    const preserveResult = event("preserve-result", { type: "tool_result", call_id: "preserve", text: JSON.stringify({ previous_status: { completed: "private close text" } }), is_error: false, truncated: false });
    expect(ingest([preserveCall, preserveResult], staleResult.cursor)).toBe("accepted");
    expect(load(graph)?.items.find(({ kind, itemId }) => kind === "agent" && itemId === "agent-a")).toMatchObject({ state: "completed", terminal: true });

    const closeCall = event("close-call", { type: "tool_call", call_id: "close", name: "multi_agent_v1__close_agent", arguments: JSON.stringify({ target: "agent-b" }), truncated: false });
    const closeResult = event("close-result", { type: "tool_result", call_id: "close", text: JSON.stringify({ previous_status: "running" }), is_error: false, truncated: false });
    expect(ingest([closeCall, closeResult], preserveResult.cursor)).toBe("accepted");
    expect(load(graph)?.items.find(({ kind, itemId }) => kind === "agent" && itemId === "agent-b")).toMatchObject({ state: "interrupted", terminal: true });
    context.close();
  });

  it("retains a pruned Subagent name and model when sparse terminal evidence makes it visible again", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const agentId = "01a12717-dd35-7e53-830a-5e7b060cafb1";
    const calls = Array.from({ length: 15 }, (_, index) => event(`spawn-call-${index}`, {
      type: "tool_call",
      call_id: `spawn-${index}`,
      name: "multi_agent_v1__spawn_agent",
      arguments: JSON.stringify({ model: "GPT-5.6-Luna" }),
      truncated: false
    }));
    const results = Array.from({ length: 15 }, (_, index) => event(`spawn-result-${index}`, {
      type: "tool_result",
      call_id: `spawn-${index}`,
      text: JSON.stringify({
        agent_id: index === 0 ? agentId : `agent-${index}`,
        nickname: index === 0 ? "Boyle" : `Agent ${index}`
      }),
      is_error: false,
      truncated: false
    }));
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-pruned-agent", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      sessionActivityContext: primaryContext(), afterCursor: "start", nextCursor: results.at(-1)!.cursor,
      latestCursor: results.at(-1)!.cursor, events: [...calls, ...results], ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");
    expect(load(graph)?.items.find(({ kind, itemId }) => kind === "agent" && itemId === agentId)).toBeUndefined();

    const closeCall = event("pruned-close-call", {
      type: "tool_call", call_id: "pruned-close", name: "multi_agent_v1__close_agent",
      arguments: JSON.stringify({ target: agentId }), truncated: false
    });
    const closeResult = event("pruned-close-result", {
      type: "tool_result", call_id: "pruned-close",
      text: JSON.stringify({ previous_status: { completed: "private result" } }), is_error: false, truncated: false
    });
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-pruned-agent", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      sessionActivityContext: primaryContext(), afterCursor: results.at(-1)!.cursor, nextCursor: closeResult.cursor,
      latestCursor: closeResult.cursor, events: [closeCall, closeResult], ingestedAt: "2026-10-08T00:00:02.000Z"
    })).toBe("accepted");

    expect(load(graph)?.items.find(({ kind, itemId }) => kind === "agent" && itemId === agentId)).toMatchObject({
      label: "Boyle · GPT-5.6-Luna", state: "completed", terminal: true
    });
    context.close();
  });

  it("reopens with pruned Subagent identity and keeps retained recovery idempotent", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-pruned-subagent-identity-"));
    const path = join(directory, "state.sqlite");
    const agentId = "01a12717-dd35-7e53-830a-5e7b060cafb1";
    const firstContext = new SqliteContext(path);
    const first = new SqliteCapabilityGraph(firstContext);
    activatePrimary(first);
    const calls = Array.from({ length: 9 }, (_, index) => event(`reopen-spawn-call-${index}`, {
      type: "tool_call", call_id: `reopen-spawn-${index}`, name: "multi_agent_v1__spawn_agent",
      arguments: JSON.stringify({ model: index === 0 ? "GPT-5.6-Luna" : "GPT-5.6-Sol" }), truncated: false
    }));
    const results = Array.from({ length: 9 }, (_, index) => event(`reopen-spawn-result-${index}`, {
      type: "tool_result", call_id: `reopen-spawn-${index}`,
      text: JSON.stringify({ agent_id: index === 0 ? agentId : `reopen-agent-${index}`, nickname: index === 0 ? "Boyle" : `Agent ${index}` }),
      is_error: false, truncated: false
    }));
    expect(first.coreEvents.ingestBatch({
      laneId: "lane-reopen-pruned", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      sessionActivityContext: primaryContext(), afterCursor: "start", nextCursor: results.at(-1)!.cursor,
      latestCursor: results.at(-1)!.cursor, events: [...calls, ...results], ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");
    expect(load(first)?.items.find(({ itemId }) => itemId === agentId)).toBeUndefined();
    firstContext.close();

    const secondContext = new SqliteContext(path);
    try {
      const second = new SqliteCapabilityGraph(secondContext);
      const closeCall = event("reopen-close-call", {
        type: "tool_call", call_id: "reopen-close", name: "multi_agent_v1__close_agent",
        arguments: JSON.stringify({ target: agentId }), truncated: false
      });
      const closeResult = event("reopen-close-result", {
        type: "tool_result", call_id: "reopen-close", text: JSON.stringify({ previous_status: { completed: "private" } }),
        is_error: false, truncated: false
      });
      expect(second.coreEvents.ingestBatch({
        laneId: "lane-reopen-pruned", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
        sessionActivityContext: primaryContext(), afterCursor: results.at(-1)!.cursor, nextCursor: closeResult.cursor,
        latestCursor: closeResult.cursor, events: [closeCall, closeResult], ingestedAt: "2026-10-08T00:00:02.000Z"
      })).toBe("accepted");
      expect(load(second)?.items.find(({ itemId }) => itemId === agentId)).toMatchObject({
        label: "Boyle · GPT-5.6-Luna", state: "completed", terminal: true
      });
      expect(second.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 100, observedAt: "2026-10-08T00:00:03.000Z" }))
        .toMatchObject({ recoveredAgents: 0, visibleChanged: false, remaining: false, nextCursor: null });
      expect(secondContext.database.prepare("SELECT COUNT(*) AS count FROM session_activity_agent_identities WHERE agent_id=?").get(agentId))
        .toEqual({ count: 1 });
    } finally {
      secondContext.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed, truncated, cross-session, and unsupported multi-agent evidence", () => {
    const call = event("call", { type: "tool_call", call_id: "call", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({ model: "GPT-5.6-Terra", message: "private task" }), truncated: false });
    const result = event("result", { type: "tool_result", call_id: "call", text: JSON.stringify({ agent_id: "agent-a", nickname: "Planck", result: "private result" }), is_error: false, truncated: false });
    expect(translateMultiAgentToolLifecycle(call, result)).toEqual([{ agentId: "agent-a", displayName: "Planck", model: "GPT-5.6-Terra", state: "started", terminal: false }]);
    expect(JSON.stringify(translateMultiAgentToolLifecycle(call, result))).not.toContain("private");
    expect(translateMultiAgentToolLifecycle({ ...call, sessionId: "other-session" }, result)).toEqual([]);
    expect(translateMultiAgentToolLifecycle({ ...call, payload: { ...call.payload, truncated: true } }, result)).toEqual([]);
    expect(translateMultiAgentToolLifecycle(call, { ...result, payload: { ...result.payload, text: "not-json" } })).toEqual([]);
    expect(translateMultiAgentToolLifecycle({ ...call, payload: { ...call.payload, name: "multi_agent_v1__send_input" } }, result)).toEqual([]);

    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const duplicateCall = event("duplicate-call", { type: "tool_call", call_id: "duplicate", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({ model: "GPT-5.6-Terra" }), truncated: false });
    const duplicateCallAgain = event("duplicate-call-again", { ...duplicateCall.payload });
    const duplicateResult = event("duplicate-result", { type: "tool_result", call_id: "duplicate", text: JSON.stringify({ agent_id: "must-not-project", nickname: "Nope" }), is_error: false, truncated: false });
    graph.coreEvents.ingestBatch({
      laneId: "lane-ambiguous", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      sessionActivityContext: primaryContext(), afterCursor: "start", nextCursor: duplicateResult.cursor, latestCursor: duplicateResult.cursor,
      events: [duplicateCall, duplicateCallAgain, duplicateResult], ingestedAt: "2026-10-08T00:00:01.000Z"
    });
    expect(load(graph)?.items.some(({ kind, itemId }) => kind === "agent" && itemId === "must-not-project")).toBe(false);
    context.close();
  });

  it("maps only exact wait targets to bounded production phases and terminal status objects", () => {
    const call = event("wait-call", { type: "tool_call", call_id: "wait", name: "multi_agent_v1__wait_agent", arguments: JSON.stringify({ targets: ["local", "provider", "awaiting", "model", "tool", "dependency", "approval"], timeout_ms: 30_000 }), truncated: false });
    const result = event("wait-result", {
      type: "tool_result", call_id: "wait", text: JSON.stringify({ status: {}, timed_out: true, pending: { items: [
        { target: "local", phase: "local_capacity", since_ms: 1, operation: "run" }, { target: "provider", phase: "provider_queue", since_ms: 1, operation: "run" },
        { target: "awaiting", phase: "awaiting_model", since_ms: 1, operation: "run" }, { target: "model", phase: "model_running", since_ms: 1, operation: "run" },
        { target: "tool", phase: "tool_running", since_ms: 1, operation: "run" }, { target: "dependency", phase: "waiting_dependency", since_ms: 1, operation: "run" },
        { target: "approval", phase: "waiting_approval", since_ms: 1, operation: "run" }, { target: "not-a-target", phase: "model_running", since_ms: 1, operation: "run" }
      ] }, wake_reason: "timeout" }), is_error: false, truncated: false
    });
    expect(translateMultiAgentToolLifecycle(call, result)).toEqual([
      { agentId: "local", state: "started", terminal: false }, { agentId: "provider", state: "started", terminal: false },
      { agentId: "awaiting", state: "running", terminal: false }, { agentId: "model", state: "running", terminal: false },
      { agentId: "tool", state: "running", terminal: false }, { agentId: "dependency", state: "blocked", terminal: false },
      { agentId: "approval", state: "blocked", terminal: false }
    ]);
    const terminal = event("wait-terminal", { type: "tool_result", call_id: "wait", text: JSON.stringify({ status: { local: { completed: "private final text" }, provider: { failed: "private error" }, "not-a-target": { interrupted: "private" } }, timed_out: false, pending: { items: [] }, wake_reason: "terminal" }), is_error: false, truncated: false });
    expect(translateMultiAgentToolLifecycle(call, terminal)).toEqual([
      { agentId: "local", state: "completed", terminal: true }, { agentId: "provider", state: "failed", terminal: true }
    ]);
    expect(JSON.stringify(translateMultiAgentToolLifecycle(call, terminal))).not.toContain("private");
    const malformedTerminal = event("wait-malformed-terminal", { type: "tool_result", call_id: "wait", text: JSON.stringify({ status: { local: { unknown: "private" } }, timed_out: false, pending: { items: [] }, wake_reason: "terminal" }), is_error: false, truncated: false });
    expect(translateMultiAgentToolLifecycle(call, malformedTerminal)).toEqual([]);

    const mixed = event("wait-mixed", { type: "tool_result", call_id: "wait", text: JSON.stringify({
      status: { local: { completed: "private final text" } }, timed_out: false,
      pending: { items: [{ target: "provider", phase: "model_running", since_ms: 2, operation: "run" }] }, wake_reason: "terminal"
    }), is_error: false, truncated: false });
    expect(translateMultiAgentToolLifecycle(call, mixed)).toEqual([
      { agentId: "local", state: "completed", terminal: true },
      { agentId: "provider", state: "running", terminal: false }
    ]);
    const closeCall = event("close-unknown-call", { type: "tool_call", call_id: "close-unknown", name: "multi_agent_v1__close_agent", arguments: JSON.stringify({ target: "local" }), truncated: false });
    const closeUnknown = event("close-unknown-result", { type: "tool_result", call_id: "close-unknown", text: JSON.stringify({ previous_status: "mystery" }), is_error: false, truncated: false });
    expect(translateMultiAgentToolLifecycle(closeCall, closeUnknown)).toEqual([]);
    const closeUncertain = event("close-uncertain-result", { type: "tool_result", call_id: "close-unknown", text: JSON.stringify({ previous_status: "unknown" }), is_error: false, truncated: false });
    expect(translateMultiAgentToolLifecycle(closeCall, closeUncertain)).toEqual([]);
  });

  it("exposes exact owner activity and identity only to the latest Conversation Segment", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    activateWorker(context);
    project(graph, primaryContext(), 1, event("model", { type: "model_changed", model: "Primary Model" }));
    project(graph, primaryContext(), 2, event("primary-agent", { type: "agent_activity", agent_id: "primary-child", display_name: "Primary Child", state: "running" }));
    project(graph, workerContext(), 1, { ...event("worker-model", { type: "model_changed", model: "Worker Model" }), sessionId: "worker-session" });
    project(graph, workerContext(), 2, { ...event("worker-turn", { type: "turn_started" }), sessionId: "worker-session" });
    project(graph, workerContext(), 3, { ...event("worker-agent", { type: "agent_activity", agent_id: "worker-child", display_name: "Worker Child", state: "running" }), sessionId: "worker-session" });
    const now = "2026-10-09T00:00:00.000Z";
    context.database.prepare(`INSERT INTO workspace_leases(
      id,project_id,instance_id,kind,cwd,branch,base_commit,state,generation,created_at,updated_at
    ) VALUES('lease-1','project-1','worker-1','git-worktree','/repo/.trae/worktrees/reviewer','review/session-state','base','ready',1,?,?)`).run(now, now);
    const workerMain = createWorkerMainView({
      workerId: "worker-1", workerSessionGeneration: 1, parentBindingId: "binding-1", parentBindingGeneration: 1,
      parentPaneId: "primary-pane", workerName: "reviewer", ownerName: "Primary", runtimeGeneration: 1,
      runtimeState: "working", runtimeAttached: true, desiredState: "running", parentActive: true,
      paneId: "worker-pane", paneToken: "worker-token", workspace: "/repo/.trae/worktrees/reviewer",
      worktreeName: "reviewer", branch: "review/session-state", model: "Worker Model",
      modelUsage: { model: "Worker Model", contextRemainingPercent: 64, inputTokens: 220, outputTokens: 33,
        queuedAt: now, firstVisibleAt: now, completedAt: null, waitMs: 17, firstVisibleMs: 29 }, occurredAt: now
    });
    expect(graph.cardContexts.saveWorkerMainView(workerMain)).toEqual(workerMain);
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
      start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
    ) VALUES
      ('segment-old','lane:lane-1','primary','binding-1',1,'traex','session-1','old',1,0,'closed',2,'root-1',?,?),
      ('segment-current','lane:lane-1','primary','binding-1',1,'traex','session-1','current',2,0,'working',1,'root-1',?,?),
      ('segment-worker-old','lane:worker','worker','worker-1',1,'traex','worker-session','worker old',2,0,'closed',2,'root-worker',?,?),
      ('segment-worker','lane:worker','worker','worker-1',1,'traex','worker-session','worker',3,0,'working',1,'root-worker',?,?)`)
      .run(now, now, now, now, now, now, now, now);

    expect(graph.sessionActivity.loadForCurrentPrimarySegment("segment-current")?.snapshot.currentModel).toBe("Primary Model");
    graph.projections.saveTopicView(updateTopicView(initialTopicView("binding-1"), {
      bindingGeneration: 1, workspaceId: "workspace-1", paneId: "primary-pane", phase: "running",
      paneIdentity: { workspace: "/repo/.worktree/main", worktreeName: "main", branch: "swarm/main", paneId: "primary-pane", paneToken: "prim" },
      modelUsage: { model: "Primary Model", contextRemainingPercent: 42, inputTokens: 1200, outputTokens: 300, queuedAt: null, firstVisibleAt: null, completedAt: null, waitMs: 25, firstVisibleMs: 40 }
    }));
    expect(graph.sessionActivity.loadTurnSessionStateForCurrentSegment("segment-current")).toMatchObject({
      paneIdentity: { worktreeName: "main", branch: "swarm/main" },
      modelUsage: { model: "Primary Model", inputTokens: 1200, waitMs: 25 }
    });
    expect(graph.sessionActivity.loadTurnSessionStateForCurrentSegment("segment-worker")).toMatchObject({
      paneIdentity: { workspace: "/repo/.trae/worktrees/reviewer", worktreeName: "reviewer", branch: "review/session-state", paneId: "worker-pane", paneToken: "worker-token" },
      modelUsage: { model: "Worker Model", contextRemainingPercent: 64, inputTokens: 220, outputTokens: 33, waitMs: 17, firstVisibleMs: 29 },
      lastTurnState: "active",
      activeSubagents: [{ label: "Worker Child", state: "running" }]
    });
    context.database.prepare("UPDATE agent_instances SET desired_state='stopped' WHERE id='worker-1'").run();
    expect(graph.sessionActivity.loadTurnSessionStateForCurrentSegment("segment-worker")).toMatchObject({
      paneIdentity: { workspace: "/repo/.trae/worktrees/reviewer", worktreeName: null, branch: "review/session-state", paneId: "worker-pane", paneToken: null },
      modelUsage: { model: "Worker Model", inputTokens: null, waitMs: null },
      lastTurnState: "active",
      activeSubagents: [{ label: "Worker Child", state: "running" }]
    });
    expect(graph.sessionActivity.loadForCurrentPrimarySegment("segment-old")).toBeNull();
    expect(graph.sessionActivity.loadTurnSessionStateForCurrentSegment("segment-worker-old")).toBeNull();
    graph.bindings.updateBinding("binding-1", { sessionEpoch: 2 });
    expect(graph.sessionActivity.loadForCurrentPrimarySegment("segment-current")).toBeNull();
    expect(graph.sessionActivity.loadTurnSessionStateForCurrentSegment("segment-worker")).toBeNull();
    context.close();
  });

  it("invalidates the current Turn Card once for displayed Topic View state and ignores hidden Topic changes", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const now = "2026-10-09T00:00:00.000Z";
    const previous = updateTopicView(initialTopicView("binding-1"), {
      bindingGeneration: 1, workspaceId: "workspace-1", paneId: "primary-pane", phase: "running",
      paneIdentity: { workspace: "/repo", worktreeName: "main", branch: "swarm/main", paneId: "primary-pane", paneToken: "prim" }
    });
    graph.projections.saveTopicView(previous);
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
      start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
    ) VALUES('topic-current','lane:topic','primary','binding-1',1,'traex','session-1','current',1,0,'working',1,'root-1',?,?)`).run(now, now);
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,created_at,updated_at
    ) VALUES('topic-current:page:0','topic-current',0,'answer-1','card-1','turn-card:topic-current:page:0','active',1,1,?,?)`).run(now, now);
    const notifications: unknown[] = [];
    graph.conversationSegments.setProjectionNotifier((notification) => { notifications.push(notification); });

    const visible = updateTopicView(previous, { branch: "swarm/next" });
    graph.projections.saveTopicView(visible);
    expect(graph.sessionActivity.projectTopicViewChange(previous, visible, now)).toBe(true);
    expect(graph.conversationSegments.getConversationSegment("topic-current")?.viewVersion).toBe(2);
    expect(notifications).toContainEqual({ segmentId: "topic-current", viewVersion: 2, urgency: "immediate" });
    expect(graph.sessionActivity.projectTopicViewChange(visible, visible, now)).toBe(false);

    const hidden = updateTopicView(visible, { title: "renamed but not rendered" });
    graph.projections.saveTopicView(hidden);
    expect(graph.sessionActivity.projectTopicViewChange(visible, hidden, now)).toBe(false);
    expect(graph.conversationSegments.getConversationSegment("topic-current")?.viewVersion).toBe(2);
    context.close();
  });

  it("round trips bounded current state without copying messages and is idempotent across restart", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const identity = primaryContext();

    project(graph, identity, 1, event("turn-start", { type: "turn_started" }));
    project(graph, identity, 2, event("model", { type: "model_changed", model: "GPT-5.6-Sol" }));
    project(graph, identity, 3, event("compact", { type: "context_compacted" }));
    project(graph, identity, 4, event("goal", { type: "goal_changed", goal_id: "goal-1", objective: "Ship T11", status: "active", source_updated_at: 1, truncated: false }));
    project(graph, identity, 5, event("tool-call", { type: "tool_call", call_id: "call-1", name: "exec_command", arguments: "secret body", truncated: false }));
    project(graph, identity, 6, event("agent", { type: "agent_activity", agent_id: "reviewer", display_name: "Reviewer", model: "GPT-5.6-Sol", state: "running" }));
    project(graph, identity, 7, event("message", { type: "message", message_id: "m-1", channel: "final", text: "must not persist", truncated: false }));

    const before = load(graph);
    expect(before?.snapshot).toMatchObject({ currentModel: "GPT-5.6-Sol", compactionCount: 1, lastTurnState: "active", tokenUsage: null, contextUsage: null });
    expect(before?.snapshot.currentGoal).toMatchObject({ objective: "Ship T11", status: "active" });
    expect(before?.items.map(({ kind, itemId, state }) => ({ kind, itemId, state }))).toEqual([
      { kind: "agent", itemId: "reviewer", state: "running" },
      { kind: "tool", itemId: "call-1", state: "running" }
    ]);
    expect(before?.items.find(({ itemId }) => itemId === "reviewer")?.label).toBe("Reviewer · GPT-5.6-Sol");
    expect(JSON.stringify(before)).not.toContain("must not persist");
    expect(JSON.stringify(before)).not.toContain("secret body");

    const revision = before!.snapshot.revision;
    project(graph, identity, 3, event("compact", { type: "context_compacted" }));
    expect(load(graph, identity.scope)?.snapshot).toMatchObject({ revision, compactionCount: 1 });
    context.close();
  });

  it("folds Worker activity into the parent Pane scope and rejects stale owner fences", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    activateWorker(context);
    const worker = workerContext();
    project(graph, primaryContext(), 1, event("primary-agent", {
      type: "agent_activity", agent_id: "child", display_name: "Primary Child", model: "Primary Model", state: "running"
    }));
    project(graph, worker, 1, { ...event("worker-agent", {
      type: "agent_activity", agent_id: "child", display_name: "Worker Child", model: "Worker Model", state: "completed"
    }), sessionId: "worker-session" });
    expect(load(graph, worker.scope)?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ producerKind: "primary", itemId: "child", label: "Primary Child · Primary Model" }),
      expect.objectContaining({ producerKind: "worker", itemId: "child", label: "Worker Child · Worker Model" })
    ]));
    expect(context.database.prepare("SELECT producer_kind,display_name,model FROM session_activity_agent_identities WHERE agent_id='child' ORDER BY producer_kind").all())
      .toEqual([
        { producer_kind: "primary", display_name: "Primary Child", model: "Primary Model" },
        { producer_kind: "worker", display_name: "Worker Child", model: "Worker Model" }
      ]);
    expect(load(graph, { kind: "pane", workspaceId: "workspace-1", paneId: "worker-pane" })).toBeNull();

    graph.bindings.updateBinding("binding-1", { sessionEpoch: 2 });
    expect(project(graph, worker, 2, { ...event("stale-worker", {
      type: "agent_activity", agent_id: "child", display_name: "Stale", model: "Stale Model", state: "failed"
    }), sessionId: "worker-session" }).outcome).toBe("stale");
    expect(context.database.prepare("SELECT display_name,model FROM session_activity_agent_identities WHERE producer_kind='worker' AND agent_id='child'").get())
      .toEqual({ display_name: "Worker Child", model: "Worker Model" });
    expect(load(graph, worker.scope, 2)).toBeNull();
    context.close();
  });

  it("invalidates the current Primary Answer Card after a Worker-only activity change", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    activateWorker(context);
    const now = "2026-10-09T00:00:00.000Z";
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
      start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
    ) VALUES('primary-current','lane:primary','primary','binding-1',1,'traex','session-1','current',1,0,'working',1,'root-1',?,?)`)
      .run(now, now);
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,created_at,updated_at
    ) VALUES('primary-current:page:0','primary-current',0,'answer-1','card-1','turn-card:primary-current:page:0','active',1,1,?,?)`)
      .run(now, now);
    const notifications: unknown[] = [];
    graph.conversationSegments.setProjectionNotifier((notification) => { notifications.push(notification); });
    const workerEvent = { ...event("worker-only", {
      type: "agent_activity", agent_id: "reviewer", display_name: "Reviewer", state: "running"
    }), sessionId: "worker-session" };
    const input = {
      laneId: "lane-worker", sourceId: workerEvent.sourceId, sourceEpoch: "epoch-worker", agentKind: "traex" as const,
      sessionId: "worker-session", sessionActivityContext: workerContext(), afterCursor: "start",
      nextCursor: workerEvent.cursor, latestCursor: workerEvent.cursor, events: [workerEvent], ingestedAt: now
    };

    expect(graph.coreEvents.ingestBatch(input)).toBe("accepted");
    expect(graph.conversationSegments.getConversationSegment("primary-current")?.viewVersion).toBe(2);
    expect(notifications).toContainEqual({ segmentId: "primary-current", viewVersion: 2, urgency: "immediate" });

    expect(graph.coreEvents.ingestBatch(input)).toBe("stale_rebase");
    expect(graph.conversationSegments.getConversationSegment("primary-current")?.viewVersion).toBe(2);

    const sameVisibleState = { ...workerEvent, eventId: "worker-only-repeat", cursor: "cursor:worker-only-repeat" };
    expect(graph.coreEvents.ingestBatch({
      ...input, afterCursor: workerEvent.cursor, nextCursor: sameVisibleState.cursor, latestCursor: sameVisibleState.cursor,
      events: [sameVisibleState]
    })).toBe("accepted");
    expect(graph.conversationSegments.getConversationSegment("primary-current")?.viewVersion).toBe(2);
    context.close();
  });

  it("invalidates the exact current Worker Turn Card after its visible activity changes", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    activateWorker(context);
    const now = "2026-10-09T00:00:00.000Z";
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
      start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
    ) VALUES('worker-current','lane:worker','worker','worker-1',1,'traex','worker-session','current',1,0,'working',1,'root-worker',?,?)`)
      .run(now, now);
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,created_at,updated_at
    ) VALUES('worker-current:page:0','worker-current',0,'answer-worker','card-worker','turn-card:worker-current:page:0','active',1,1,?,?)`)
      .run(now, now);
    const notifications: unknown[] = [];
    graph.conversationSegments.setProjectionNotifier((notification) => { notifications.push(notification); });
    const workerEvent = { ...event("worker-visible", {
      type: "agent_activity", agent_id: "reviewer", display_name: "Reviewer", state: "running"
    }), sessionId: "worker-session" };
    const input = {
      laneId: "lane-worker", sourceId: workerEvent.sourceId, sourceEpoch: "epoch-worker", agentKind: "traex" as const,
      sessionId: "worker-session", sessionActivityContext: workerContext(), afterCursor: "start",
      nextCursor: workerEvent.cursor, latestCursor: workerEvent.cursor, events: [workerEvent], ingestedAt: now
    };

    expect(graph.coreEvents.ingestBatch(input)).toBe("accepted");
    expect(graph.conversationSegments.getConversationSegment("worker-current")?.viewVersion).toBe(2);
    expect(notifications).toContainEqual({ segmentId: "worker-current", viewVersion: 2, urgency: "immediate" });

    const sameVisibleState = { ...workerEvent, eventId: "worker-visible-repeat", cursor: "cursor:worker-visible-repeat" };
    expect(graph.coreEvents.ingestBatch({
      ...input, afterCursor: workerEvent.cursor, nextCursor: sameVisibleState.cursor, latestCursor: sameVisibleState.cursor,
      events: [sameVisibleState]
    })).toBe("accepted");
    expect(graph.conversationSegments.getConversationSegment("worker-current")?.viewVersion).toBe(2);
    context.close();
  });

  it("does not invalidate the Primary Answer Card for retained activity hidden beyond the rendered limit", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    activateWorker(context);
    const now = "2026-10-09T00:00:00.000Z";
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
      start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
    ) VALUES('primary-current','lane:primary','primary','binding-1',1,'traex','session-1','current',1,0,'working',1,'root-1',?,?)`)
      .run(now, now);
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,created_at,updated_at
    ) VALUES('primary-current:page:0','primary-current',0,'answer-1','card-1','turn-card:primary-current:page:0','active',1,1,?,?)`)
      .run(now, now);

    let cursor = "start";
    for (let index = 0; index < 8; index += 1) {
      const item = { ...event(`visible-agent-${index}`, {
        type: "agent_activity", agent_id: `visible-${index}`, display_name: `Visible ${index}`, state: "running"
      }), sessionId: "worker-session" };
      expect(graph.coreEvents.ingestBatch({
        laneId: "lane-worker", sourceId: item.sourceId, sourceEpoch: "epoch-worker", agentKind: "traex",
        sessionId: "worker-session", sessionActivityContext: workerContext(), afterCursor: cursor,
        nextCursor: item.cursor, latestCursor: item.cursor, events: [item], ingestedAt: now
      })).toBe("accepted");
      cursor = item.cursor;
    }
    const visibleVersion = graph.conversationSegments.getConversationSegment("primary-current")!.viewVersion;
    const hidden = { ...event("hidden-terminal-agent", {
      type: "agent_activity", agent_id: "hidden", display_name: "Hidden", state: "completed"
    }), sessionId: "worker-session" };

    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-worker", sourceId: hidden.sourceId, sourceEpoch: "epoch-worker", agentKind: "traex",
      sessionId: "worker-session", sessionActivityContext: workerContext(), afterCursor: cursor,
      nextCursor: hidden.cursor, latestCursor: hidden.cursor, events: [hidden], ingestedAt: now
    })).toBe("accepted");
    expect(graph.conversationSegments.getConversationSegment("primary-current")?.viewVersion).toBe(visibleVersion);
    context.close();
  });

  it("shows only an explicit Subagent result handoff as returned to main", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const identity = primaryContext();

    project(graph, identity, 1, event("ordinary-completion", {
      type: "agent_activity", agent_id: "ordinary", display_name: "Ordinary", state: "completed"
    }));
    project(graph, identity, 2, event("returned-result", {
      type: "agent_activity", agent_id: "reviewer", display_name: "Reviewer", state: "completed",
      result_handoff: "delivered_to_parent"
    }));

    expect(load(graph)?.items.map(({ itemId, state }) => ({ itemId, state }))).toEqual([
      { itemId: "reviewer", state: "returned to main" },
      { itemId: "ordinary", state: "completed" }
    ]);
    expect(project(graph, identity, 2, event("returned-result", {
      type: "agent_activity", agent_id: "reviewer", state: "completed", result_handoff: "delivered_to_parent"
    })).outcome).toBe("duplicate");
    context.close();
  });

  it("preserves Subagent identity metadata and terminal state across sparse later activity", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const identity = primaryContext();

    project(graph, identity, 1, event("agent-running", {
      type: "agent_activity", agent_id: "reviewer", display_name: "Reviewer",
      model: "GPT-5.6-Sol", state: "running"
    }));
    project(graph, identity, 2, event("agent-returned", {
      type: "agent_activity", agent_id: "reviewer", display_name: "Reviewer", state: "completed",
      result_handoff: "delivered_to_parent"
    }));

    expect(load(graph)?.items.find(({ itemId }) => itemId === "reviewer")).toMatchObject({
      label: "Reviewer · GPT-5.6-Sol", state: "returned to main", terminal: true
    });

    expect(project(graph, identity, 3, event("late-running", {
      type: "agent_activity", agent_id: "reviewer", state: "running"
    }))).toEqual({ outcome: "projected", visibleChanged: false });
    expect(load(graph)?.items.find(({ itemId }) => itemId === "reviewer")).toMatchObject({
      label: "Reviewer · GPT-5.6-Sol", state: "returned to main", terminal: true
    });

    project(graph, identity, 4, event("agent-two-running", {
      type: "agent_activity", agent_id: "tester", display_name: "Tester",
      model: "GPT-5.6-Terra", state: "running"
    }));
    project(graph, identity, 5, event("agent-two-returned", {
      type: "agent_activity", agent_id: "tester", model: "GPT-5.6-Terra",
      state: "completed", result_handoff: "delivered_to_parent"
    }));
    expect(load(graph)?.items.find(({ itemId }) => itemId === "tester")).toMatchObject({
      label: "Tester · GPT-5.6-Terra", state: "returned to main", terminal: true
    });

    project(graph, identity, 6, event("model-first", {
      type: "agent_activity", agent_id: "writer", model: "GPT-5.6-Luna", state: "running"
    }));
    project(graph, identity, 7, event("name-second", {
      type: "agent_activity", agent_id: "writer", display_name: "Writer", state: "running"
    }));
    project(graph, identity, 8, event("renamed", {
      type: "agent_activity", agent_id: "writer", display_name: "Editor", state: "running"
    }));
    expect(load(graph)?.items.find(({ itemId }) => itemId === "writer")).toMatchObject({
      label: "Editor · GPT-5.6-Luna", state: "running", terminal: false
    });
    context.close();
  });

  it("preserves a pre-identity visible Subagent label when sparse lifecycle evidence arrives", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const identity = primaryContext();

    project(graph, identity, 1, event("legacy-agent", {
      type: "agent_activity", agent_id: "legacy-agent", display_name: "Legacy · GPT-5.6-Luna", state: "running"
    }));
    context.database.prepare("DELETE FROM session_activity_agent_identities WHERE agent_id='legacy-agent'").run();
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM session_activity_agent_identities WHERE agent_id='legacy-agent'").get())
      .toEqual({ count: 0 });

    project(graph, identity, 2, event("legacy-agent-sparse", {
      type: "agent_activity", agent_id: "legacy-agent", state: "completed"
    }));

    expect(load(graph)?.items.find(({ itemId }) => itemId === "legacy-agent")).toMatchObject({
      label: "Legacy · GPT-5.6-Luna", state: "completed", terminal: true
    });
    context.close();
  });

  it("counts genuinely unknown sparse identity fallbacks without retaining per-agent diagnostics", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);

    project(graph, primaryContext(), 1, event("unknown-agent-sparse", {
      type: "agent_activity", agent_id: "unknown-agent-uuid", state: "running"
    }));

    expect(load(graph)?.items.find(({ itemId }) => itemId === "unknown-agent-uuid")?.label).toBe("unknown-agent-uuid");
    const diagnostics = (graph.sessionActivity as typeof graph.sessionActivity & {
      diagnostics?(): { missingIdentityFallbackCount: number; lastMissingIdentityAt: string | null; lastMissingIdentityOutcome: string | null };
    }).diagnostics?.();
    expect(diagnostics).toEqual({
      missingIdentityFallbackCount: 1,
      lastMissingIdentityAt: "2026-10-08T00:00:01.000Z",
      lastMissingIdentityOutcome: "uuid_fallback"
    });
    expect(Object.keys(diagnostics ?? {}).sort()).toEqual([
      "lastMissingIdentityAt", "lastMissingIdentityOutcome", "missingIdentityFallbackCount"
    ]);
    context.close();
  });

  it("keeps active items while bounding terminal items deterministically", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const identity = primaryContext();
    for (let index = 0; index < 30; index += 1) {
      project(graph, identity, index + 1, event(`agent-${index}`, { type: "agent_activity", agent_id: `agent-${index}`, state: index === 0 ? "running" : "completed" }));
    }
    activateWorker(context);
    for (let index = 0; index < 15; index += 1) {
      project(graph, workerContext(), index + 1, { ...event(`worker-agent-${index}`, { type: "agent_activity", agent_id: `worker-agent-${index}`, state: "completed" }), sessionId: "worker-session" });
    }
    for (let index = 0; index < 12; index += 1) {
      project(graph, identity, index + 31, event(`tool-${index}`, { type: "tool_call", call_id: `call-${index}`, name: "exec_command" }));
    }
    const activity = load(graph, identity.scope)!;
    const agents = activity.items.filter(({ kind }) => kind === "agent");
    expect(agents.filter(({ terminal }) => terminal)).toHaveLength(20);
    expect(agents.some(({ itemId, terminal }) => itemId === "agent-0" && !terminal)).toBe(true);
    expect(activity.items.filter(({ kind, terminal }) => kind === "tool" && !terminal)).toHaveLength(8);
    context.database.prepare("UPDATE agent_instances SET worker_session_lifecycle='terminated' WHERE id='worker-1'").run();
    project(graph, identity, 43, event("after-worker-termination", { type: "model_changed", model: "current" }));
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM session_activity_snapshots WHERE producer_kind='worker'").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM session_activity_agent_identities WHERE producer_kind='worker'").get()).toEqual({ count: 0 });
    context.close();
  });

  it("hides an old binding immediately when the Pane is rebound and removes it on the first new projection", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    project(graph, primaryContext(), 1, event("old-model", { type: "model_changed", model: "old-binding" }));
    project(graph, primaryContext(), 2, event("old-agent", { type: "agent_activity", agent_id: "old-agent", display_name: "Old", model: "Old Model", state: "running" }));
    context.database.prepare("UPDATE bindings SET pane_id=NULL,attachment='unattached' WHERE id='binding-1'").run();
    graph.bindings.createPendingBinding({ id: "binding-2", workspaceId: "workspace-1", chatId: "chat-1", topicId: "topic-2", rootMessageId: "root-2", title: "Replacement" });
    graph.bindings.updateBinding("binding-2", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-2"
    });
    const nextContext: SessionActivityProjectionContext = {
      scope: primaryContext().scope,
      ownerFence: { kind: "primary", id: "binding-2", generation: 1, sessionGeneration: 1 },
      producer: { kind: "primary", id: "binding-2", runtimeGeneration: 1, sessionGeneration: 1, runtimePaneId: "primary-pane" }
    };

    expect(graph.sessionActivity.load(nextContext.scope, { bindingId: "binding-2", bindingGeneration: 1, sessionEpoch: 1 })).toBeNull();
    expect(project(graph, nextContext, 1, { ...event("new-model", { type: "model_changed", model: "new-binding" }), sessionId: "session-2" }).outcome).toBe("projected");
    expect(graph.sessionActivity.load(nextContext.scope, { bindingId: "binding-2", bindingGeneration: 1, sessionEpoch: 1 })?.snapshot.currentModel).toBe("new-binding");
    expect(context.database.prepare("SELECT binding_id FROM session_activity_snapshots").all()).toEqual([{ binding_id: "binding-2" }]);
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM session_activity_agent_identities").get()).toEqual({ count: 0 });
    context.close();
  });

  it("accepts an explicit source epoch transition and rejects a late event from the old epoch", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    graph.bindings.updateBinding("binding-1", { statusMessageId: "root-1" });
    graph.projections.saveTopicView(updateTopicView(initialTopicView("binding-1"), {
      bindingGeneration: 1, workspaceId: "workspace-1", paneId: "primary-pane", phase: "ready", title: "Primary"
    }));
    connectPrepared(graph);
    graph.sessionActivity.setCardRenderers({
      main: (view, activity) => ({ revision: view.sessionActivityRevision, model: activity?.snapshot.currentModel ?? null }),
      pane: (view, activity) => ({ revision: view.sessionActivityRevision, model: activity?.snapshot.currentModel ?? null })
    });
    const first = event("epoch-one-model", { type: "model_changed", model: "epoch-one" });
    graph.coreEvents.ingestBatch({
      laneId: "lane-epoch", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      sessionActivityContext: primaryContext(), afterCursor: "start", nextCursor: first.cursor, latestCursor: first.cursor,
      events: [first], ingestedAt: "2026-10-08T00:00:01.000Z"
    });
    graph.coreEvents.ingestBatch({
      laneId: "lane-epoch", sourceId: "ring-1", sourceEpoch: "epoch-2", agentKind: "traex", sessionId: "session-1",
      sessionActivityContext: primaryContext(), afterCursor: first.cursor, nextCursor: first.cursor, latestCursor: "epoch-2:9",
      events: [], ingestedAt: "2026-10-08T00:00:02.000Z"
    });
    const ignored = event("epoch-two-message", { type: "message", message_id: "message-epoch-two", channel: "commentary", text: "must not persist", truncated: false });
    graph.coreEvents.ingestBatch({
      laneId: "lane-epoch", sourceId: "ring-1", sourceEpoch: "epoch-2", agentKind: "traex", sessionId: "session-1",
      sessionActivityContext: primaryContext(), afterCursor: first.cursor, nextCursor: ignored.cursor, latestCursor: ignored.cursor,
      events: [ignored], ingestedAt: "2026-10-08T00:00:03.000Z"
    });
    expect(load(graph)?.snapshot.currentModel).toBe("epoch-one");
    expect(context.database.prepare("SELECT source_epoch FROM session_activity_snapshots WHERE producer_kind='primary'").get()).toEqual({ source_epoch: "epoch-2" });
    expect(graph.projections.loadTopicView("binding-1")?.sessionActivityRevision).toBe(1);

    const second = event("epoch-two-model", { type: "model_changed", model: "epoch-two" });
    graph.coreEvents.ingestBatch({
      laneId: "lane-epoch", sourceId: "ring-1", sourceEpoch: "epoch-2", agentKind: "traex", sessionId: "session-1",
      sessionActivityContext: primaryContext(), afterCursor: ignored.cursor, nextCursor: second.cursor, latestCursor: second.cursor,
      events: [second], ingestedAt: "2026-10-08T00:00:04.000Z"
    });

    expect(load(graph)?.snapshot.currentModel).toBe("epoch-two");
    expect(graph.projections.loadTopicView("binding-1")?.sessionActivityRevision).toBe(2);
    expect(graph.sessionActivity.projectCanonicalEvent({
      context: primaryContext(), laneId: "lane-epoch", laneSequence: 999, sourceId: "ring-1", sourceEpoch: "epoch-1",
      event: event("late-old-epoch", { type: "model_changed", model: "must-not-win" }), observedAt: "2026-10-08T00:00:05.000Z"
    }).outcome).toBe("stale");
    expect(load(graph)?.snapshot.currentModel).toBe("epoch-two");
    context.close();
  });

  it("reopens from disk and completes a persisted Tool without losing its label", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-session-activity-"));
    const path = join(directory, "state.sqlite");
    const firstContext = new SqliteContext(path);
    const first = new SqliteCapabilityGraph(firstContext);
    activatePrimary(first);
    project(first, primaryContext(), 1, event("tool-call", { type: "tool_call", call_id: "call-1", name: "exec_command", arguments: "private" }));
    firstContext.close();

    const secondContext = new SqliteContext(path);
    try {
      const second = new SqliteCapabilityGraph(secondContext);
      expect(project(second, primaryContext(), 2, event("tool-result", { type: "tool_result", call_id: "call-1", text: "private result", is_error: false })).outcome).toBe("projected");
      expect(load(second)?.items).toEqual([
        expect.objectContaining({ kind: "tool", itemId: "call-1", label: "exec_command", state: "completed", terminal: true })
      ]);
      expect(JSON.stringify(load(second))).not.toContain("private result");
    } finally {
      secondContext.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers retained settled multi-agent Tool pairs after reopen without duplicate visible work", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-session-activity-recovery-"));
    const path = join(directory, "state.sqlite");
    const firstContext = new SqliteContext(path);
    const first = new SqliteCapabilityGraph(firstContext);
    activatePrimary(first);
    const call = event("retained-spawn-call", {
      type: "tool_call", call_id: "retained-spawn", name: "multi_agent_v1__spawn_agent",
      arguments: JSON.stringify({ agent_type: "explorer", model: "GPT-5.6-Terra", message: "private retained task" }), truncated: false
    });
    const result = event("retained-spawn-result", {
      type: "tool_result", call_id: "retained-spawn",
      text: JSON.stringify({ agent_id: "retained-agent", nickname: "Planck", execution: { total: 0, items: [] } }),
      is_error: false, truncated: false
    });
    expect(first.coreEvents.ingestBatch({
      laneId: "lane-retained", sourceId: call.sourceId, sourceEpoch: "epoch-1", agentKind: call.agentKind,
      sessionId: call.sessionId, afterCursor: "start", nextCursor: result.cursor, latestCursor: result.cursor,
      events: [call, result], ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");
    expect(first.coreEvents.acknowledge("lane-retained", [call.eventId, result.eventId], "projected", "2026-10-08T00:00:01.500Z")).toBe("settled");
    expect(load(first)).toBeNull();
    firstContext.close();

    const secondContext = new SqliteContext(path);
    try {
      const second = new SqliteCapabilityGraph(secondContext);
      expect(second.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 100, observedAt: "2026-10-08T00:00:02.000Z" }))
        .toMatchObject({ recoveredAgents: 1, visibleChanged: true, remaining: false, nextCursor: null });
      expect(load(second)?.items).toContainEqual(expect.objectContaining({
        kind: "agent", itemId: "retained-agent", label: "Planck · GPT-5.6-Terra", state: "started", terminal: false
      }));
      expect(JSON.stringify(load(second))).not.toContain("private retained task");
      expect(second.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 100, observedAt: "2026-10-08T00:00:03.000Z" }))
        .toMatchObject({ recoveredAgents: 0, visibleChanged: false, remaining: false, nextCursor: null });
    } finally {
      secondContext.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists an exact retained recovery checkpoint across reopen and admits later lane evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-retained-recovery-checkpoint-"));
    const path = join(directory, "state.sqlite");
    let context = new SqliteContext(path);
    let graph = new SqliteCapabilityGraph(context);
    try {
      activatePrimary(graph);
      const targets = ["agent-a"];
      const firstCall = event("checkpoint-wait-1-call", {
        type: "tool_call", call_id: "checkpoint-wait-1", name: "multi_agent_v1__wait_agent",
        arguments: JSON.stringify({ targets, timeout_ms: 1 }), truncated: false
      });
      const firstResult = event("checkpoint-wait-1-result", {
        type: "tool_result", call_id: "checkpoint-wait-1",
        text: JSON.stringify({ status: { "agent-a": { completed: "private" } }, timed_out: false, pending: { items: [] }, wake_reason: "terminal" }),
        is_error: false, truncated: false
      });
      const secondCall = event("checkpoint-wait-2-call", {
        type: "tool_call", call_id: "checkpoint-wait-2", name: "multi_agent_v1__wait_agent",
        arguments: JSON.stringify({ targets, timeout_ms: 1 }), truncated: false
      });
      const secondResult = event("checkpoint-wait-2-result", {
        type: "tool_result", call_id: "checkpoint-wait-2",
        text: JSON.stringify({ status: { "agent-a": { failed: "private" } }, timed_out: false, pending: { items: [] }, wake_reason: "terminal" }),
        is_error: false, truncated: false
      });
      const initial = [firstCall, firstResult, secondCall, secondResult];
      expect(graph.coreEvents.ingestBatch({
        laneId: "lane-retained-checkpoint", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
        afterCursor: "start", nextCursor: secondResult.cursor, latestCursor: secondResult.cursor,
        events: initial, ingestedAt: "2026-10-08T00:00:01.000Z"
      })).toBe("accepted");
      expect(graph.coreEvents.acknowledge("lane-retained-checkpoint", initial.map(({ eventId }) => eventId), "projected", "2026-10-08T00:00:02.000Z"))
        .toBe("settled");
      expect(graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 10, observedAt: "2026-10-08T00:00:03.000Z" }))
        .toMatchObject({ recoveredAgents: 1, remaining: false });
      expect(context.database.prepare(`SELECT retained_recovery_lane_id,retained_recovery_lane_sequence,revision
        FROM session_activity_snapshots WHERE producer_kind='primary' AND producer_id='binding-1'`).get()).toEqual({
        retained_recovery_lane_id: "lane-retained-checkpoint", retained_recovery_lane_sequence: 4, revision: 2
      });
      context.close();

      context = new SqliteContext(path);
      graph = new SqliteCapabilityGraph(context);
      expect(context.database.prepare(RETAINED_MULTI_AGENT_ACTIVITY_QUERY).all(null, "", "primary", "", "", -1, "", 10)).toEqual([]);

      const laterCall = event("checkpoint-wait-3-call", {
        type: "tool_call", call_id: "checkpoint-wait-3", name: "multi_agent_v1__wait_agent",
        arguments: JSON.stringify({ targets, timeout_ms: 1 }), truncated: false
      });
      const laterResult = event("checkpoint-wait-3-result", {
        type: "tool_result", call_id: "checkpoint-wait-3",
        text: JSON.stringify({ status: { "agent-a": { completed: "private" } }, timed_out: false, pending: { items: [] }, wake_reason: "terminal" }),
        is_error: false, truncated: false
      });
      expect(graph.coreEvents.ingestBatch({
        laneId: "lane-retained-checkpoint", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
        afterCursor: secondResult.cursor, nextCursor: laterResult.cursor, latestCursor: laterResult.cursor,
        events: [laterCall, laterResult], ingestedAt: "2026-10-08T00:00:04.000Z"
      })).toBe("accepted");
      expect(graph.coreEvents.acknowledge("lane-retained-checkpoint", [laterCall.eventId, laterResult.eventId], "projected", "2026-10-08T00:00:05.000Z"))
        .toBe("settled");
      expect(context.database.prepare(RETAINED_MULTI_AGENT_ACTIVITY_QUERY).all(null, "", "primary", "", "", -1, "", 10)).toHaveLength(1);
      expect(graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 10, observedAt: "2026-10-08T00:00:06.000Z" }))
        .toMatchObject({ recoveredAgents: 1, remaining: false });
      expect(context.database.prepare(`SELECT retained_recovery_lane_id,retained_recovery_lane_sequence,revision
        FROM session_activity_snapshots WHERE producer_kind='primary' AND producer_id='binding-1'`).get()).toEqual({
        retained_recovery_lane_id: "lane-retained-checkpoint", retained_recovery_lane_sequence: 6, revision: 3
      });

      const replacementLaneCall = {
        ...event("checkpoint-lane-2-call", {
          type: "tool_call", call_id: "checkpoint-lane-2", name: "multi_agent_v1__spawn_agent",
          arguments: JSON.stringify({ agent_type: "explorer", model: "GPT-5.6-Terra", message: "private" }), truncated: false
        }), sourceId: "ring-2"
      };
      const replacementLaneResult = {
        ...event("checkpoint-lane-2-result", {
          type: "tool_result", call_id: "checkpoint-lane-2",
          text: JSON.stringify({ agent_id: "agent-b", nickname: "Lane Two", execution: { total: 0, items: [] } }),
          is_error: false, truncated: false
        }), sourceId: "ring-2"
      };
      expect(graph.coreEvents.ingestBatch({
        laneId: "lane-retained-checkpoint-2", sourceId: "ring-2", sourceEpoch: "epoch-2", agentKind: "traex", sessionId: "session-1",
        afterCursor: "start", nextCursor: replacementLaneResult.cursor, latestCursor: replacementLaneResult.cursor,
        events: [replacementLaneCall, replacementLaneResult], ingestedAt: "2026-10-08T00:00:07.000Z"
      })).toBe("accepted");
      expect(graph.coreEvents.acknowledge("lane-retained-checkpoint-2", [replacementLaneCall.eventId, replacementLaneResult.eventId], "projected", "2026-10-08T00:00:08.000Z"))
        .toBe("settled");
      expect(context.database.prepare(RETAINED_MULTI_AGENT_ACTIVITY_QUERY).all(null, "", "primary", "", "", -1, "", 10)).toHaveLength(1);
      expect(graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 10, observedAt: "2026-10-08T00:00:09.000Z" }))
        .toMatchObject({ recoveredAgents: 1, remaining: false });
      expect(context.database.prepare(`SELECT retained_recovery_lane_id,retained_recovery_lane_sequence
        FROM session_activity_snapshots WHERE producer_kind='primary' AND producer_id='binding-1'`).get()).toEqual({
        retained_recovery_lane_id: "lane-retained-checkpoint-2", retained_recovery_lane_sequence: 2
      });

      graph.bindings.updateBinding("binding-1", {
        generation: 2, sessionEpoch: 2, agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
        agentSessionKind: "id", agentSessionValue: "session-2"
      });
      const replacementRuntimeCall = {
        ...event("checkpoint-runtime-2-call", {
          type: "tool_call", call_id: "checkpoint-runtime-2", name: "multi_agent_v1__spawn_agent",
          arguments: JSON.stringify({ agent_type: "worker", model: "GPT-5.6-Sol", message: "private" }), truncated: false
        }), sessionId: "session-2", sourceId: "ring-3"
      };
      const replacementRuntimeResult = {
        ...event("checkpoint-runtime-2-result", {
          type: "tool_result", call_id: "checkpoint-runtime-2",
          text: JSON.stringify({ agent_id: "agent-c", nickname: "Runtime Two", execution: { total: 0, items: [] } }),
          is_error: false, truncated: false
        }), sessionId: "session-2", sourceId: "ring-3"
      };
      expect(graph.coreEvents.ingestBatch({
        laneId: "lane-retained-runtime-2", sourceId: "ring-3", sourceEpoch: "epoch-3", agentKind: "traex", sessionId: "session-2",
        afterCursor: "start", nextCursor: replacementRuntimeResult.cursor, latestCursor: replacementRuntimeResult.cursor,
        events: [replacementRuntimeCall, replacementRuntimeResult], ingestedAt: "2026-10-08T00:00:10.000Z"
      })).toBe("accepted");
      expect(graph.coreEvents.acknowledge("lane-retained-runtime-2", [replacementRuntimeCall.eventId, replacementRuntimeResult.eventId], "projected", "2026-10-08T00:00:11.000Z"))
        .toBe("settled");
      expect(context.database.prepare(RETAINED_MULTI_AGENT_ACTIVITY_QUERY).all(null, "", "primary", "", "", -1, "", 10)).toHaveLength(1);
      expect(graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 10, observedAt: "2026-10-08T00:00:12.000Z" }))
        .toMatchObject({ recoveredAgents: 1, remaining: false });
      expect(context.database.prepare(`SELECT binding_generation,session_epoch,native_session_id,retained_recovery_lane_id,retained_recovery_lane_sequence
        FROM session_activity_snapshots WHERE producer_kind='primary' AND producer_id='binding-1'`).get()).toEqual({
        binding_generation: 2, session_epoch: 2, native_session_id: "session-2",
        retained_recovery_lane_id: "lane-retained-runtime-2", retained_recovery_lane_sequence: 2
      });
    } finally {
      context.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads retained evidence before the write transaction and prunes one changed scope once", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const agentIds = Array.from({ length: 144 }, (_, index) => `agent-${String(index).padStart(3, "0")}`);
    const events = [0, 64, 128].flatMap((offset) => {
      const targets = agentIds.slice(offset, Math.min(offset + 64, agentIds.length));
      const key = String(offset).padStart(3, "0");
      return [
        event(`batched-wait-${key}-call`, {
          type: "tool_call", call_id: `batched-wait-${key}`, name: "multi_agent_v1__wait_agent",
          arguments: JSON.stringify({ targets, timeout_ms: 1 }), truncated: false
        }),
        event(`batched-wait-${key}-result`, {
          type: "tool_result", call_id: `batched-wait-${key}`,
          text: JSON.stringify({ status: Object.fromEntries(targets.map((target) => [target, { completed: "private" }])), timed_out: false, pending: { items: [] }, wake_reason: "terminal" }),
          is_error: false, truncated: false
        })
      ];
    });
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-batched-recovery", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: events.at(-1)!.cursor, latestCursor: events.at(-1)!.cursor,
      events, ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");
    expect(graph.coreEvents.acknowledge("lane-batched-recovery", events.map(({ eventId }) => eventId), "projected", "2026-10-08T00:00:02.000Z"))
      .toBe("settled");

    let insideRecoveryWrite = false;
    let retainedQueryInsideWrite: boolean | null = null;
    let pruneExecutions = 0;
    const transaction = context.transaction.bind(context);
    context.transaction = ((operation: string, action: () => unknown) => transaction(operation, () => {
      const previous = insideRecoveryWrite;
      if (operation === "sqlite.session-activity-store.recover-retained-multi-agent") insideRecoveryWrite = true;
      try { return action(); } finally { insideRecoveryWrite = previous; }
    })) as typeof context.transaction;
    const database = context.database as unknown as { prepare(sql: string): object };
    const prepare = database.prepare.bind(database);
    database.prepare = (sql: string) => {
      const statement = prepare(sql) as Record<string, unknown>;
      return new Proxy(statement, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          if (property !== "all" && property !== "run") return value.bind(target);
          return (...args: unknown[]) => {
            if (property === "all" && sql === RETAINED_MULTI_AGENT_ACTIVITY_QUERY) retainedQueryInsideWrite = insideRecoveryWrite;
            if (property === "run" && sql.includes("DELETE FROM session_activity_items WHERE rowid IN")) pruneExecutions += 1;
            return value.apply(target, args);
          };
        }
      });
    };

    expect(graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 10, observedAt: "2026-10-08T00:00:03.000Z" }))
      .toMatchObject({ recoveredAgents: 144, visibleChanged: false, remaining: false });
    expect(retainedQueryInsideWrite).toBe(false);
    expect(pruneExecutions).toBe(6);
    expect(load(graph)?.items.filter(({ kind }) => kind === "agent").map(({ itemId, state, terminal }) => ({ itemId, state, terminal })))
      .toEqual([
        ...agentIds.slice(128), ...agentIds.slice(64, 68)
      ].map((itemId) => ({ itemId, state: "completed", terminal: true })));
    context.close();
  });

  it("rolls back retained mutations when batched scope pruning fails", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const targets = Array.from({ length: 21 }, (_, index) => `rollback-agent-${String(index).padStart(2, "0")}`);
    const call = event("rollback-prune-call", {
      type: "tool_call", call_id: "rollback-prune", name: "multi_agent_v1__wait_agent",
      arguments: JSON.stringify({ targets, timeout_ms: 1 }), truncated: false
    });
    const result = event("rollback-prune-result", {
      type: "tool_result", call_id: "rollback-prune",
      text: JSON.stringify({ status: Object.fromEntries(targets.map((target) => [target, { completed: "private" }])), timed_out: false, pending: { items: [] }, wake_reason: "terminal" }),
      is_error: false, truncated: false
    });
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-rollback-prune", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: result.cursor, latestCursor: result.cursor,
      events: [call, result], ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");
    expect(graph.coreEvents.acknowledge("lane-rollback-prune", [call.eventId, result.eventId], "projected", "2026-10-08T00:00:02.000Z"))
      .toBe("settled");
    context.database.exec(`CREATE TRIGGER fail_session_activity_prune BEFORE DELETE ON session_activity_items
      BEGIN SELECT RAISE(ABORT,'simulated prune failure'); END`);

    expect(() => graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 10, observedAt: "2026-10-08T00:00:03.000Z" }))
      .toThrow("simulated prune failure");
    expect(context.database.prepare(`SELECT
      (SELECT COUNT(*) FROM session_activity_snapshots) AS snapshots,
      (SELECT COUNT(*) FROM session_activity_items) AS items,
      (SELECT COUNT(*) FROM session_activity_agent_identities) AS identities`).get())
      .toEqual({ snapshots: 0, items: 0, identities: 0 });
    context.close();
  });

  it("recovers retained Worker spawn and sparse terminal identity without leaking the same agent ID across producers", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-worker-session-activity-recovery-"));
    const path = join(directory, "state.sqlite");
    const agentId = "shared-agent-id";
    const firstContext = new SqliteContext(path);
    const first = new SqliteCapabilityGraph(firstContext);
    activatePrimary(first);
    activateWorker(firstContext);
    const primaryCall = event("retained-primary-spawn-call", {
      type: "tool_call", call_id: "retained-primary-spawn", name: "multi_agent_v1__spawn_agent",
      arguments: JSON.stringify({ model: "Primary Model" }), truncated: false
    });
    const primaryResult = event("retained-primary-spawn-result", {
      type: "tool_result", call_id: "retained-primary-spawn",
      text: JSON.stringify({ agent_id: agentId, nickname: "Primary Child" }), is_error: false, truncated: false
    });
    const workerCall = { ...event("retained-worker-spawn-call", {
      type: "tool_call", call_id: "retained-worker-spawn", name: "multi_agent_v1__spawn_agent",
      arguments: JSON.stringify({ model: "Worker Model" }), truncated: false
    }), sourceId: "worker-ring", sessionId: "worker-session" };
    const workerResult = { ...event("retained-worker-spawn-result", {
      type: "tool_result", call_id: "retained-worker-spawn",
      text: JSON.stringify({ agent_id: agentId, nickname: "Worker Child" }), is_error: false, truncated: false
    }), sourceId: "worker-ring", sessionId: "worker-session" };
    const workerCloseCall = { ...event("retained-worker-close-call", {
      type: "tool_call", call_id: "retained-worker-close", name: "multi_agent_v1__close_agent",
      arguments: JSON.stringify({ target: agentId }), truncated: false
    }), sourceId: "worker-ring", sessionId: "worker-session" };
    const workerCloseResult = { ...event("retained-worker-close-result", {
      type: "tool_result", call_id: "retained-worker-close",
      text: JSON.stringify({ previous_status: { completed: "private worker result" } }), is_error: false, truncated: false
    }), sourceId: "worker-ring", sessionId: "worker-session" };
    expect(first.coreEvents.ingestBatch({
      laneId: "lane-retained-primary", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: primaryResult.cursor, latestCursor: primaryResult.cursor,
      events: [primaryCall, primaryResult], ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");
    expect(first.coreEvents.acknowledge("lane-retained-primary", [primaryCall.eventId, primaryResult.eventId], "projected", "2026-10-08T00:00:01.500Z")).toBe("settled");
    expect(first.coreEvents.ingestBatch({
      laneId: "lane-retained-worker", sourceId: "worker-ring", sourceEpoch: "epoch-worker", agentKind: "traex", sessionId: "worker-session",
      afterCursor: "start", nextCursor: workerCloseResult.cursor, latestCursor: workerCloseResult.cursor,
      events: [workerCall, workerResult, workerCloseCall, workerCloseResult], ingestedAt: "2026-10-08T00:00:02.000Z"
    })).toBe("accepted");
    expect(first.coreEvents.acknowledge(
      "lane-retained-worker",
      [workerCall.eventId, workerResult.eventId, workerCloseCall.eventId, workerCloseResult.eventId],
      "projected",
      "2026-10-08T00:00:02.500Z"
    )).toBe("settled");
    firstContext.close();

    const secondContext = new SqliteContext(path);
    try {
      const second = new SqliteCapabilityGraph(secondContext);
      const primaryPage = second.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 1, observedAt: "2026-10-08T00:00:03.000Z" });
      expect(primaryPage).toMatchObject({ recoveredAgents: 1, visibleChanged: true, remaining: true, nextCursor: expect.any(String) });
      const workerSpawnPage = second.sessionActivity.recoverRetainedMultiAgentActivity({
        limit: 1, afterCursor: primaryPage.nextCursor, observedAt: "2026-10-08T00:00:03.100Z"
      });
      expect(workerSpawnPage).toMatchObject({ recoveredAgents: 1, visibleChanged: true, remaining: true, nextCursor: expect.any(String) });
      const workerClosePage = second.sessionActivity.recoverRetainedMultiAgentActivity({
        limit: 1, afterCursor: workerSpawnPage.nextCursor, observedAt: "2026-10-08T00:00:03.200Z"
      });
      expect(workerClosePage).toMatchObject({ recoveredAgents: 1, visibleChanged: true, remaining: false, nextCursor: null });
      expect(load(second)?.items.filter(({ itemId }) => itemId === agentId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ producerKind: "primary", label: "Primary Child · Primary Model", state: "started", terminal: false }),
        expect.objectContaining({ producerKind: "worker", label: "Worker Child · Worker Model", state: "completed", terminal: true })
      ]));
      expect(second.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 100, observedAt: "2026-10-08T00:00:04.000Z" }))
        .toMatchObject({ recoveredAgents: 0, visibleChanged: false, remaining: false, nextCursor: null });
    } finally {
      secondContext.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not let a later live Agent item suppress an earlier retained Agent result", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const call = event("retained-agent-a-call", { type: "tool_call", call_id: "agent-a", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({ model: "GPT-5.6-Terra" }), truncated: false });
    const result = event("retained-agent-a-result", { type: "tool_result", call_id: "agent-a", text: JSON.stringify({ agent_id: "agent-a", nickname: "Planck" }), is_error: false, truncated: false });
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-shared", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: result.cursor, latestCursor: result.cursor, events: [call, result], ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");
    expect(graph.coreEvents.acknowledge("lane-shared", [call.eventId, result.eventId], "projected", "2026-10-08T00:00:02.000Z")).toBe("settled");
    expect(graph.sessionActivity.projectCanonicalEvent({
      context: primaryContext(), laneId: "lane-shared", laneSequence: 3, sourceId: "ring-1", sourceEpoch: "epoch-1",
      event: event("live-agent-b", { type: "agent_activity", agent_id: "agent-b", display_name: "Curie", state: "running" }), observedAt: "2026-10-08T00:00:03.000Z"
    })).toEqual({ outcome: "projected", visibleChanged: true });

    expect(graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 10, observedAt: "2026-10-08T00:00:04.000Z" }))
      .toMatchObject({ recoveredAgents: 1, visibleChanged: true, remaining: false, nextCursor: null });
    expect(load(graph)?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "agent", itemId: "agent-a", label: "Planck · GPT-5.6-Terra" }),
      expect.objectContaining({ kind: "agent", itemId: "agent-b", label: "Curie" })
    ]));
    context.close();
  });

  it("keeps retained terminal evidence when a later retained wait reports nonterminal state", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const terminalCall = event("terminal-retained-call", { type: "tool_call", call_id: "terminal-retained", name: "multi_agent_v1__wait_agent", arguments: JSON.stringify({ targets: ["agent-a"], timeout_ms: 1 }), truncated: false });
    const terminalResult = event("terminal-retained-result", { type: "tool_result", call_id: "terminal-retained", text: JSON.stringify({ status: { "agent-a": { completed: "private" } }, timed_out: false, pending: { items: [] }, wake_reason: "terminal" }), is_error: false, truncated: false });
    const laterCall = event("later-retained-call", { type: "tool_call", call_id: "later-retained", name: "multi_agent_v1__wait_agent", arguments: JSON.stringify({ targets: ["agent-a"], timeout_ms: 1 }), truncated: false });
    const laterResult = event("later-retained-result", { type: "tool_result", call_id: "later-retained", text: JSON.stringify({ status: {}, timed_out: true, pending: { items: [{ target: "agent-a", phase: "model_running", since_ms: 2, operation: "run" }] }, wake_reason: "timeout" }), is_error: false, truncated: false });
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-terminal-retained", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: laterResult.cursor, latestCursor: laterResult.cursor,
      events: [terminalCall, terminalResult, laterCall, laterResult], ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");
    expect(graph.coreEvents.acknowledge("lane-terminal-retained", [terminalCall.eventId, terminalResult.eventId, laterCall.eventId, laterResult.eventId], "projected", "2026-10-08T00:00:02.000Z")).toBe("settled");
    graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 10, observedAt: "2026-10-08T00:00:03.000Z" });
    expect(load(graph)?.items.find(({ kind, itemId }) => kind === "agent" && itemId === "agent-a"))
      .toMatchObject({ state: "completed", terminal: true });
    context.close();
  });

  it("advances a global retained keyset past rejected evidence to a later active binding", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    graph.bindings.createPendingBinding({ id: "binding-2", workspaceId: "workspace-2", chatId: "chat-2", topicId: "topic-2", rootMessageId: "root-2", title: "Second" });
    graph.bindings.updateBinding("binding-2", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane-2",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-2"
    });
    const rejectedCall = event("rejected-page-call", { type: "tool_call", call_id: "rejected", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({}), truncated: false });
    const rejectedResult = event("rejected-page-result", { type: "tool_result", call_id: "rejected", text: JSON.stringify({ agent_id: 7, nickname: "invalid" }), is_error: false, truncated: false });
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-rejected-page", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: rejectedResult.cursor, latestCursor: rejectedResult.cursor, events: [rejectedCall, rejectedResult], ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");
    expect(graph.coreEvents.acknowledge("lane-rejected-page", [rejectedCall.eventId, rejectedResult.eventId], "projected", "2026-10-08T00:00:02.000Z")).toBe("settled");
    const validCall = { ...event("valid-page-call", { type: "tool_call", call_id: "valid", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({ model: "GPT-5.6-Sol" }), truncated: false }), sourceId: "ring-2", sessionId: "session-2" };
    const validResult = { ...event("valid-page-result", { type: "tool_result", call_id: "valid", text: JSON.stringify({ agent_id: "binding-2-agent", nickname: "Curie" }), is_error: false, truncated: false }), sourceId: "ring-2", sessionId: "session-2" };
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-valid-page", sourceId: "ring-2", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-2",
      afterCursor: "start", nextCursor: validResult.cursor, latestCursor: validResult.cursor, events: [validCall, validResult], ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");
    expect(graph.coreEvents.acknowledge("lane-valid-page", [validCall.eventId, validResult.eventId], "projected", "2026-10-08T00:00:02.000Z")).toBe("settled");

    const first = graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 1, observedAt: "2026-10-08T00:00:03.000Z" });
    expect(first).toMatchObject({ recoveredAgents: 0, visibleChanged: false, remaining: true, nextCursor: expect.any(String) });
    const second = graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 1, afterCursor: first.nextCursor, observedAt: "2026-10-08T00:00:04.000Z" });
    expect(second).toMatchObject({ recoveredAgents: 1, visibleChanged: true, remaining: false, nextCursor: null });
    expect(graph.sessionActivity.load(
      { kind: "pane", workspaceId: "workspace-2", paneId: "primary-pane-2" },
      { bindingId: "binding-2", bindingGeneration: 1, sessionEpoch: 1 }
    )?.items).toContainEqual(expect.objectContaining({ kind: "agent", itemId: "binding-2-agent", label: "Curie · GPT-5.6-Sol" }));
    context.close();
  });

  it("projects recovered activity through durable Main and current Answer-card invalidation once", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    graph.bindings.updateBinding("binding-1", { statusMessageId: "root-1" });
    graph.projections.saveTopicView(updateTopicView(initialTopicView("binding-1"), {
      bindingGeneration: 1, workspaceId: "workspace-1", paneId: "primary-pane", phase: "ready", title: "Primary"
    }));
    connectPrepared(graph);
    graph.sessionActivity.setCardRenderers({
      main: (view, activity) => ({ revision: view.sessionActivityRevision, agents: activity?.items.filter(({ kind }) => kind === "agent").length ?? 0 }),
      pane: (view, activity) => ({ revision: view.sessionActivityRevision, agents: activity?.items.filter(({ kind }) => kind === "agent").length ?? 0 })
    });
    const now = "2026-10-09T00:00:00.000Z";
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
      start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
    ) VALUES('recovery-current','lane:recovery','primary','binding-1',1,'traex','session-1','current',1,0,'working',1,'root-1',?,?)`).run(now, now);
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,created_at,updated_at
    ) VALUES('recovery-current:page:0','recovery-current',0,'answer-1','card-1','turn-card:recovery-current:page:0','active',1,1,?,?)`).run(now, now);
    const notifications: unknown[] = [];
    graph.conversationSegments.setProjectionNotifier((notification) => { notifications.push(notification); });
    const call = event("visible-recovery-call", { type: "tool_call", call_id: "visible", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({}), truncated: false });
    const result = event("visible-recovery-result", { type: "tool_result", call_id: "visible", text: JSON.stringify({ agent_id: "visible-agent", nickname: "Visible" }), is_error: false, truncated: false });
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-visible-recovery", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: result.cursor, latestCursor: result.cursor, events: [call, result], ingestedAt: now
    })).toBe("accepted");
    expect(graph.coreEvents.acknowledge("lane-visible-recovery", [call.eventId, result.eventId], "projected", now)).toBe("settled");

    expect(graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 10, observedAt: "2026-10-09T00:00:01.000Z" }))
      .toMatchObject({ recoveredAgents: 1, visibleChanged: true, remaining: false, nextCursor: null });
    expect(graph.projections.loadTopicView("binding-1")?.sessionActivityRevision).toBe(1);
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE binding_id='binding-1' AND target_role='session_status'").get()).toEqual({ count: 1 });
    expect(graph.conversationSegments.getConversationSegment("recovery-current")?.viewVersion).toBe(2);
    expect(notifications).toContainEqual({ segmentId: "recovery-current", viewVersion: 2, urgency: "immediate" });

    expect(graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 10, observedAt: "2026-10-09T00:00:02.000Z" }))
      .toMatchObject({ recoveredAgents: 0, visibleChanged: false, remaining: false, nextCursor: null });
    expect(graph.projections.loadTopicView("binding-1")?.sessionActivityRevision).toBe(1);
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE binding_id='binding-1' AND target_role='session_status'").get()).toEqual({ count: 1 });
    expect(graph.conversationSegments.getConversationSegment("recovery-current")?.viewVersion).toBe(2);
    context.close();
  });

  it("recovers only exact settled retained pairs, preserves metadata, and reports bounded remainder without Core mutation", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const ingest = (laneId: string, events: readonly CoreEventEnvelope[], sessionId = "session-1", settle = true) => {
      expect(graph.coreEvents.ingestBatch({
        laneId, sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId,
        afterCursor: "start", nextCursor: events.at(-1)!.cursor, latestCursor: events.at(-1)!.cursor,
        events, ingestedAt: "2026-10-08T00:00:01.000Z"
      })).toBe("accepted");
      if (settle) expect(graph.coreEvents.acknowledge(laneId, events.map(({ eventId }) => eventId), "projected", "2026-10-08T00:00:02.000Z")).toBe("settled");
    };
    const spawnCall = event("bounded-spawn-call", { type: "tool_call", call_id: "spawn", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({ model: "GPT-5.6-Terra" }), truncated: false });
    const spawnResult = event("bounded-spawn-result", { type: "tool_result", call_id: "spawn", text: JSON.stringify({ agent_id: "agent-a", nickname: "Planck" }), is_error: false, truncated: false });
    const waitCall = event("bounded-wait-call", { type: "tool_call", call_id: "wait", name: "multi_agent_v1__wait_agent", arguments: JSON.stringify({ targets: ["agent-a"], timeout_ms: 1 }), truncated: false });
    const waitResult = event("bounded-wait-result", { type: "tool_result", call_id: "wait", text: JSON.stringify({ status: {}, timed_out: true, pending: { items: [{ target: "agent-a", phase: "model_running", since_ms: 1, operation: "run" }] }, wake_reason: "timeout" }), is_error: false, truncated: false });
    const secondCall = event("bounded-second-call", { type: "tool_call", call_id: "second", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({ model: "GPT-5.6-Sol" }), truncated: false });
    const secondResult = event("bounded-second-result", { type: "tool_result", call_id: "second", text: JSON.stringify({ agent_id: "agent-b", nickname: "Curie" }), is_error: false, truncated: false });
    ingest("lane-recovery", [spawnCall, spawnResult, waitCall, waitResult, secondCall, secondResult]);

    const otherCall = { ...event("other-call", { type: "tool_call", call_id: "other", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({}), truncated: false }), sessionId: "other-session" };
    const otherResult = { ...event("other-result", { type: "tool_result", call_id: "other", text: JSON.stringify({ agent_id: "other-agent", nickname: "Other" }), is_error: false, truncated: false }), sessionId: "other-session" };
    ingest("lane-other", [otherCall, otherResult], "other-session");
    const ambiguousCall = event("ambiguous-call-a", { type: "tool_call", call_id: "ambiguous", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({}), truncated: false });
    const ambiguousCallAgain = event("ambiguous-call-b", { type: "tool_call", call_id: "ambiguous", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({}), truncated: false });
    const ambiguousResult = event("ambiguous-result", { type: "tool_result", call_id: "ambiguous", text: JSON.stringify({ agent_id: "ambiguous-agent", nickname: "Ambiguous" }), is_error: false, truncated: false });
    ingest("lane-ambiguous-retained", [ambiguousCall, ambiguousCallAgain, ambiguousResult]);
    const compactCall = event("compact-call", { type: "tool_call", call_id: "compact", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({}), truncated: false });
    const compactResult = event("compact-result", { type: "tool_result", call_id: "compact", text: JSON.stringify({ agent_id: "compacted-agent", nickname: "Compacted" }), is_error: false, truncated: false });
    ingest("lane-compacted", [compactCall, compactResult]);
    context.database.prepare("UPDATE core_event_inbox SET payload_compacted_at=? WHERE event_id=?").run("2026-10-08T00:00:03.000Z", compactResult.eventId);
    const incompleteCall = event("incomplete-call", { type: "tool_call", call_id: "incomplete", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({}), truncated: false });
    ingest("lane-incomplete", [incompleteCall]);
    const pendingCall = event("pending-call", { type: "tool_call", call_id: "pending", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({}), truncated: false });
    const pendingResult = event("pending-result", { type: "tool_result", call_id: "pending", text: JSON.stringify({ agent_id: "pending-agent", nickname: "Pending" }), is_error: false, truncated: false });
    ingest("lane-pending", [pendingCall, pendingResult], "session-1", false);
    const beforeCore = context.database.prepare("SELECT state,event_id FROM core_event_lane_items ORDER BY lane_id,sequence").all();
    const beforeCheckpoints = context.database.prepare("SELECT lane_id,read_cursor,latest_cursor FROM core_event_lane_checkpoints ORDER BY lane_id").all();
    const beforeInputs = context.database.prepare("SELECT COUNT(*) AS count FROM submission_intents").get();

    const firstRecovery = graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 1, observedAt: "2026-10-08T00:00:04.000Z" });
    expect(firstRecovery).toMatchObject({ recoveredAgents: 1, visibleChanged: true, remaining: true, nextCursor: expect.any(String) });
    const secondRecovery = graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 1, afterCursor: firstRecovery.nextCursor, observedAt: "2026-10-08T00:00:05.000Z" });
    expect(secondRecovery).toMatchObject({ recoveredAgents: 1, visibleChanged: true, remaining: true, nextCursor: expect.any(String) });
    expect(graph.sessionActivity.recoverRetainedMultiAgentActivity({ limit: 100, afterCursor: secondRecovery.nextCursor, observedAt: "2026-10-08T00:00:06.000Z" }))
      .toMatchObject({ recoveredAgents: 1, visibleChanged: true, remaining: false, nextCursor: null });
    expect(load(graph)?.items.filter(({ kind }) => kind === "agent")).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: "agent-a", label: "Planck · GPT-5.6-Terra", state: "running", terminal: false }),
      expect.objectContaining({ itemId: "agent-b", label: "Curie · GPT-5.6-Sol", state: "started", terminal: false })
    ]));
    expect(load(graph)?.items.some(({ itemId }) => ["other-agent", "ambiguous-agent", "compacted-agent", "pending-agent"].includes(itemId))).toBe(false);
    expect(context.database.prepare("SELECT state,event_id FROM core_event_lane_items ORDER BY lane_id,sequence").all()).toEqual(beforeCore);
    expect(context.database.prepare("SELECT lane_id,read_cursor,latest_cursor FROM core_event_lane_checkpoints ORDER BY lane_id").all()).toEqual(beforeCheckpoints);
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM submission_intents").get()).toEqual(beforeInputs);
    context.close();
  });

  it("rejects stale Primary and Worker runtime identities without replacing current state", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    activateWorker(context);
    project(graph, primaryContext(), 1, event("primary-model", { type: "model_changed", model: "current-primary" }));
    project(graph, primaryContext(), 2, event("primary-agent", {
      type: "agent_activity", agent_id: "current-agent", display_name: "Current", model: "Current Model", state: "running"
    }));
    project(graph, workerContext(), 1, { ...event("worker-model", { type: "model_changed", model: "current-worker" }), sessionId: "worker-session" });

    expect(project(graph, primaryContext({
      producer: { kind: "primary", id: "binding-1", runtimeGeneration: 2, sessionGeneration: 1, runtimePaneId: "primary-pane" }
    }), 3, event("stale-primary", {
      type: "agent_activity", agent_id: "current-agent", display_name: "Stale", model: "Stale Model", state: "completed"
    })).outcome).toBe("stale");
    expect(project(graph, workerContext({
      producer: { kind: "worker", id: "worker-1", runtimeGeneration: 2, sessionGeneration: 1, runtimePaneId: "worker-pane" }
    }), 2, { ...event("stale-worker-runtime", { type: "model_changed", model: "stale-worker" }), sessionId: "worker-session" }).outcome).toBe("stale");
    expect(project(graph, workerContext({
      ownerFence: { kind: "worker", id: "worker-1", generation: 1, sessionGeneration: 2, parent: { id: "binding-1", generation: 1, sessionGeneration: 1 } },
      producer: { kind: "worker", id: "worker-1", runtimeGeneration: 1, sessionGeneration: 2, runtimePaneId: "worker-pane" }
    }), 3, { ...event("stale-worker-session", { type: "model_changed", model: "stale-session" }), sessionId: "worker-session" }).outcome).toBe("stale");

    const view = load(graph)!;
    expect(view.snapshot.currentModel).toBe("current-primary");
    expect(view.items).toContainEqual(expect.objectContaining({
      itemId: "current-agent", label: "Current · Current Model", state: "running", terminal: false
    }));
    expect(context.database.prepare("SELECT display_name,model FROM session_activity_agent_identities WHERE agent_id='current-agent'").get())
      .toEqual({ display_name: "Current", model: "Current Model" });
    expect(context.database.prepare("SELECT current_model FROM session_activity_snapshots WHERE producer_kind='worker'").get())
      .toEqual({ current_model: "current-worker" });
    context.close();
  });

  it("rejects out-of-order lane events and atomically replaces the current Task List", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const identity = primaryContext();
    expect(graph.sessionActivity.projectCanonicalEvent({
      context: identity, laneId: "lane-1", laneSequence: 10, sourceId: "ring-1", sourceEpoch: "epoch-1",
      event: event("tasks-one", { type: "message", channel: "commentary", text: "ignored" }), observedAt: "2026-10-08T00:00:01.000Z",
      taskList: [{ id: "task-a", label: "A", state: "active" }, { id: "task-b", label: "B", state: "pending" }]
    }).outcome).toBe("projected");
    expect(graph.sessionActivity.projectCanonicalEvent({
      context: identity, laneId: "lane-1", laneSequence: 12, sourceId: "ring-1", sourceEpoch: "epoch-1",
      event: event("tasks-two", { type: "message", channel: "commentary", text: "ignored" }), observedAt: "2026-10-08T00:00:02.000Z",
      taskList: [{ id: "task-b", label: "B done", state: "completed" }, { id: "task-c", label: "C", state: "active" }]
    }).outcome).toBe("projected");
    expect(project(graph, identity, 11, event("late-model", { type: "model_changed", model: "must-not-win" })).outcome).toBe("stale");

    expect(load(graph, identity.scope)?.items.map(({ itemId, label, state }) => ({ itemId, label, state }))).toEqual([
      { itemId: "task-b", label: "B done", state: "completed" },
      { itemId: "task-c", label: "C", state: "active" }
    ]);
    expect(load(graph, identity.scope)?.snapshot.currentModel).toBeNull();
    context.close();
  });

  it("preserves Task List ordinal and retains the first eight active tasks", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const tasks = Array.from({ length: 12 }, (_, ordinal) => ({ id: `plan:${ordinal}`, label: `Step ${ordinal}`, state: "active" }));
    expect(graph.sessionActivity.projectCanonicalEvent({
      context: primaryContext(), laneId: "lane-1", laneSequence: 1, sourceId: "ring-1", sourceEpoch: "epoch-1",
      event: event("large-plan", { type: "message", channel: "commentary", text: "ignored" }),
      observedAt: "2026-10-08T00:00:01.000Z", taskList: tasks
    }).outcome).toBe("projected");
    expect(load(graph)?.items.map(({ itemId, ordinal, label }) => ({ itemId, ordinal, label }))).toEqual(
      tasks.slice(0, 8).map((task, ordinal) => ({ itemId: task.id, ordinal, label: task.label }))
    );
    context.close();
  });

  it("advances the Topic revision and clears terminated Worker activity even on an ignored Primary event", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    activateWorker(context);
    graph.bindings.updateBinding("binding-1", { statusMessageId: "root-1" });
    graph.projections.saveTopicView(updateTopicView(initialTopicView("binding-1"), {
      bindingGeneration: 1, workspaceId: "workspace-1", paneId: "primary-pane", phase: "ready", title: "Primary"
    }));
    connectPrepared(graph);
    graph.sessionActivity.setCardRenderers({
      main: (view, activity) => ({ revision: view.sessionActivityRevision, items: activity?.items.map(({ itemId }) => itemId) ?? [] }),
      pane: (view, activity) => ({ revision: view.sessionActivityRevision, items: activity?.items.map(({ itemId }) => itemId) ?? [] })
    });
    project(graph, primaryContext(), 1, event("primary-model", { type: "model_changed", model: "primary" }));
    project(graph, workerContext(), 1, { ...event("worker-agent", { type: "agent_activity", agent_id: "reviewer", state: "running" }), sessionId: "worker-session" });
    expect(graph.projections.loadTopicView("binding-1")?.sessionActivityRevision).toBe(2);
    for (const reply of graph.outbox.listPendingOutboundReplies()) graph.outbox.markOutboundReplyDelivered(reply.id, "root-1");

    context.database.prepare("UPDATE agent_instances SET worker_session_lifecycle='terminated' WHERE id='worker-1'").run();
    expect(project(graph, primaryContext(), 2, event("cleanup-trigger", { type: "message", channel: "commentary", text: "ignored" })))
      .toEqual({ outcome: "projected", visibleChanged: true });
    expect(graph.projections.loadTopicView("binding-1")?.sessionActivityRevision).toBe(3);
    expect(load(graph)?.items).toEqual([]);
    expect((context.database.prepare(`SELECT payload FROM outbound_replies WHERE binding_id='binding-1'
      ORDER BY delivery_order DESC LIMIT 1`).get() as { payload: string }).payload).not.toContain("reviewer");
    context.close();
  });

  it("retains pending Core evidence while rolling back activity, Topic revision, and delivery when rendering fails", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    graph.bindings.updateBinding("binding-1", { statusMessageId: "root-1" });
    const topic = updateTopicView(initialTopicView("binding-1"), {
      bindingGeneration: 1, workspaceId: "workspace-1", paneId: "primary-pane", phase: "ready", title: "Primary"
    });
    graph.projections.saveTopicView(topic);
    connectPrepared(graph);
    graph.sessionActivity.setCardRenderers({
      main() { throw new Error("render failed"); },
      pane() { return {}; }
    });
    const item = event("atomic-agent", { type: "agent_activity", agent_id: "reviewer", display_name: "Reviewer", state: "running" });

    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-atomic", sourceId: item.sourceId, sourceEpoch: "epoch-1", agentKind: item.agentKind, sessionId: item.sessionId,
      sessionActivityContext: primaryContext(), afterCursor: "start", nextCursor: "cursor:1", latestCursor: "cursor:1", events: [item], ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");

    expect(load(graph)).toBeNull();
    expect(graph.coreEvents.getCheckpoint("lane-atomic")).toMatchObject({ readCursor: "cursor:1", latestCursor: "cursor:1" });
    expect(context.database.prepare("SELECT 1 AS present FROM core_event_inbox WHERE event_id='atomic-agent'").get()).toEqual({ present: 1 });
    expect(context.database.prepare("SELECT state FROM core_event_lane_items WHERE lane_id='lane-atomic' AND event_id='atomic-agent'").get()).toEqual({ state: "pending" });
    expect(graph.projections.loadTopicView("binding-1")?.viewVersion).toBe(topic.viewVersion);
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    context.close();
  });

  it("does not invalidate a displayable Topic for the first invisible event", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    graph.bindings.updateBinding("binding-1", { statusMessageId: "root-1" });
    const topic = updateTopicView(initialTopicView("binding-1"), {
      bindingGeneration: 1, workspaceId: "workspace-1", paneId: "primary-pane", phase: "ready", title: "Primary"
    });
    graph.projections.saveTopicView(topic);
    connectPrepared(graph);
    graph.sessionActivity.setCardRenderers({
      main: (view, activity) => ({ revision: view.sessionActivityRevision, model: activity?.snapshot.currentModel ?? null }),
      pane: (view, activity) => ({ revision: view.sessionActivityRevision, model: activity?.snapshot.currentModel ?? null })
    });

    expect(project(graph, primaryContext(), 1, event("first-tool", { type: "tool_call", call_id: "call-1", name: "exec" })))
      .toEqual({ outcome: "projected", visibleChanged: false });
    expect(graph.projections.loadTopicView("binding-1")).toMatchObject({
      sessionActivityRevision: topic.sessionActivityRevision,
      viewVersion: topic.viewVersion
    });
    expect(context.database.prepare(`SELECT COUNT(*) AS count FROM outbound_replies
      WHERE binding_id='binding-1' AND target_role='session_status'`).get()).toEqual({ count: 0 });

    expect(project(graph, primaryContext(), 2, event("first-model", { type: "model_changed", model: "GPT-5.6-Sol" })))
      .toEqual({ outcome: "projected", visibleChanged: true });
    expect(graph.projections.loadTopicView("binding-1")).toMatchObject({
      sessionActivityRevision: topic.sessionActivityRevision + 1,
      viewVersion: topic.viewVersion + 1
    });
    expect(context.database.prepare(`SELECT COUNT(*) AS count FROM outbound_replies
      WHERE binding_id='binding-1' AND target_role='session_status'`).get()).toEqual({ count: 1 });
    context.close();
  });

  it("advances the single Topic card revision and reserves one Pane delivery for a visible Subagent delta", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    graph.bindings.updateBinding("binding-1", { statusMessageId: "root-1" });
    const topic = updateTopicView(initialTopicView("binding-1"), {
      bindingGeneration: 1, workspaceId: "workspace-1", paneId: "primary-pane", phase: "ready", title: "Primary"
    });
    graph.projections.saveTopicView(topic);
    connectPrepared(graph);
    graph.sessionActivity.setCardRenderers({
      main: (view, activity) => ({ revision: view.sessionActivityRevision, model: activity?.snapshot.currentModel ?? null }),
      pane: (view, activity) => ({ revision: view.sessionActivityRevision, model: activity?.snapshot.currentModel ?? null })
    });
    const item = event("delivered-agent", { type: "agent_activity", agent_id: "reviewer", display_name: "Reviewer", state: "running" });
    const input = {
      laneId: "lane-delivery", sourceId: item.sourceId, sourceEpoch: "epoch-1", agentKind: item.agentKind, sessionId: item.sessionId,
      sessionActivityContext: primaryContext(), afterCursor: "start", nextCursor: "cursor:1", latestCursor: "cursor:1", events: [item], ingestedAt: "2026-10-08T00:00:01.000Z"
    } as const;

    graph.coreEvents.ingestBatch(input);
    const projected = graph.projections.loadTopicView("binding-1")!;
    expect(projected.sessionActivityRevision).toBe(1);
    expect(projected.viewVersion).toBe(topic.viewVersion + 1);
    expect(context.database.prepare(`SELECT source_id,source_epoch,token_usage,context_usage
      FROM session_activity_snapshots WHERE producer_kind='primary'`).get()).toEqual({
      source_id: "ring-1", source_epoch: "epoch-1", token_usage: null, context_usage: null
    });
    expect(context.database.prepare(`SELECT COUNT(*) AS count FROM outbound_replies
      WHERE binding_id='binding-1' AND target_role='session_status'`).get()).toEqual({ count: 1 });

    graph.coreEvents.ingestBatch(input);
    expect(graph.projections.loadTopicView("binding-1")?.viewVersion).toBe(projected.viewVersion);
    expect(context.database.prepare(`SELECT COUNT(*) AS count FROM outbound_replies
      WHERE binding_id='binding-1' AND target_role='session_status'`).get()).toEqual({ count: 1 });
    context.close();
  });

  it("projects token usage by latest lane with response-turn-thread fallback, floor/clamp, and stale-limit clearing", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);

    expect(project(graph, primaryContext(), 1, event("token-response", tokenUsagePayload({ responseTotal: 105, modelContextWindow: 400 })))).toMatchObject({
      outcome: "projected",
      visibleChanged: true
    });
    expect(load(graph)?.snapshot).toMatchObject({ tokenUsage: 105, contextUsage: 26 });

    expect(graph.sessionActivity.projectCanonicalEvent({
      context: primaryContext(),
      laneId: "lane-1",
      laneSequence: 1,
      sourceId: "ring-1",
      sourceEpoch: "epoch-1",
      event: event("token-response", tokenUsagePayload({ responseTotal: 105, modelContextWindow: 400 })),
      observedAt: "2026-10-08T00:00:01.000Z"
    }).outcome).toBe("duplicate");
    expect(load(graph)?.snapshot).toMatchObject({ tokenUsage: 105, contextUsage: 26 });

    expect(graph.sessionActivity.projectCanonicalEvent({
      context: primaryContext(),
      laneId: "lane-1",
      laneSequence: 0,
      sourceId: "ring-1",
      sourceEpoch: "epoch-1",
      event: event("token-old", tokenUsagePayload({ responseTotal: 999, modelContextWindow: 1_000 })),
      observedAt: "2026-10-08T00:00:01.000Z"
    }).outcome).toBe("stale");
    expect(load(graph)?.snapshot).toMatchObject({ tokenUsage: 105, contextUsage: 26 });

    expect(project(graph, primaryContext(), 2, event("token-turn", tokenUsagePayload({ responseTotal: 110, turnTotal: 150, autoCompactLimit: 300 })))).toMatchObject({
      outcome: "projected",
      visibleChanged: true
    });
    expect(load(graph)?.snapshot).toMatchObject({ tokenUsage: 150, contextUsage: 50 });

    expect(project(graph, primaryContext(), 3, event("token-thread", tokenUsagePayload({ responseTotal: 120, turnTotal: 150, threadTotal: 1_050, autoCompactLimit: 3_000 })))).toMatchObject({
      outcome: "projected",
      visibleChanged: true
    });
    expect(load(graph)?.snapshot).toMatchObject({ tokenUsage: 1_050, contextUsage: 35 });

    expect(project(graph, primaryContext(), 4, event("token-clear-limit", tokenUsagePayload({ responseTotal: 171, threadTotal: 171 })))).toMatchObject({
      outcome: "projected",
      visibleChanged: true
    });
    expect(load(graph)?.snapshot).toMatchObject({ tokenUsage: 171, contextUsage: null });

    expect(project(graph, primaryContext(), 5, event("token-floor", tokenUsagePayload({ responseTotal: 171, modelContextWindow: 500 })))).toMatchObject({
      outcome: "projected",
      visibleChanged: true
    });
    expect(load(graph)?.snapshot).toMatchObject({ tokenUsage: 171, contextUsage: 34 });

    expect(project(graph, primaryContext(), 6, event("token-clamp", tokenUsagePayload({ responseTotal: 5_000, autoCompactLimit: 3_000 })))).toMatchObject({
      outcome: "projected",
      visibleChanged: true
    });
    expect(load(graph)?.snapshot).toMatchObject({ tokenUsage: 5_000, contextUsage: 100 });
    context.close();
  });

  it("reopens from disk with persisted token usage and context percentage", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-session-activity-token-"));
    const path = join(directory, "state.sqlite");
    const firstContext = new SqliteContext(path);
    const first = new SqliteCapabilityGraph(firstContext);
    activatePrimary(first);
    project(first, primaryContext(), 1, event("token-persisted", tokenUsagePayload({ responseTotal: 1_050, autoCompactLimit: 3_000 })));
    firstContext.close();

    const secondContext = new SqliteContext(path);
    try {
      const second = new SqliteCapabilityGraph(secondContext);
      expect(load(second)?.snapshot).toMatchObject({ tokenUsage: 1_050, contextUsage: 35 });
    } finally {
      secondContext.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rebuilds token usage from replay after deleting the derived snapshot row", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const first = event("token-live-1", tokenUsagePayload({ responseTotal: 105, modelContextWindow: 400 }));
    const second = event("token-live-2", tokenUsagePayload({ responseTotal: 171, threadTotal: 171, modelContextWindow: 500 }));

    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-live",
      sourceId: first.sourceId,
      sourceEpoch: "epoch-1",
      agentKind: first.agentKind,
      sessionId: first.sessionId,
      sessionActivityContext: primaryContext(),
      afterCursor: "start",
      nextCursor: second.cursor,
      latestCursor: second.cursor,
      events: [first, second],
      ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");
    expect(load(graph)?.snapshot).toMatchObject({ tokenUsage: 171, contextUsage: 34 });

    context.database.prepare("DELETE FROM session_activity_snapshots WHERE producer_kind='primary' AND producer_id='binding-1'").run();
    expect(load(graph)).toBeNull();

    const replayFirst = { ...event("token-live-1", tokenUsagePayload({ responseTotal: 105, modelContextWindow: 400 })), sourceId: "replay-source-1", cursor: "replay:1" };
    const replaySecond = { ...event("token-live-2", tokenUsagePayload({ responseTotal: 171, threadTotal: 171, modelContextWindow: 500 })), sourceId: "replay-source-1", cursor: "replay:2" };
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-replay",
      sourceId: "replay-source-1",
      sourceEpoch: "epoch-replay",
      agentKind: replayFirst.agentKind,
      sessionId: replayFirst.sessionId,
      sessionActivityContext: primaryContext(),
      afterCursor: "start",
      nextCursor: replaySecond.cursor,
      latestCursor: replaySecond.cursor,
      events: [replayFirst, replaySecond],
      ingestedAt: "2026-10-08T00:00:02.000Z"
    })).toBe("accepted");

    expect(load(graph)?.snapshot).toMatchObject({ tokenUsage: 171, contextUsage: 34 });
    context.close();
  });

  it("retries an exact token replay after transient Session Activity projection failure", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const live = event("token-retry", tokenUsagePayload({ responseTotal: 171, modelContextWindow: 500 }));

    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-live-retry",
      sourceId: live.sourceId,
      sourceEpoch: "epoch-live-retry",
      agentKind: live.agentKind,
      sessionId: live.sessionId,
      sessionActivityContext: primaryContext(),
      afterCursor: "start",
      nextCursor: live.cursor,
      latestCursor: live.cursor,
      events: [live],
      ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");
    context.database.prepare("DELETE FROM session_activity_snapshots WHERE producer_kind='primary' AND producer_id='binding-1'").run();
    expect(load(graph)).toBeNull();

    const projectCanonicalEvent = graph.sessionActivity.projectCanonicalEvent.bind(graph.sessionActivity);
    const projection = vi.spyOn(graph.sessionActivity, "projectCanonicalEvent")
      .mockImplementationOnce(() => { throw new Error("simulated Session Activity projection failure"); })
      .mockImplementation((input) => projectCanonicalEvent(input));
    const replay = { ...live, sourceId: "replay-source-retry", cursor: "replay:1" };
    const replayBatch = {
      laneId: "lane-replay-retry",
      sourceId: replay.sourceId,
      sourceEpoch: "epoch-replay-retry",
      agentKind: replay.agentKind,
      sessionId: replay.sessionId,
      sessionActivityContext: primaryContext(),
      afterCursor: "start",
      nextCursor: replay.cursor,
      latestCursor: replay.cursor,
      events: [replay],
      ingestedAt: "2026-10-08T00:00:02.000Z"
    } as const;

    expect(() => graph.coreEvents.ingestBatch(replayBatch)).toThrow("SQLite savepoint operation failed");
    expect(load(graph)).toBeNull();
    expect(graph.coreEvents.getCheckpoint(replayBatch.laneId)).toBeNull();

    expect(graph.coreEvents.ingestBatch(replayBatch)).toBe("accepted");
    expect(projection).toHaveBeenCalledTimes(2);
    expect(load(graph)?.snapshot).toMatchObject({ tokenUsage: 171, contextUsage: 34 });
    context.close();
  });

  it("projects context snapshots by latest lane and recomputes usage from stored tokens without regression", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);

    expect(project(graph, primaryContext(), 1, event("token-context-base", tokenUsagePayload({ responseTotal: 171, threadTotal: 171 })))).toMatchObject({
      outcome: "projected",
      visibleChanged: true
    });
    expect(load(graph)?.snapshot).toMatchObject({ tokenUsage: 171, contextUsage: null, currentModel: null });

    expect(project(graph, primaryContext(), 2, event("context-live", contextSnapshotPayload({
      model: "GPT-5.6-Sol",
      provider: "trae",
      collaborationMode: "default",
      permissionMode: "managed",
      currentDate: "2026-10-22",
      timezone: "Etc/UTC",
      modelContextWindow: 500
    })))).toMatchObject({
      outcome: "projected",
      visibleChanged: true
    });
    expect(load(graph)?.snapshot).toMatchObject({ currentModel: "GPT-5.6-Sol", tokenUsage: 171, contextUsage: 34 });

    expect(graph.sessionActivity.projectCanonicalEvent({
      context: primaryContext(),
      laneId: "lane-1",
      laneSequence: 2,
      sourceId: "ring-1",
      sourceEpoch: "epoch-1",
      event: event("context-live", contextSnapshotPayload({ model: "GPT-5.6-Sol", modelContextWindow: 500 })),
      observedAt: "2026-10-08T00:00:01.000Z"
    }).outcome).toBe("duplicate");
    expect(load(graph)?.snapshot).toMatchObject({ currentModel: "GPT-5.6-Sol", tokenUsage: 171, contextUsage: 34 });

    expect(graph.sessionActivity.projectCanonicalEvent({
      context: primaryContext(),
      laneId: "lane-1",
      laneSequence: 1,
      sourceId: "ring-1",
      sourceEpoch: "epoch-1",
      event: event("context-old", contextSnapshotPayload({ model: "GPT-5.6-Terra", autoCompactLimit: 300 })),
      observedAt: "2026-10-08T00:00:01.000Z"
    }).outcome).toBe("stale");
    expect(load(graph)?.snapshot).toMatchObject({ currentModel: "GPT-5.6-Sol", tokenUsage: 171, contextUsage: 34 });
    context.close();
  });

  it("reopens from disk with persisted context snapshot model and recomputed percentage", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-session-activity-context-"));
    const path = join(directory, "state.sqlite");
    const firstContext = new SqliteContext(path);
    const first = new SqliteCapabilityGraph(firstContext);
    activatePrimary(first);
    project(first, primaryContext(), 1, event("token-persisted-context", tokenUsagePayload({ responseTotal: 171, threadTotal: 171 })));
    project(first, primaryContext(), 2, event("context-persisted", contextSnapshotPayload({
      model: "GPT-5.6-Sol",
      autoCompactLimit: 500
    })));
    firstContext.close();

    const secondContext = new SqliteContext(path);
    try {
      const second = new SqliteCapabilityGraph(secondContext);
      expect(load(second)?.snapshot).toMatchObject({ currentModel: "GPT-5.6-Sol", tokenUsage: 171, contextUsage: 34 });
    } finally {
      secondContext.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rebuilds context snapshot facts from exact replay after deleting the derived snapshot row", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    activatePrimary(graph);
    const token = event("token-live-context", tokenUsagePayload({ responseTotal: 171, threadTotal: 171 }));
    const snapshot = event("context-live-context", contextSnapshotPayload({
      model: "GPT-5.6-Sol",
      provider: "trae",
      permissionMode: "managed",
      autoCompactLimit: 500
    }));

    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-live-context",
      sourceId: token.sourceId,
      sourceEpoch: "epoch-1",
      agentKind: token.agentKind,
      sessionId: token.sessionId,
      sessionActivityContext: primaryContext(),
      afterCursor: "start",
      nextCursor: snapshot.cursor,
      latestCursor: snapshot.cursor,
      events: [token, snapshot],
      ingestedAt: "2026-10-08T00:00:01.000Z"
    })).toBe("accepted");
    expect(load(graph)?.snapshot).toMatchObject({ currentModel: "GPT-5.6-Sol", tokenUsage: 171, contextUsage: 34 });

    context.database.prepare("DELETE FROM session_activity_snapshots WHERE producer_kind='primary' AND producer_id='binding-1'").run();
    expect(load(graph)).toBeNull();

    const replayToken = { ...token, sourceId: "replay-source-context", cursor: "replay-context:1" };
    const replaySnapshot = { ...snapshot, sourceId: "replay-source-context", cursor: "replay-context:2" };
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-replay-context",
      sourceId: "replay-source-context",
      sourceEpoch: "epoch-replay",
      agentKind: replayToken.agentKind,
      sessionId: replayToken.sessionId,
      sessionActivityContext: primaryContext(),
      afterCursor: "start",
      nextCursor: replaySnapshot.cursor,
      latestCursor: replaySnapshot.cursor,
      events: [replayToken, replaySnapshot],
      ingestedAt: "2026-10-08T00:00:02.000Z"
    })).toBe("accepted");

    expect(load(graph)?.snapshot).toMatchObject({ currentModel: "GPT-5.6-Sol", tokenUsage: 171, contextUsage: 34 });
    context.close();
  });
});
