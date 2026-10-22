import { z } from "zod";
import type { AgentTranscriptObservation, AgentTranscriptPlanStep } from "../../domain/ports/external.js";
import type { AnswerTimelineDelta, AnswerTimelineToolCategory } from "../../domain/answer-timeline.js";
import type { AgentEvent } from "../../domain/herdr-events.js";
import {
  choicePromptFromLegacyCompletionChoice,
  continueChoicePrompt,
  recoveredCompletionChoiceFromTraceEndReviewDecision,
  type ChoicePrompt
} from "../../domain/completion-choice.js";
import { boundTranscriptMarkdown } from "../agent-transcript-codec.js";
import { createBoundedTurnOutput } from "../bounded-turn-output.js";
import {
  isAnswerVisibleToolActivity,
  isStatusVisibleToolActivity,
  normalizeToolResultForDisplay,
  projectToolCalls,
  projectToolResultState,
  summarizeToolActivity,
  toolActivityKey,
  type ToolActivityDescriptor
} from "../tool-activity-projector.js";
import { redactSecrets } from "../redact-secrets.js";
import { normalizeFinalTraceEnvelope } from "../../domain/final-trace-envelope.js";

const MAX_RENDERED_CHARS = 64_000;
const planArgumentsSchema = z.object({
  plan: z.array(z.object({
    step: z.string(),
    status: z.enum(["pending", "in_progress", "completed"])
  })).max(100)
}).passthrough();

export interface EventProjectorSnapshot {
  calls: Map<string, Array<{ id: string; descriptor: ToolActivityDescriptor; parentToolId?: string }>>;
  emittedMessages: Set<string>;
  sequence: number;
  turnId: string | undefined;
  startedAt: string | undefined;
  finalAnswer: string | undefined;
  completionChoice: ChoicePrompt | undefined;
  completionChoiceSource: "native" | "protocol" | undefined;
  reasoningSequences: Map<string, number>;
  spawnedAgentAliases: Set<string>;
  requestedAgentModels: Map<string, string>;
  agentStableKeys: Map<string, string>;
  recordSkippedSequence: number | undefined;
}

export interface HerdrEventProjectorOptions { reasoningDisplay?: "hidden" | "summary" | "visible" }

export class HerdrEventProjector {
  private readonly calls = new Map<string, Array<{ id: string; descriptor: ToolActivityDescriptor; parentToolId?: string }>>();
  private readonly emittedMessages = new Set<string>();
  private sequence = 1;
  private turnId: string | undefined;
  private startedAt: string | undefined;
  private finalAnswer: string | undefined;
  private completionChoice: ChoicePrompt | undefined;
  private completionChoiceSource: "native" | "protocol" | undefined;
  private readonly reasoningSequences = new Map<string, number>();
  private readonly spawnedAgentAliases = new Set<string>();
  private readonly requestedAgentModels = new Map<string, string>();
  private readonly agentStableKeys = new Map<string, string>();
  private recordSkippedSequence: number | undefined;

  constructor(private readonly options: HerdrEventProjectorOptions = {}) {}

