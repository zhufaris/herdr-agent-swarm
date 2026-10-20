import { z } from "zod";
import type { CoreEventEnvelope } from "../domain/core-event-inbox.js";
import type { SessionActivityAgentLifecycleMutation } from "../domain/session-activity.js";

const MAX_PROTOCOL_JSON_BYTES = 16 * 1024;
const identifier = z.string().min(1).max(256);
const boundedText = z.string().min(1).max(256);
const callSchema = z.object({ type: z.literal("tool_call"), call_id: identifier, name: z.string().max(256), arguments: z.string(), truncated: z.boolean() });
const resultSchema = z.object({ type: z.literal("tool_result"), call_id: identifier, text: z.string(), is_error: z.boolean(), truncated: z.boolean() });
const spawnArgumentsSchema = z.object({ model: boundedText.optional() }).passthrough();
const spawnResultSchema = z.object({ agent_id: identifier.optional(), task_name: identifier.optional(), nickname: boundedText.optional() }).passthrough()
  .refine((value) => Boolean(value.agent_id ?? value.task_name));
const waitArgumentsSchema = z.object({ targets: z.array(identifier).min(1).max(64).optional(), timeout_ms: z.number().int().nonnegative(), return_on_activity: z.boolean().optional() }).passthrough();
const waitItemSchema = z.object({ target: identifier, phase: z.enum(["local_capacity", "provider_queue", "awaiting_model", "model_running", "tool_running", "waiting_dependency", "waiting_approval"]), since_ms: z.number().int().nonnegative(), operation: boundedText }).passthrough();
const waitResultSchema = z.object({
  status: z.record(z.unknown()).optional(),
  timed_out: z.boolean().optional(),
  pending: z.object({ items: z.array(z.unknown()).max(64) }).passthrough(),
  wake_reason: boundedText.optional(),
  message: boundedText.optional()
}).passthrough();
const closeArgumentsSchema = z.object({ target: identifier }).passthrough();
const terminalStatusSchema = z.union([
  z.object({ completed: z.string() }).strict(), z.object({ failed: z.string() }).strict(), z.object({ interrupted: z.string() }).strict()
]);
const closePreviousStatusSchema = z.enum(["working", "running", "idle", "blocked", "completed", "done", "failed", "interrupted"]);
const closeResultSchema = z.object({ previous_status: z.union([closePreviousStatusSchema, terminalStatusSchema]) }).passthrough();

/** Converts exact, correlated multi-agent Tool evidence into bounded presentation facts. */
export function translateMultiAgentToolLifecycle(
  callEvent: CoreEventEnvelope,
  resultEvent: CoreEventEnvelope
): readonly SessionActivityAgentLifecycleMutation[] {
  if (callEvent.agentKind !== resultEvent.agentKind || callEvent.sessionId !== resultEvent.sessionId) return [];
  const call = callSchema.safeParse(callEvent.payload);
  const result = resultSchema.safeParse(resultEvent.payload);
  if (!call.success || !result.success || call.data.truncated || result.data.truncated || result.data.is_error || call.data.call_id !== result.data.call_id) return [];
  const argumentsValue = parseJson(call.data.arguments);
  const resultValue = parseJson(result.data.text);
  if (!argumentsValue || !resultValue) return [];

  if (isSpawnTool(call.data.name)) {
    const argumentsData = spawnArgumentsSchema.safeParse(argumentsValue);
    const resultData = spawnResultSchema.safeParse(resultValue);
    if (!argumentsData.success || !resultData.success) return [];
    const agentId = resultData.data.agent_id ?? resultData.data.task_name;
    if (!agentId) return [];
    return [{
      agentId,
      displayName: resultData.data.nickname ?? resultData.data.task_name ?? agentId,
      ...(argumentsData.data.model ? { model: argumentsData.data.model } : {}),
      state: "started",
      terminal: false
    }];
  }

  if (isWaitTool(call.data.name)) {
    const argumentsData = waitArgumentsSchema.safeParse(argumentsValue);
    const resultData = waitResultSchema.safeParse(resultValue);
    if (!argumentsData.success || !resultData.success) return [];
    const status = resultData.data.status ?? {};
    const pendingItems = resultData.data.pending.items
      .map((item) => waitItemSchema.safeParse(item))
      .flatMap((item) => item.success ? [item.data] : []);
    const targets = new Set(argumentsData.data.targets ?? [
      ...Object.keys(status),
      ...pendingItems.map((item) => item.target)
    ]);
    const mutations: SessionActivityAgentLifecycleMutation[] = [];
    for (const target of targets) {
      if (status[target] !== undefined) {
        const terminalStatus = terminalStatusSchema.safeParse(status[target]);
        if (terminalStatus.success) mutations.push({ agentId: target, state: terminalState(terminalStatus.data), terminal: true });
        continue;
      }
      const pending = pendingItems.find((item) => item.target === target);
      if (pending) mutations.push({ agentId: target, state: waitState(pending.phase), terminal: false });
    }
    return mutations;
  }

  if (isCloseTool(call.data.name)) {
    const argumentsData = closeArgumentsSchema.safeParse(argumentsValue);
    const resultData = closeResultSchema.safeParse(resultValue);
    if (!argumentsData.success || !resultData.success) return [];
    const state = typeof resultData.data.previous_status === "string"
      ? closeState(resultData.data.previous_status)
      : terminalState(resultData.data.previous_status);
    return [{ agentId: argumentsData.data.target, state, terminal: true }];
  }
  return [];
}

function isSpawnTool(name: string): boolean {
  return name === "multi_agent_v1__spawn_agent" || name === "collaboration__spawn_agent";
}

function isWaitTool(name: string): boolean {
  return name === "multi_agent_v1__wait_agent" || name === "collaboration__wait_agent";
}

function isCloseTool(name: string): boolean {
  return name === "multi_agent_v1__close_agent" || name === "collaboration__interrupt_agent" || name === "collaboration__close_agent";
}

function parseJson(value: string): unknown | null {
  if (Buffer.byteLength(value, "utf8") > MAX_PROTOCOL_JSON_BYTES) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function waitState(phase: z.infer<typeof waitItemSchema>["phase"]): SessionActivityAgentLifecycleMutation["state"] {
  if (phase === "local_capacity" || phase === "provider_queue") return "started";
  if (phase === "awaiting_model" || phase === "model_running" || phase === "tool_running") return "running";
  return "blocked";
}

function terminalState(status: z.infer<typeof terminalStatusSchema>): "completed" | "failed" | "interrupted" {
  if ("completed" in status) return "completed";
  if ("failed" in status) return "failed";
  return "interrupted";
}

function closeState(status: z.infer<typeof closePreviousStatusSchema>): "completed" | "failed" | "interrupted" {
  if (status === "completed" || status === "done") return "completed";
  if (status === "failed") return "failed";
  return "interrupted";
}
