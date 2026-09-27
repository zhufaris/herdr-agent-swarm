import { z } from "zod";
import type { AgentTranscriptMainStatus, AgentTranscriptObservation, AgentTranscriptPlanStep } from "../domain/ports/external.js";
import type { AnswerTimelineDelta, AnswerTimelineToolCategory } from "../domain/answer-timeline.js";
import { boundTranscriptMarkdown } from "./agent-transcript-codec.js";
import { normalizeToolOutput, projectToolCall, projectToolResult, projectToolResultState, type ToolActivityDescriptor } from "./tool-activity-projector.js";
import { redactSecrets } from "./redact-secrets.js";
import { parsePlanToolCall } from "./plan-snapshot.js";

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
const completedUserMessageEventSchema = z.object({
  type: z.literal("item_completed"), turn_id: z.string().min(1),
  item: z.object({ type: z.literal("UserMessage"), id: z.string().min(1), content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) }).passthrough()
}).passthrough();
const completedCommandExecutionEventSchema = z.object({
  type: z.literal("item_completed"), turn_id: z.string().min(1),
  item: z.object({
    type: z.literal("CommandExecution"), id: z.string().min(1),
    command: z.union([z.string(), z.array(z.string())]),
    status: z.string().optional(), exit_code: z.number().int().nullable().optional()
  }).passthrough()
}).passthrough();

export class TraexTranscriptProjector {
  private readonly emittedItemIds = new Set<string>();
  private readonly emittedUserMessageIds = new Set<string>();
  private readonly callsById = new Map<string, { descriptor: ToolActivityDescriptor; sequence: number }>();
  private nextTimelineSequence = 1;