  project(events: AgentEvent[]): AgentTranscriptObservation {
    if (events.length === 0) return { answerDelta: "" };
    let freshTurnStart = false;
    let terminal: "completed" | "aborted" | undefined;
    let reason: string | undefined;
    let requestText: string | undefined;
    let requestMessageId: string | undefined;
    let requestSubmissionId: string | undefined;
    const answers: string[] = [];
    const toolActivities: NonNullable<AgentTranscriptObservation["toolActivities"]> = [];
    const timelineDeltas: AnswerTimelineDelta[] = [];
    const goalChanges: NonNullable<AgentTranscriptObservation["goalChanges"]> = [];
    let planSteps: NonNullable<AgentTranscriptObservation["mainStatus"]>["planSteps"] | undefined;
    let model: string | undefined;

    for (const event of events) {
      if (event.turnId) this.turnId = event.turnId;
      const payload = event.payload;
      if (payload.type === "turn_started") {
        this.turnId = event.turnId ?? undefined;
        freshTurnStart = true;
        this.startedAt = normalizeStartedAt(event.occurredAt);
        this.finalAnswer = undefined;
        this.completionChoice = undefined;
        this.completionChoiceSource = undefined;
        this.calls.clear();
        this.emittedMessages.clear();
        this.reasoningSequences.clear();
        this.spawnedAgentAliases.clear();
        this.requestedAgentModels.clear();
        this.agentStableKeys.clear();
        this.recordSkippedSequence = undefined;
        continue;
      }
      if (payload.type === "human_message") {
        if (this.emittedMessages.has(`human:${payload.messageId}`)) continue;
        this.emittedMessages.add(`human:${payload.messageId}`);
        requestText = safe(payload.text);
        requestMessageId = payload.messageId;
        requestSubmissionId = payload.submissionId;
        if (requestText) timelineDeltas.push({ kind: "human_message", id: `human:${payload.messageId}`, sequence: this.nextSequence(), markdown: requestText });
        continue;
      }
      if (payload.type === "message") {
        if (payload.channel === "analysis" || payload.channel === "reasoning") continue;
        const visibleAssistantRole = payload.role === undefined || payload.role === "assistant";
        if (!visibleAssistantRole) {
          this.emittedMessages.add(payload.messageId);
          continue;
        }
        const visibleReasoning = payload.channel === "reasoning_visible";
        if (this.emittedMessages.has(payload.messageId) && !visibleReasoning) {
          if (isChoiceRecoveryChannel(payload.channel)) this.captureCompletionChoice(payload);
          if (payload.channel === "final") this.finalAnswer = projectVisibleAssistantMarkdown(payload.text);
          continue;
        }
        if (!visibleReasoning) this.emittedMessages.add(payload.messageId);
        const rawText = safe(payload.text);
        const text = projectVisibleAssistantMarkdown(rawText);
        if (isChoiceRecoveryChannel(payload.channel)) this.captureCompletionChoice(payload);
        const status = visibleStatusMessage(payload.channel, text);
        if (status) {
          timelineDeltas.push({ kind: "status", id: `status:${payload.messageId}`, sequence: this.nextSequence(), label: text, state: status });
          continue;
        }
        if (visibleReasoning) {
          if (text && this.options.reasoningDisplay !== "hidden") {
            const label = reasoningSummary(text) ?? "思考";
            const sequence = this.reasoningSequences.get(payload.messageId) ?? this.nextSequence();
            this.reasoningSequences.set(payload.messageId, sequence);
            this.emittedMessages.add(payload.messageId);
            timelineDeltas.push({ kind: "thinking", id: `thinking:${payload.messageId}`, sequence, label, markdown: text });
          }
          continue;
        }
        if (text) {
          answers.push(text);
          timelineDeltas.push({
            kind: payload.channel === "final" ? "final_answer" : "agent_message",
            id: `message:${payload.messageId}`,
            sequence: this.nextSequence(),
            markdown: text
          });
        }
        if (payload.channel === "final") this.finalAnswer = text;
        continue;
      }
      if (payload.type === "model_changed") {
        model = safe(payload.model).replace(/\s+/g, " ").trim().slice(0, 256);
        timelineDeltas.push({
          kind: "status",
          id: `model:${event.eventId}`,
          sequence: this.nextSequence(),
          label: `🧠 Model · ${model}`,
          state: "completed"
        });
        continue;
      }
      if (payload.type === "context_compacted") {
        timelineDeltas.push({
          kind: "status",
          id: `context-compacted:${event.eventId}`,
          sequence: this.nextSequence(),
          label: "🗜️ Context compacted",
          state: "completed"
        });
        continue;
      }
      if (payload.type === "token_usage" || payload.type === "context_snapshot") continue;
      if (payload.type === "tool_call") {
        const agentRequest = spawnedAgentRequest(payload.name, payload.arguments);
        if (agentRequest) {
          this.spawnedAgentAliases.add(agentRequest.taskName);
          if (agentRequest.model) this.requestedAgentModels.set(agentRequest.taskName, agentRequest.model);
        }
        const plan = corePlanUpdate(payload.name, payload.arguments);
        if (plan) planSteps = plan.steps;
        const entries = projectToolCalls(payload.name, payload.arguments).map((call) => ({
          id: call.nestedIndex === undefined ? payload.callId : `${payload.callId}:nested:${call.nestedIndex}`,
          descriptor: call.descriptor,
          ...(call.nestedIndex === undefined ? {} : { parentToolId: `tool:${payload.callId}` })
        }));
        if (entries.length === 0) continue;
        this.calls.set(payload.callId, entries);
        for (const entry of entries) {
          if (isStatusVisibleToolActivity(entry.descriptor)) {
            const activity = toolActivity(entry.id, entry.descriptor.category, entry.descriptor.target, "active");
            if (activity) toolActivities.push(activity);
          }
          if (isAnswerVisibleToolActivity(entry.descriptor)) {
            timelineDeltas.push(toolTimeline(entry.id, this.nextSequence(), entry.descriptor.category, entry.descriptor.target, "running", undefined, entry.parentToolId, entry.descriptor.diff));
          }
        }
        continue;
      }
      if (payload.type === "tool_result") {
        const entries = this.calls.get(payload.callId);
        if (!entries) continue;
        const state = payload.isError ? "failed" : projectToolResultState(payload.text);
        const aggregateResult = normalizeToolResultForDisplay(payload.text, payload.truncated);
        const containsSkill = entries.some((entry) => entry.parentToolId && entry.descriptor.category === "Skill");
        for (const entry of entries) {
          if (isStatusVisibleToolActivity(entry.descriptor)) {
            const activity = toolActivity(entry.id, entry.descriptor.category, entry.descriptor.target, state);
            if (activity) toolActivities.push(activity);
          }
          if (isAnswerVisibleToolActivity(entry.descriptor)) {
            const result = entry.parentToolId || containsSkill ? undefined : aggregateResult;
            timelineDeltas.push(toolTimeline(
              entry.id,
              this.nextSequence(),
              entry.descriptor.category,
              entry.descriptor.target,
              state === "active" ? "running" : state === "done" ? "succeeded" : "failed",
              result,
              entry.parentToolId,
              entry.descriptor.diff
            ));
          }
        }
        continue;
      }
      if (payload.type === "agent_activity") {
        const agentKey = stableAgentIdentity(this.spawnedAgentAliases, this.agentStableKeys, payload.agentId);
        const requestedModel = rootSpawnAlias(normalizedAgentIdentity(payload.agentId)) === agentKey
          ? this.requestedAgentModels.get(agentKey)
          : undefined;
        const label = payload.model
          ? safe(`🤖 Agent · ${payload.displayName ?? agentKey} · ${payload.model}`)
          : safe(`Agent · ${payload.displayName ?? payload.agentId}${requestedModel ? ` · requested model: ${requestedModel}` : ""}`);
        const statusState = agentProgressState(payload.state);
        toolActivities.push({ key: `agent:${agentKey}`, kind: "step", label, state: statusState });
        continue;
      }
      if (payload.type === "goal_changed") {
        goalChanges.push({
          goalId: payload.goalId,
          objective: safe(payload.objective),
          status: payload.status,
          sourceUpdatedAt: payload.sourceUpdatedAt,
          occurredAt: event.occurredAt,
          sourceId: event.sourceId,
          sourceSequence: sourceSequence(event.cursor),
          sourceEventId: event.eventId,
          nativeSessionId: event.sessionId
        });
        continue;
      }
      if (payload.type === "turn_completed") {
        terminal = "completed";
        continue;
      }
      if (payload.type === "turn_aborted") {
        terminal = "aborted";
        reason = safe(payload.reason);
        timelineDeltas.push({
          kind: "status",
          id: `turn-aborted:${event.eventId}`,
          sequence: this.nextSequence(),
          label: boundedInline(`Turn cancelled${reason ? ` · ${reason}` : ""}`, 240),
          state: "cancelled"
        });
        continue;
      }
      if (payload.type === "source_error") throw new Error(`agent event source failed: ${payload.code}`);
      if (payload.type === "record_skipped") {
        continue;
      }
    }

    const answerDelta = safe(answers.join("\n\n"));
    return {
      ...(this.turnId ? { turnId: this.turnId } : {}),
      ...(freshTurnStart ? { freshTurnStart: true } : {}),
      ...(requestText !== undefined ? { requestText } : {}),
      ...(requestMessageId ? { requestMessageId } : {}),
      ...(requestSubmissionId ? { requestSubmissionId } : {}),
      answerDelta,
      ...(model ? { model } : {}),
      ...(toolActivities.length ? { toolActivities } : {}),
      ...(timelineDeltas.length ? { timelineDeltas } : {}),
      ...(goalChanges.length ? { goalChanges } : {}),
      ...(planSteps ? { mainStatus: { planSteps } } : {}),
      ...(this.turnId && this.startedAt ? {
        turnLifecycle: {
          turnId: this.turnId,
          state: terminal ?? "active",
          startedAt: this.startedAt,
          ...(terminal === "completed" && this.finalAnswer ? { finalAnswer: this.finalAnswer } : {}),
          ...(terminal === "completed" && this.completionChoice ? { completionChoice: this.completionChoice } : {}),
          ...(terminal === "aborted" && reason ? { reason } : {})
        }
      } : {})
    };
  }

