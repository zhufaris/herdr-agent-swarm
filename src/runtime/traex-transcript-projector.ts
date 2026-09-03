import { z } from "zod";
import type { TraexTranscriptMainStatus, TraexTranscriptObservation, TraexTranscriptPlanStep } from "../domain/ports/external.js";
import { projectToolCall, projectToolResult, projectToolResultState, type ToolActivityDescriptor } from "./tool-activity-projector.js";
import { redactSecrets } from "./redact-secrets.js";

const MAX_EPOCH_SECONDS = 10_000_000_000;
const envelopeSchema = z.object({ type: z.string(), payload: z.unknown() }).passthrough();
const historyMutationSchema = z.object({ operation: z.literal("append"), items: z.array(z.unknown()) }).passthrough();
const messageItemSchema = z.object({ type: z.literal("message"), id: z.string().min(1), role: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) }).passthrough();
const functionCallSchema = z.object({ type: z.literal("function_call"), id: z.string().min(1), call_id: z.string().min(1), name: z.string(), arguments: z.string() }).passthrough();
const functionOutputSchema = z.object({ type: z.literal("function_call_output"), id: z.string().min(1), call_id: z.string().min(1), output: z.unknown() }).passthrough();
const reasoningEventSchema = z.object({ type: z.literal("agent_reasoning_raw_content"), text: z.string() }).passthrough();
const tokenCountEventSchema = z.object({ type: z.literal("token_count"), info: z.object({ total_token_usage: z.object({ total_tokens: z.number().int().nonnegative() }).passthrough() }).passthrough() }).passthrough();
const taskStartedEventSchema = z.object({ type: z.literal("task_started"), turn_id: z.string().min(1), started_at: z.number().int().nonnegative().max(MAX_EPOCH_SECONDS) }).passthrough();
const taskCompleteEventSchema = z.object({ type: z.literal("task_complete"), turn_id: z.string().min(1), started_at: z.number().int().nonnegative().max(MAX_EPOCH_SECONDS), last_agent_message: z.string().nullable().optional() }).passthrough();
const turnAbortedEventSchema = z.object({ type: z.literal("turn_aborted"), turn_id: z.string().min(1), reason: z.string().min(1).optional() }).passthrough();
const userMessageEventSchema = z.object({ type: z.literal("user_message"), message: z.string() }).passthrough();
const planArgumentsSchema = z.object({ plan: z.array(z.object({ step: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })).max(100) }).passthrough();

export class TraexTranscriptProjector {
  private readonly emittedItemIds = new Set<string>();
  private readonly callsById = new Map<string, ToolActivityDescriptor>();