  project(input: { lines: readonly string[]; initialLifecycle: AgentTranscriptObservation["turnLifecycle"]; tokenBaseline: number | null; maxRenderedDeltaChars: number }): { observation: AgentTranscriptObservation; lifecycle: AgentTranscriptObservation["turnLifecycle"] } {
    const blocks: string[] = []; const toolActivities: NonNullable<AgentTranscriptObservation["toolActivities"]> = []; const timelineDeltas: AnswerTimelineDelta[] = [];
    let statusTitle: string | undefined; let planSteps: AgentTranscriptPlanStep[] | undefined; let tokenCount: number | undefined;
    let lifecycle = input.initialLifecycle; let observationTurnId = lifecycle?.state === "active" ? lifecycle.turnId : undefined; let freshTurnStart = false; let requestText: string | undefined;
    for (const line of input.lines) {
      const envelope = parseEnvelope(line); if (!envelope) continue;
      if (envelope.type === "event_msg") {
        const started = taskStartedEventSchema.safeParse(envelope.payload);
        const completed = taskCompleteEventSchema.safeParse(envelope.payload);
        if (started.success) { observationTurnId = started.data.turn_id; freshTurnStart = true; this.callsById.clear(); this.emittedItemIds.clear(); this.emittedUserMessageIds.clear(); this.nextTimelineSequence = 1; }
        lifecycle = reduceTurnLifecycle(lifecycle, envelope, input.maxRenderedDeltaChars);
        const userMessage = userMessageEventSchema.safeParse(envelope.payload);
        if (userMessage.success && observationTurnId && lifecycle?.turnId === observationTurnId) requestText = boundTranscriptMarkdown(redactSecrets(userMessage.data.message), input.maxRenderedDeltaChars);
        const completedUserMessage = completedUserMessageEventSchema.safeParse(envelope.payload);
        if (completedUserMessage.success && observationTurnId && completedUserMessage.data.turn_id === observationTurnId && lifecycle?.turnId === observationTurnId) {
          const text = this.userMessageText(completedUserMessage.data.item, input.maxRenderedDeltaChars);
          if (text) requestText = text;
        }
        const completedCommand = completedCommandExecutionEventSchema.safeParse(envelope.payload);
        if (completedCommand.success && observationTurnId && completedCommand.data.turn_id === observationTurnId && lifecycle?.turnId === observationTurnId) {
          const rendered = this.renderCompletedCommandExecution(completedCommand.data.item, toolActivities, timelineDeltas, input.maxRenderedDeltaChars);
          if (rendered) blocks.push(rendered);
        }
        const reasoning = reasoningEventSchema.safeParse(envelope.payload); if (reasoning.success) statusTitle = extractStatusTitle(reasoning.data.text) ?? statusTitle;
        const tokens = tokenCountEventSchema.safeParse(envelope.payload); if (tokens.success && input.tokenBaseline !== null && tokens.data.info.total_token_usage.total_tokens >= input.tokenBaseline) tokenCount = tokens.data.info.total_token_usage.total_tokens - input.tokenBaseline;
        if (completed.success && observationTurnId === completed.data.turn_id && lifecycle?.state === "completed" && lifecycle.finalAnswer && !this.emittedItemIds.has(`final:${lifecycle.turnId}`)) {
          this.emittedItemIds.add(`final:${lifecycle.turnId}`);
          timelineDeltas.push({ kind: "final_answer", id: `final:${lifecycle.turnId}`, sequence: this.nextTimelineSequence++, markdown: safeTimelineText(lifecycle.finalAnswer, input.maxRenderedDeltaChars) });
        }
        continue;
      }
      if (envelope.type !== "history_mutation") continue;
      const mutation = historyMutationSchema.safeParse(envelope.payload); if (!mutation.success) continue;
      for (const item of mutation.data.items) {
        const userMessage = messageItemSchema.safeParse(item);
        if (userMessage.success && userMessage.data.role === "user" && observationTurnId && lifecycle?.turnId === observationTurnId) {
          const text = this.userMessageText(userMessage.data, input.maxRenderedDeltaChars);
          if (text) requestText = text;
          continue;
        }
        const planCall = functionCallSchema.safeParse(item);
        const plan = planCall.success ? parsePlanToolCall(planCall.data.name, planCall.data.arguments) : null;
        if (plan) { planSteps = plan; const call = functionCallSchema.safeParse(item); if (call.success) this.emittedItemIds.add(call.data.id); continue; }
        const timelineEnabled = observationTurnId !== undefined && lifecycle?.turnId === observationTurnId;
        const rendered = this.renderItem(item, toolActivities, timelineDeltas, timelineEnabled, input.maxRenderedDeltaChars); if (rendered) blocks.push(rendered);
      }
    }
    const mainStatus: AgentTranscriptMainStatus = { ...(statusTitle ? { statusTitle } : {}), ...(planSteps ? { planSteps } : {}), ...(tokenCount !== undefined ? { tokenCount } : {}) };
    const observation: AgentTranscriptObservation = { ...(observationTurnId ? { turnId: observationTurnId } : {}), ...(freshTurnStart ? { freshTurnStart: true } : {}), ...(requestText !== undefined ? { requestText } : {}), answerDelta: boundTranscriptMarkdown(redactSecrets(blocks.join("\n\n")), input.maxRenderedDeltaChars), ...(timelineDeltas.length ? { timelineDeltas } : {}), ...(toolActivities.length ? { toolActivities } : {}), ...(Object.keys(mainStatus).length ? { mainStatus } : {}), ...(observationTurnId && lifecycle?.turnId === observationTurnId ? { turnLifecycle: lifecycle } : {}) };
    if (lifecycle?.state === "completed" || lifecycle?.state === "aborted") this.callsById.clear();
    return { observation, lifecycle };
  }

  private userMessageText(message: { id: string; content: Array<{ type: string; text?: string | undefined }> }, max: number): string | null {
    if (this.emittedUserMessageIds.has(message.id)) return null;
    const text = message.content.filter((part) => part.type === "input_text" || part.type === "text").map((part) => part.text?.trim() ?? "").filter(Boolean).join("\n\n");
    if (!text) return null;
    this.emittedUserMessageIds.add(message.id);
    return boundTranscriptMarkdown(redactSecrets(text), max);
  }