  snapshot(): EventProjectorSnapshot {
    return {
      calls: new Map([...this.calls].map(([id, entries]) => [id, entries.map((entry) => ({ ...entry, descriptor: { ...entry.descriptor } }))])),
      emittedMessages: new Set(this.emittedMessages),
      sequence: this.sequence,
      turnId: this.turnId,
      startedAt: this.startedAt,
      finalAnswer: this.finalAnswer,
      completionChoice: this.completionChoice,
      completionChoiceSource: this.completionChoiceSource,
      reasoningSequences: new Map(this.reasoningSequences),
      spawnedAgentAliases: new Set(this.spawnedAgentAliases),
      requestedAgentModels: new Map(this.requestedAgentModels),
      agentStableKeys: new Map(this.agentStableKeys),
      recordSkippedSequence: this.recordSkippedSequence
    };
  }

  restore(state: EventProjectorSnapshot): void {
    this.calls.clear();
    for (const [id, entries] of state.calls) this.calls.set(id, entries);
    this.emittedMessages.clear();
    for (const id of state.emittedMessages) this.emittedMessages.add(id);
    this.sequence = state.sequence;
    this.turnId = state.turnId;
    this.startedAt = state.startedAt;
    this.finalAnswer = state.finalAnswer;
    this.completionChoice = state.completionChoice;
    this.completionChoiceSource = state.completionChoiceSource;
    this.reasoningSequences.clear();
    for (const [id, sequence] of state.reasoningSequences) this.reasoningSequences.set(id, sequence);
    this.spawnedAgentAliases.clear();
    for (const alias of state.spawnedAgentAliases) this.spawnedAgentAliases.add(alias);
    this.requestedAgentModels.clear();
    for (const [id, model] of state.requestedAgentModels) this.requestedAgentModels.set(id, model);
    this.agentStableKeys.clear();
    for (const [id, key] of state.agentStableKeys) this.agentStableKeys.set(id, key);
    this.recordSkippedSequence = state.recordSkippedSequence;
  }