  project(input: { lines: readonly string[]; initialLifecycle: TraexTranscriptObservation["turnLifecycle"]; tokenBaseline: number | null; maxRenderedDeltaChars: number }): { observation: TraexTranscriptObservation; lifecycle: TraexTranscriptObservation["turnLifecycle"] } {
    const blocks: string[] = []; const toolActivities: NonNullable<TraexTranscriptObservation["toolActivities"]> = [];
    let statusTitle: string | undefined; let planSteps: TraexTranscriptPlanStep[] | undefined; let tokenCount: number | undefined;
    let lifecycle = input.initialLifecycle; let observationTurnId = lifecycle?.state === "active" ? lifecycle.turnId : undefined; let freshTurnStart = false; let requestText: string | undefined;
    for (const line of input.lines) {
      const envelope = parseEnvelope(line); if (!envelope) continue;
      if (envelope.type === "event_msg") {
        const started = taskStartedEventSchema.safeParse(envelope.payload);
        if (started.success) { observationTurnId = started.data.turn_id; freshTurnStart = true; this.callsById.clear(); }
        lifecycle = reduceTurnLifecycle(lifecycle, envelope, input.maxRenderedDeltaChars);
        const userMessage = userMessageEventSchema.safeParse(envelope.payload);
        if (userMessage.success && observationTurnId && lifecycle?.turnId === observationTurnId) requestText = boundMarkdown(redactSecrets(userMessage.data.message), input.maxRenderedDeltaChars);
        const reasoning = reasoningEventSchema.safeParse(envelope.payload); if (reasoning.success) statusTitle = extractStatusTitle(reasoning.data.text) ?? statusTitle;
        const tokens = tokenCountEventSchema.safeParse(envelope.payload); if (tokens.success && input.tokenBaseline !== null && tokens.data.info.total_token_usage.total_tokens >= input.tokenBaseline) tokenCount = tokens.data.info.total_token_usage.total_tokens - input.tokenBaseline;
        continue;
      }
      if (envelope.type !== "history_mutation") continue;
      const mutation = historyMutationSchema.safeParse(envelope.payload); if (!mutation.success) continue;
      for (const item of mutation.data.items) {
        const plan = parsePlanSnapshot(item);
        if (plan) { planSteps = plan; const call = functionCallSchema.safeParse(item); if (call.success) this.emittedItemIds.add(call.data.id); continue; }
        const rendered = this.renderItem(item, toolActivities); if (rendered) blocks.push(rendered);
      }
    }
    const mainStatus: TraexTranscriptMainStatus = { ...(statusTitle ? { statusTitle } : {}), ...(planSteps ? { planSteps } : {}), ...(tokenCount !== undefined ? { tokenCount } : {}) };
    const observation: TraexTranscriptObservation = { ...(observationTurnId ? { turnId: observationTurnId } : {}), ...(freshTurnStart ? { freshTurnStart: true } : {}), ...(requestText !== undefined ? { requestText } : {}), answerDelta: boundMarkdown(redactSecrets(blocks.join("\n\n")), input.maxRenderedDeltaChars), ...(toolActivities.length ? { toolActivities } : {}), ...(Object.keys(mainStatus).length ? { mainStatus } : {}), ...(observationTurnId && lifecycle?.turnId === observationTurnId ? { turnLifecycle: lifecycle } : {}) };
    if (lifecycle?.state === "completed" || lifecycle?.state === "aborted") this.callsById.clear();
    return { observation, lifecycle };
  }

  private renderItem(item: unknown, toolActivities: NonNullable<TraexTranscriptObservation["toolActivities"]>): string {
    const message = messageItemSchema.safeParse(item);
    if (message.success) {
      if (message.data.role !== "assistant" || this.emittedItemIds.has(message.data.id)) return "";
      const output = message.data.content.filter((part) => part.type === "output_text" && part.text !== undefined).map((part) => part.text!.trim()).filter(Boolean).join("\n\n");
      if (!output) return ""; this.emittedItemIds.add(message.data.id); return output;
    }
    const call = functionCallSchema.safeParse(item);
    if (call.success) {
      if (this.emittedItemIds.has(call.data.id) || this.callsById.has(call.data.call_id)) return "";
      const projected = projectToolCall(call.data.name, call.data.arguments); this.emittedItemIds.add(call.data.id); if (call.data.name === "update_plan") return "";
      this.callsById.set(call.data.call_id, projected.descriptor); toolActivities.push(projectActivity(call.data.call_id, projected.descriptor, "active")); return projected.entry;
    }
    const result = functionOutputSchema.safeParse(item);
    if (!result.success || this.emittedItemIds.has(result.data.id) || !this.callsById.has(result.data.call_id)) return "";
    this.emittedItemIds.add(result.data.id); const descriptor = this.callsById.get(result.data.call_id)!; toolActivities.push(projectActivity(result.data.call_id, descriptor, projectToolResultState(result.data.output))); return projectToolResult(descriptor, result.data.output);
  }
}