  private renderItem(item: unknown, toolActivities: NonNullable<AgentTranscriptObservation["toolActivities"]>, timelineDeltas: AnswerTimelineDelta[], timelineEnabled: boolean, max: number): string {
    const message = messageItemSchema.safeParse(item);
    if (message.success) {
      if (message.data.role !== "assistant" || this.emittedItemIds.has(message.data.id)) return "";
      const output = message.data.content.filter((part) => part.type === "output_text" && part.text !== undefined).map((part) => part.text!.trim()).filter(Boolean).join("\n\n");
      if (!output) return "";
      this.emittedItemIds.add(message.data.id);
      if (timelineEnabled) timelineDeltas.push({ kind: "agent_message", id: `message:${message.data.id}`, sequence: this.nextTimelineSequence++, markdown: safeTimelineText(output, max) });
      return output;
    }
    const call = functionCallSchema.safeParse(item);
    if (call.success) {
      if (this.emittedItemIds.has(call.data.id) || this.callsById.has(call.data.call_id)) return "";
      const projected = projectToolCall(call.data.name, call.data.arguments); this.emittedItemIds.add(call.data.id); if (call.data.name === "update_plan") return "";
      const sequence = this.nextTimelineSequence++;
      this.callsById.set(call.data.call_id, { descriptor: projected.descriptor, sequence });
      const activity = projectActivity(call.data.call_id, projected.descriptor, "active");
      if (activity) toolActivities.push(activity);
      if (activity && timelineEnabled) timelineDeltas.push(toolTimelineItem(call.data.call_id, sequence, projected.descriptor, "running", undefined, max));
      return projected.entry;
    }
    const result = functionOutputSchema.safeParse(item);
    if (!result.success || this.emittedItemIds.has(result.data.id) || !this.callsById.has(result.data.call_id)) return "";
    this.emittedItemIds.add(result.data.id); const { descriptor, sequence } = this.callsById.get(result.data.call_id)!;
    const activity = projectActivity(result.data.call_id, descriptor, projectToolResultState(result.data.output));
    if (activity) toolActivities.push(activity);
    if (activity && timelineEnabled) timelineDeltas.push(toolTimelineItem(result.data.call_id, sequence, descriptor, activity.state === "active" ? "running" : activity.state === "done" ? "succeeded" : "failed", result.data.output, max));
    return projectToolResult(descriptor, result.data.output);
  }

  private renderCompletedCommandExecution(
    item: z.infer<typeof completedCommandExecutionEventSchema>["item"],
    toolActivities: NonNullable<AgentTranscriptObservation["toolActivities"]>,
    timelineDeltas: AnswerTimelineDelta[],
    max: number,
  ): string {
    if (this.emittedItemIds.has(item.id)) return "";
    this.emittedItemIds.add(item.id);
    const command = commandExecutionText(item.command);
    const projected = projectToolCall("exec_command", JSON.stringify({ cmd: command }));
    const result = { status: item.status, exit_code: item.exit_code };
    const state = projectToolResultState(result);
    const sequence = this.nextTimelineSequence++;
    const activity = projectActivity(item.id, projected.descriptor, state);
    if (activity) {
      toolActivities.push(activity);
      timelineDeltas.push(toolTimelineItem(item.id, sequence, projected.descriptor, state === "active" ? "running" : state === "done" ? "succeeded" : "failed", undefined, max));
    }
    return projectToolResult(projected.descriptor, result);
  }
}

function commandExecutionText(command: string | string[]): string {
  if (typeof command === "string") return command;
  if (command.length >= 3 && /(?:^|\/)(?:ba|z|da)?sh$/.test(command[0] ?? "") && command[1] === "-lc") return command[2] ?? "";
  return command.join(" ");
}