  private nextSequence(): number { return this.sequence++; }

  private captureCompletionChoice(payload: Extract<AgentEvent["payload"], { type: "message" }>): void {
    if (payload.completionChoice) {
      this.completionChoice = choicePromptFromLegacyCompletionChoice(payload.completionChoice);
      this.completionChoiceSource = "native";
      return;
    }
    if (this.completionChoiceSource === "native") return;
    if (payload.truncated) return;
    const inspection = normalizeFinalTraceEnvelope({ finalMarkdown: safe(payload.text) }).compatibilityChoice;
    if (inspection.kind !== "valid") return;
    if (inspection.decision.intent === "none") {
      this.completionChoice = continueChoicePrompt();
      this.completionChoiceSource = "protocol";
      return;
    }
    const recovered = recoveredCompletionChoiceFromTraceEndReviewDecision(inspection.decision);
    if (recovered) {
      this.completionChoice = recovered;
      this.completionChoiceSource = "protocol";
    }
  }
}

function projectVisibleAssistantMarkdown(value: string): string {
  return normalizeFinalTraceEnvelope({ finalMarkdown: safe(value) }).projectionMarkdown;
}

function isChoiceRecoveryChannel(channel: string): boolean {
  return channel === "commentary" || channel === "final";
}

export function latestProjectedPlan(events: readonly AgentEvent[]): AgentTranscriptPlanStep[] | null {
  let latest: AgentTranscriptPlanStep[] | null = null;
  for (const event of events) {
    if (event.payload.type !== "tool_call") continue;
    const plan = corePlanUpdate(event.payload.name, event.payload.arguments);
    if (plan) latest = plan.steps;
  }
  return latest;
}