function parseEnvelope(line: string): z.infer<typeof envelopeSchema> | null { try { const parsed = envelopeSchema.safeParse(JSON.parse(line)); return parsed.success ? parsed.data : null; } catch { return null; } }
function projectActivity(callId: string, descriptor: ToolActivityDescriptor, state: "active" | "done" | "failed"): NonNullable<TraexTranscriptObservation["toolActivities"]>[number] { const kind = descriptor.category === "Read" ? "read" : descriptor.category === "Search" ? "search" : descriptor.category === "Edit" ? "edit" : descriptor.category === "Command" && /(?:^|\s)(?:npm|npx|pnpm|yarn|bun|uv|pytest|cargo|go)\b.*\btest(?:s|ing)?\b|\b(?:vitest|jest|pytest)\b/i.test(descriptor.target) ? "test" : "step"; return { key: `tool:${callId}`, kind, label: `${descriptor.category} · ${descriptor.target || "未提供目标"}`, state }; }
function reduceTurnLifecycle(current: TraexTranscriptObservation["turnLifecycle"], envelope: z.infer<typeof envelopeSchema>, max: number): TraexTranscriptObservation["turnLifecycle"] { if (envelope.type !== "event_msg") return current; const started = taskStartedEventSchema.safeParse(envelope.payload); if (started.success) return { turnId: started.data.turn_id, state: "active", startedAt: eventTime(started.data.started_at) }; const completed = taskCompleteEventSchema.safeParse(envelope.payload); if (completed.success) { if (current?.state !== "active" || current.turnId !== completed.data.turn_id) return current; const finalAnswer = completed.data.last_agent_message ? boundMarkdown(redactSecrets(completed.data.last_agent_message.trim()), max) : ""; return { turnId: completed.data.turn_id, state: "completed", startedAt: current.startedAt, ...(finalAnswer ? { finalAnswer } : {}) }; } const aborted = turnAbortedEventSchema.safeParse(envelope.payload); if (!aborted.success || current?.state !== "active" || current.turnId !== aborted.data.turn_id) return current; return { turnId: aborted.data.turn_id, state: "aborted", startedAt: current.startedAt, ...(aborted.data.reason ? { reason: boundMarkdown(redactSecrets(aborted.data.reason), max) } : {}) }; }
function eventTime(seconds: number): string { return new Date(seconds * 1_000).toISOString(); }
function extractStatusTitle(text: string): string | null { const match = /^\s*\*\*([^*\n]+)\*\*/.exec(text); const title = match?.[1]?.replace(/\s+/g, " " ).trim(); return title ? title.slice(0, 160) : null; }
function parsePlanSnapshot(item: unknown): TraexTranscriptPlanStep[] | null { const call = functionCallSchema.safeParse(item); if (!call.success) return null; try { const outer = JSON.parse(call.data.arguments) as unknown; const parsed = call.data.name === "update_plan" ? planArgumentsSchema.safeParse(outer) : call.data.name === "exec" ? parseWrappedPlan(outer) : null; if (!parsed?.success) return null; const states = { pending: "pending", in_progress: "active", completed: "done" } as const; return parsed.data.plan.map((step, index) => ({ key: `plan:${index}`, label: step.step.replace(/\s+/g, " " ).trim().slice(0, 300) || "未命名步骤", state: states[step.status] })); } catch { return null; } }
function parseWrappedPlan(value: unknown): ReturnType<typeof planArgumentsSchema.safeParse> | null { if (!value || typeof value !== "object" || Array.isArray(value)) return null; const input = (value as Record<string, unknown>).input; if (typeof input !== "string" || !/tools\.update_plan\s*\(/.test(input)) return null; const steps: Array<{ step: string; status: "pending" | "in_progress" | "completed" }> = []; const pattern = /step\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*status\s*:\s*"(pending|in_progress|completed)"/g; for (const match of input.matchAll(pattern)) { try { steps.push({ step: JSON.parse(match[1]!) as string, status: match[2]! as "pending" | "in_progress" | "completed" }); } catch { return null; } } return steps.length ? planArgumentsSchema.safeParse({ plan: steps }) : null; }
function boundMarkdown(value: string, maxLength: number): string { if (value.length <= maxLength) return value; const suffix = "\n\n… output truncated"; const room = Math.max(0, maxLength - suffix.length - 4); let prefix = value.slice(0, room).trimEnd(); if ((prefix.match(/```/g)?.length ?? 0) % 2 === 1) prefix += "\n```"; return `${prefix}${suffix}`.slice(0, maxLength); }