function toolTimelineItem(id: string, sequence: number, descriptor: ToolActivityDescriptor, state: "running" | "succeeded" | "failed", output: unknown, max: number): AnswerTimelineDelta {
  const category = toolCategory(descriptor);
  const result = output === undefined ? "" : safeTimelineText(normalizeToolOutput(output), max);
  return { kind: "tool", id: `tool:${id}`, sequence, category, label: safeTimelineText(descriptor.target || descriptor.category, 160), ...(category === "command" || category === "test" ? { command: safeTimelineText(descriptor.target, 1_000) } : {}), ...(result ? { resultPreview: result } : {}), state };
}

function toolCategory(descriptor: ToolActivityDescriptor): AnswerTimelineToolCategory {
  if (descriptor.category === "Read") return "read";
  if (descriptor.category === "Search") return "search";
  if (descriptor.category === "Edit") return "edit";
  if (descriptor.category === "Command") return /(?:^|\s)(?:npm|npx|pnpm|yarn|bun|uv|pytest|cargo|go)\b.*\btest(?:s|ing)?\b|\b(?:vitest|jest|pytest)\b/i.test(descriptor.target) ? "test" : "command";
  return "step";
}

function safeTimelineText(value: string, max: number): string {
  return boundTranscriptMarkdown(redactSecrets(value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")), max);
}

function parseEnvelope(line: string): z.infer<typeof envelopeSchema> | null { try { const parsed = envelopeSchema.safeParse(JSON.parse(line)); return parsed.success ? parsed.data : null; } catch { return null; } }
function projectActivity(callId: string, descriptor: ToolActivityDescriptor, state: "active" | "done" | "failed"): NonNullable<AgentTranscriptObservation["toolActivities"]>[number] | null { if (descriptor.category === "Command" && !descriptor.target) return null; const kind = descriptor.category === "Read" ? "read" : descriptor.category === "Search" ? "search" : descriptor.category === "Edit" ? "edit" : descriptor.category === "Command" && /(?:^|\s)(?:npm|npx|pnpm|yarn|bun|uv|pytest|cargo|go)\b.*\btest(?:s|ing)?\b|\b(?:vitest|jest|pytest)\b/i.test(descriptor.target) ? "test" : "step"; return { key: `tool:${callId}`, kind, label: `${descriptor.category} · ${descriptor.target}`, state }; }
function reduceTurnLifecycle(current: AgentTranscriptObservation["turnLifecycle"], envelope: z.infer<typeof envelopeSchema>, max: number): AgentTranscriptObservation["turnLifecycle"] { if (envelope.type !== "event_msg") return current; const started = taskStartedEventSchema.safeParse(envelope.payload); if (started.success) return { turnId: started.data.turn_id, state: "active", startedAt: eventTime(started.data.started_at) }; const completed = taskCompleteEventSchema.safeParse(envelope.payload); if (completed.success) { if (current?.state !== "active" || current.turnId !== completed.data.turn_id) return current; const finalAnswer = completed.data.last_agent_message ? boundTranscriptMarkdown(redactSecrets(completed.data.last_agent_message.trim()), max) : ""; return { turnId: completed.data.turn_id, state: "completed", startedAt: current.startedAt, ...(finalAnswer ? { finalAnswer } : {}) }; } const aborted = turnAbortedEventSchema.safeParse(envelope.payload); if (!aborted.success || current?.state !== "active" || current.turnId !== aborted.data.turn_id) return current; return { turnId: aborted.data.turn_id, state: "aborted", startedAt: current.startedAt, ...(aborted.data.reason ? { reason: boundTranscriptMarkdown(redactSecrets(aborted.data.reason), max) } : {}) }; }
function eventTime(seconds: number): string { return new Date(seconds * 1_000).toISOString(); }
function extractStatusTitle(text: string): string | null { const match = /^\s*\*\*([^*\n]+)\*\*/.exec(text); const title = match?.[1]?.replace(/\s+/g, " " ).trim(); return title ? title.slice(0, 160) : null; }