function sourceSequence(cursor: string): number {
  const separator = cursor.lastIndexOf(":");
  const value = Number(cursor.slice(separator + 1));
  if (separator < 0 || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid agent event cursor");
  return value;
}

function corePlanUpdate(name: string, argumentsValue: string): { steps: AgentTranscriptPlanStep[] } | null {
  const normalized = name.toLowerCase();
  let value: unknown;
  try { value = JSON.parse(argumentsValue) as unknown; } catch { value = null; }
  if (normalized === "update_plan") return planSteps(value);
  if (normalized !== "exec" && normalized !== "functions.exec") return null;
  const input = value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).input === "string"
    ? (value as Record<string, string>).input
    : value === null ? argumentsValue : null;
  if (!input || !/tools\.update_plan\s*\(/.test(input)) return null;
  const steps: Array<{ step: string; status: "pending" | "in_progress" | "completed" }> = [];
  const pattern = /["']?step["']?\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*["']?status["']?\s*:\s*["'](pending|in_progress|completed)["']/g;
  for (const match of input.matchAll(pattern)) {
    try {
      steps.push({ step: JSON.parse(match[1]!) as string, status: match[2]! as "pending" | "in_progress" | "completed" });
    } catch { return null; }
  }
  return planSteps({ plan: steps });
}

function planSteps(value: unknown): { steps: AgentTranscriptPlanStep[] } | null {
  const parsed = planArgumentsSchema.safeParse(value);
  if (!parsed.success) return null;
  const states = { pending: "pending", in_progress: "active", completed: "done" } as const;
  return {
    steps: parsed.data.plan.map((step, index) => ({
      key: `plan:${index}`,
      label: safe(step.step).replace(/\s+/g, " ").trim().slice(0, 300) || "未命名步骤",
      state: states[step.status]
    }))
  };
}

function reasoningSummary(text: string): string | null {
  const match = /^\s*\*\*([^*\n]+)\*\*/.exec(text);
  const heading = match?.[1]?.replace(/\s+/g, " ").trim();
  if (heading) return safe(heading).slice(0, 160);
  const plain = text.replace(/\s+/g, " ").trim();
  return plain && !text.includes("\n") && [...plain].length <= 160 ? safe(plain) : null;
}

function visibleStatusMessage(channel: string, text: string): "running" | "blocked" | null {
  if (!text) return null;
  const normalizedChannel = channel.trim().toLowerCase();
  const waiting = /\bwaiting\s+for\s+(?:a\s+)?(?:command|input|user|approval|confirmation)\b/i.test(text)
    || /\bawaiting\s+(?:command|input|user|approval|confirmation)\b/i.test(text);
  if (normalizedChannel !== "final" && (normalizedChannel === "status" || normalizedChannel === "system" || normalizedChannel === "progress" || waiting)) {
    return /\b(?:approval|confirmation|user)\b/i.test(text) ? "blocked" : "running";
  }
  return null;
}

function agentProgressState(state: "started" | "running" | "completed" | "failed" | "interrupted" | "blocked"): "active" | "done" | "failed" {
  if (state === "started" || state === "running" || state === "blocked") return "active";
  return state === "completed" ? "done" : "failed";
}

function spawnedAgentRequest(name: string, argumentsValue: string): { taskName: string; model?: string } | null {
  const normalized = name.toLowerCase();
  if (normalized !== "collaboration__spawn_agent" && normalized !== "spawn_agent") return null;
  let value: unknown;
  try { value = JSON.parse(argumentsValue) as unknown; } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.task_name !== "string") return null;
  const taskName = normalizedAgentIdentity(record.task_name);
  if (!taskName) return null;
  const model = typeof record.model === "string" ? record.model.replace(/\s+/g, " ").trim() : "";
  return { taskName, ...(model ? { model: safe(model).slice(0, 96) } : {}) };
}

function stableAgentIdentity(
  spawnedAliases: ReadonlySet<string>,
  stableKeys: Map<string, string>,
  agentId: string
): string {
  const canonicalId = normalizedAgentIdentity(agentId);
  const existing = stableKeys.get(canonicalId);
  if (existing) return existing;
  const rootAlias = rootSpawnAlias(canonicalId);
  const stableKey = rootAlias && spawnedAliases.has(rootAlias) ? rootAlias : canonicalId;
  stableKeys.set(canonicalId, stableKey);
  return stableKey;
}

function normalizedAgentIdentity(value: string): string { return value.replace(/\s+/g, " ").trim().toLowerCase(); }
function rootSpawnAlias(canonicalId: string): string | null { return /^\/root\/([^/]+)$/.exec(canonicalId)?.[1] ?? null; }

function boundedInline(value: string, limit: number): string {
  const normalized = safe(value).replace(/\s+/g, " ").trim();
  const characters = [...normalized];
  return characters.length <= limit ? normalized : `${characters.slice(0, Math.max(0, limit - 1)).join("").trimEnd()}…`;
}

function toolActivity(callId: string, category: ToolActivityDescriptor["category"], target: string, state: "active" | "done" | "failed") {
  if (category === "Command" && !target) return null;
  const kind = toolKind(category, target);
  const key = category === "Agent" ? `agent:${normalizedAgentIdentity(target)}` : toolActivityKey(callId, { category, target, skillNames: [] });
  return { key, kind, label: safe(`${category} · ${target}`), state } as const;
}

function toolKind(category: string, target: string): "read" | "search" | "edit" | "test" | "step" {
  if (category === "Read") return "read";
  if (category === "Search") return "search";
  if (category === "Edit") return "edit";
  return category === "Command" && /(?:^|\s)(?:npm|npx|pnpm|yarn|bun|uv|pytest|cargo|go)\b.*\btest(?:s|ing)?\b|\b(?:vitest|jest|pytest)\b/i.test(target) ? "test" : "step";
}

function timelineCategory(category: string, target: string): AnswerTimelineToolCategory {
  if (category === "Skill") return "skill";
  if (category === "Tool") return "tool";
  return toolKind(category, target);
}

function toolTimeline(id: string, sequence: number, category: string, target: string, state: "running" | "succeeded" | "failed", result?: string, parentToolId?: string, diff?: string): AnswerTimelineDelta {
  const kind = timelineCategory(category, target);
  const descriptor = { category: category as Parameters<typeof summarizeToolActivity>[0]["category"], target, skillNames: category === "Skill" ? [target] : [] };
  return {
    kind: "tool",
    id: `tool:${id}`,
    sequence,
    category: kind,
    label: safe(summarizeToolActivity(descriptor)),
    ...(category === "Command" ? { command: safe(target) } : {}),
    ...(diff ? { diff: safeToolResult(diff) } : {}),
    ...(result && kind !== "skill" ? { result } : {}),
    ...(parentToolId ? { parentToolId } : {}),
    state
  };
}

function safe(value: string): string { return boundTranscriptMarkdown(redactSecrets(value), MAX_RENDERED_CHARS); }
function safeToolResult(value: string): string { return createBoundedTurnOutput(redactSecrets(value)).text; }
function normalizeStartedAt(value: string): string {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString() : value;
}
