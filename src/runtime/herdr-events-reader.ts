import { z } from "zod";
import { CommandError, type CommandRunner } from "../infra/command-runner.js";
import type {
  AgentTranscriptBoundary,
  AgentTranscriptCursorPort,
  AgentTranscriptMainStatus,
  AgentTranscriptObservation,
  AgentTranscriptOpenResult,
  AgentTranscriptReaderPort,
  AgentTranscriptSource,
  HerdrPort,
  MainCardAgentMessage
} from "../domain/ports/external.js";
import type { AnswerTimelineDelta, AnswerTimelineToolCategory } from "../domain/answer-timeline.js";
import { boundTranscriptMarkdown } from "./agent-transcript-codec.js";
import { piSessionId } from "./agents/pi-transcript-identity.js";
import { parsePlanToolCall } from "./plan-snapshot.js";
import { normalizeToolOutput, projectToolCall, projectToolResultState, type ToolActivityDescriptor } from "./tool-activity-projector.js";
import { redactSecrets } from "./redact-secrets.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RENDERED_CHARS = 64_000;

const sourceSchema = z.object({
  source_id: z.string().min(1).max(256),
  terminal_id: z.string().min(1),
  agent_kind: z.enum(["traex", "pi"]),
  session_id: z.string(),
  state: z.string(),
  checkpoint_offset: z.number().int().nonnegative(),
  earliest_cursor: z.string().max(1024),
  latest_cursor: z.string().max(1024)
});
const attachedSchema = z.object({ result: z.object({
  type: z.literal("agent_events_attached"),
  source_id: z.string().min(1).max(256),
  attach_offset: z.number().int().nonnegative(),
  sources: z.array(sourceSchema).max(256)
}) });
const sourcesSchema = z.object({ result: z.object({
  type: z.literal("agent_events_sources"),
  enabled: z.boolean(),
  sources: z.array(sourceSchema).max(256)
}) });
const eventSchema = z.object({
  schema_version: z.literal(1),
  event_id: z.string().min(1),
  cursor: z.string().min(1),
  source_id: z.string().min(1),
  agent_kind: z.enum(["traex", "pi"]),
  session_id: z.string(),
  turn_id: z.string().nullable(),
  occurred_at: z.string(),
  payload: z.discriminatedUnion("type", [
    z.object({ type: z.literal("turn_started") }),
    z.object({ type: z.literal("turn_completed") }),
    z.object({ type: z.literal("turn_aborted"), reason: z.string() }),
    z.object({ type: z.literal("human_message"), message_id: z.string().min(1), text: z.string(), truncated: z.boolean() }),
    z.object({ type: z.literal("message"), message_id: z.string().min(1), channel: z.enum(["commentary", "final"]), text: z.string(), truncated: z.boolean() }),
    z.object({ type: z.literal("tool_call"), call_id: z.string().min(1), name: z.string(), arguments: z.string(), truncated: z.boolean() }),
    z.object({ type: z.literal("tool_result"), call_id: z.string().min(1), text: z.string(), is_error: z.boolean(), truncated: z.boolean() }),
    z.object({ type: z.literal("files_changed"), file_count: z.number().int().nonnegative().max(65_536) }),
    z.object({ type: z.literal("branch_changed"), parent_id: z.string().nullable() }),
    z.object({ type: z.literal("source_error"), code: z.string() }),
    z.object({ type: z.literal("record_skipped"), code: z.string() })
  ])
});
type AgentEvent = z.infer<typeof eventSchema>;
const batchSchema = z.object({ result: z.object({
  type: z.literal("agent_events_batch"),
  events: z.array(eventSchema).max(128),
  next_cursor: z.string().max(1024),
  earliest_cursor: z.string().max(1024),
  latest_cursor: z.string().max(1024)
}) });
const turnCursorSchema = z.object({ result: z.object({
  type: z.literal("agent_events_turn_cursor"),
  source_id: z.string().min(1).max(256),
  found: z.boolean(),
  after_cursor: z.string().max(1024)
}) });

export class HerdrEventsReader implements AgentTranscriptReaderPort {
  constructor(
    private readonly runner: CommandRunner,
    private readonly herdr: Pick<HerdrPort, "listAllPanes">,
    private readonly executable: string
  ) {}

  async open(source: AgentTranscriptSource, boundary: AgentTranscriptBoundary = { kind: "latest" }): Promise<AgentTranscriptOpenResult> {
    try {
      const attached = await this.attach(source, "end");
      const liveRead = this.readFor(attached.source);
      if (boundary.kind === "latest") return typed(new HerdrEventCursor(liveRead, attached.source.source_id, attached.source.latest_cursor));
      if (boundary.kind === "first") return typed(new HerdrEventCursor(liveRead, attached.source.source_id, attached.source.earliest_cursor));
      for (const candidate of attached.recoverySources) {
        try {
          const located = await this.locate(candidate, boundary);
          if (located.found) {
            const successor = candidate.source_id === attached.source.source_id ? undefined : {
              readBatch: liveRead,
              sourceId: attached.source.source_id,
              after: attached.source.latest_cursor
            };
            return typed(new HerdrEventCursor(this.readFor(candidate), candidate.source_id, located.afterCursor, [], successor));
          }
        } catch {
          continue;
        }
      }
      return unavailable(boundary.kind === "active" ? "turn_boundary_incomplete" : "turn_boundary_not_found");
    } catch {
      return unavailable("transcript_validation_failed");
    }
  }

  private async attach(source: AgentTranscriptSource, from: "start" | "end"): Promise<{ source: z.infer<typeof sourceSchema>; recoverySources: z.infer<typeof sourceSchema>[] }> {
    if (!source.paneId || !this.herdr.listAllPanes) throw new Error("identity unavailable");
    const panes = (await this.herdr.listAllPanes()).filter((pane) => pane.paneId === source.paneId);
    if (panes.length !== 1 || !panes[0]!.terminalId) throw new Error("identity unavailable");
    const sessionId = expectedSessionId(source);
    if (!sessionId) throw new Error("Agent event source unavailable");
    try {
      const listed = sourcesSchema.parse(await this.command(["sources"])).result;
      if (!listed.enabled) throw new Error("agent events disabled");
      const discovered = selectActiveSource(listed.sources, panes[0]!.terminalId, source.agentKind, sessionId);
      if (discovered) return discovered;
    } catch {
      // Herdr releases before the Core-owned source registry can still support
      // the legacy path-free attach contract below.
    }
    const attached = attachedSchema.parse(await this.command([
      "attach", "--pane", source.paneId, "--kind", source.agentKind,
      "--session-id", sessionId, "--from", from
    ])).result;
    let candidates = attached.sources;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const matches = candidates.filter((candidate) => candidate.source_id === attached.source_id
        && candidate.terminal_id === panes[0]!.terminalId
        && candidate.agent_kind === source.agentKind
        && candidate.session_id === sessionId);
      const match = matches.length === 1 ? matches[0] : undefined;
      if (match?.state === "active" && match.checkpoint_offset >= attached.attach_offset) {
        const historical = candidates.filter((candidate) => candidate.agent_kind === source.agentKind
          && candidate.session_id === sessionId
          && candidate.source_id !== match.source_id)
          .sort((left, right) => right.checkpoint_offset - left.checkpoint_offset);
        return { source: match, recoverySources: [match, ...historical] };
      }
      if (attempt < 7) {
        await wait(125);
        const listed = sourcesSchema.parse(await this.command(["sources"])).result;
        if (!listed.enabled) throw new Error("agent events disabled");
        candidates = listed.sources;
      }
    }
    throw new Error("source unavailable");
  }

  private async locate(source: z.infer<typeof sourceSchema>, boundary: Exclude<AgentTranscriptBoundary, { kind: "latest" | "first" }>): Promise<{ found: boolean; afterCursor: string }> {
    const args = ["locate", "--source", source.source_id, "--boundary", boundary.kind];
    if (boundary.kind === "at" || boundary.kind === "after") {
      args.push("--turn-id", boundary.turnId, "--started-at", boundary.startedAt);
    }
    const parsed = turnCursorSchema.parse(await this.command(args)).result;
    if (parsed.source_id !== source.source_id) throw new Error("event identity mismatch");
    return { found: parsed.found, afterCursor: parsed.after_cursor };
  }

  private readFor(source: z.infer<typeof sourceSchema>) {
    return (sourceId: string, after: string) => this.read(sourceId, after, source);
  }

  private async read(sourceId: string, after: string, expected: Pick<z.infer<typeof sourceSchema>, "agent_kind" | "session_id">): Promise<{ events: AgentEvent[]; nextCursor: string; earliestCursor: string; latestCursor: string }> {
    let response: unknown;
    try {
      response = await this.command(["read", "--source", sourceId, "--after", after, "--limit", "128"]);
    } catch (error) {
      const retainedFloor = error instanceof CommandError && error.apiFailure?.code === "cursor_expired"
        ? error.apiFailure.earliestCursor
        : undefined;
      if (!retainedFloor || retainedFloor === after) throw error;
      response = await this.command(["read", "--source", sourceId, "--after", retainedFloor, "--limit", "128"]);
    }
    const parsed = batchSchema.parse(response).result;
    if (parsed.events.some((event) => event.source_id !== sourceId || event.agent_kind !== expected.agent_kind || event.session_id !== expected.session_id)) throw new Error("event identity mismatch");
    if (parsed.next_cursor === after && parsed.latest_cursor !== after) throw new Error("event cursor stalled");
    return { events: parsed.events, nextCursor: parsed.next_cursor, earliestCursor: parsed.earliest_cursor, latestCursor: parsed.latest_cursor };
  }

  private async command(args: string[]): Promise<unknown> {
    const { stdout } = await this.runner.run(this.executable, ["agent", "events", ...args], 2_000, undefined, AbortSignal.timeout(5_000));
    if (Buffer.byteLength(stdout) > MAX_RESPONSE_BYTES) throw new Error("oversized event response");
    return JSON.parse(stdout) as unknown;
  }
}

function selectActiveSource(
  sources: z.infer<typeof sourceSchema>[],
  terminalId: string,
  agentKind: AgentTranscriptSource["agentKind"],
  sessionId: string
): { source: z.infer<typeof sourceSchema>; recoverySources: z.infer<typeof sourceSchema>[] } | null {
  const matches = sources.filter((candidate) => candidate.terminal_id === terminalId
    && candidate.agent_kind === agentKind
    && candidate.session_id === sessionId
    && candidate.state === "active");
  if (matches.length !== 1) return null;
  const source = matches[0]!;
  const historical = sources.filter((candidate) => candidate.agent_kind === agentKind
    && candidate.session_id === sessionId
    && candidate.source_id !== source.source_id)
    .sort((left, right) => right.checkpoint_offset - left.checkpoint_offset);
  return { source, recoverySources: [source, ...historical] };
}

function expectedSessionId(source: AgentTranscriptSource): string | null {
  if (source.agentKind === "traex") {
    const session = source.nativeSession;
    return session?.agent === "traex" && session.kind === "id" ? session.value : null;
  }
  if (source.agentKind === "pi" && source.bindingId && Number.isInteger(source.generation)) {
    return piSessionId(source.bindingId, source.generation);
  }
  return null;
}

class HerdrEventCursor implements AgentTranscriptCursorPort {
  private pending: AgentEvent[];
  private readonly calls = new Map<string, { descriptor: ToolActivityDescriptor; sequence: number }>();
  private readonly planCalls = new Set<string>();
  private readonly messages = new Map<string, { channel: "commentary" | "final"; markdown: string; sequence: number }>();
  private sequence = 1;
  private filesChangedSequence: number | undefined;
  private filesChangedCount = 0;
  private turnId: string | undefined;
  private startedAt: string | undefined;
  private finalAnswer: string | undefined;
  private terminal: "completed" | "aborted" | undefined;
  private terminalReason: string | undefined;
  private readonly pendingRequestTexts = new Map<string, string>();

  constructor(
    private readBatch: (sourceId: string, after: string) => Promise<{ events: AgentEvent[]; nextCursor: string; latestCursor: string }>,
    private sourceId: string,
    private after: string,
    initial: AgentEvent[] = [],
    private successor?: {
      readBatch: (sourceId: string, after: string) => Promise<{ events: AgentEvent[]; nextCursor: string; latestCursor: string }>;
      sourceId: string;
      after: string;
    }
  ) { this.pending = initial; }

  async readDelta(): Promise<string> { return (await this.readObservation()).answerDelta; }
  async readObservation(): Promise<AgentTranscriptObservation> {
    let events = this.pending;
    this.pending = [];
    if (events.length === 0) {
      const batch = await this.readBatch(this.sourceId, this.after);
      this.after = batch.nextCursor;
      events = batch.events;
      if (this.successor && batch.nextCursor === batch.latestCursor) {
        events = events.filter((event) => event.payload.type !== "source_error" || event.payload.code !== "runtime_identity_changed");
        this.readBatch = this.successor.readBatch;
        this.sourceId = this.successor.sourceId;
        this.after = this.successor.after;
        this.successor = undefined;
      }
    }
    const nextTurn = events.findIndex((event, index) => index > 0 && event.payload.type === "turn_started");
    if (nextTurn > 0) {
      this.pending = events.slice(nextTurn);
      events = events.slice(0, nextTurn);
    }
    return projectEvents(events, this);
  }

  nextSequence(): number { return this.sequence++; }
  editedFilesSequence(): number {
    this.filesChangedSequence ??= this.nextSequence();
    return this.filesChangedSequence;
  }
  acceptFilesChangedCount(count: number): boolean {
    if (count <= this.filesChangedCount) return false;
    this.filesChangedCount = count;
    return true;
  }
  projectionState() { return { calls: this.calls, planCalls: this.planCalls, messages: this.messages, turnId: this.turnId, startedAt: this.startedAt, finalAnswer: this.finalAnswer, terminal: this.terminal, terminalReason: this.terminalReason }; }
  updateProjectionState(state: { turnId?: string; startedAt?: string; finalAnswer?: string; terminal?: "completed" | "aborted"; terminalReason?: string }) {
    this.turnId = state.turnId; this.startedAt = state.startedAt; this.finalAnswer = state.finalAnswer; this.terminal = state.terminal; this.terminalReason = state.terminalReason;
  }
  resetTurn(): void { this.calls.clear(); this.planCalls.clear(); this.messages.clear(); this.sequence = 1; this.filesChangedSequence = undefined; this.filesChangedCount = 0; this.terminal = undefined; this.terminalReason = undefined; }
  rememberRequestText(turnId: string, value: string): void { this.pendingRequestTexts.set(turnId, value); }
  consumeRequestText(turnId: string): string | undefined { const value = this.pendingRequestTexts.get(turnId); this.pendingRequestTexts.delete(turnId); return value; }
}

function projectEvents(events: AgentEvent[], cursor: HerdrEventCursor): AgentTranscriptObservation {
  if (events.length === 0) return { answerDelta: "" };
  const state = cursor.projectionState();
  const { calls, planCalls, messages } = state;
  let { turnId, startedAt, finalAnswer, terminal, terminalReason: reason } = state;
  let requestText: string | undefined;
  let freshTurnStart = false;
  let mainStatus: AgentTranscriptMainStatus | undefined;
  const answers: string[] = [];
  const agentMessages: MainCardAgentMessage[] = [];
  const toolActivities: NonNullable<AgentTranscriptObservation["toolActivities"]> = [];
  const timelineDeltas: AnswerTimelineDelta[] = [];
  for (const event of events) {
    const previousTurnId = turnId;
    if (event.turn_id) turnId = event.turn_id;
    const payload = event.payload;
    if (payload.type === "human_message") {
      const text = safe(payload.text);
      const requestTurnId = event.turn_id ?? undefined;
      if (text && requestTurnId) {
        if (startedAt && previousTurnId === requestTurnId && terminal === undefined) requestText = text;
        else cursor.rememberRequestText(requestTurnId, text);
      }
      continue;
    }
    if (payload.type === "turn_started") {
      turnId = event.turn_id ?? undefined;
      freshTurnStart = true;
      startedAt = normalizeStartedAt(event.occurred_at);
      finalAnswer = undefined;
      terminal = undefined;
      reason = undefined;
      cursor.resetTurn();
      if (turnId) requestText = cursor.consumeRequestText(turnId) ?? requestText;
      continue;
    }
    if (payload.type === "message" && turnId) {
      const markdown = safe(payload.text);
      if (!markdown) continue;
      const previous = messages.get(payload.message_id);
      if (previous?.channel === payload.channel && previous.markdown === markdown) continue;
      const sequence = previous?.sequence ?? cursor.nextSequence();
      messages.set(payload.message_id, { channel: payload.channel, markdown, sequence });
      if (!previous) answers.push(markdown);
      agentMessages.push({ messageId: payload.message_id, turnId, channel: payload.channel, markdown, occurredAt: event.occurred_at });
      timelineDeltas.push({ kind: payload.channel === "final" ? "final_answer" : "agent_message", id: `message:${payload.message_id}`, sequence, markdown });
      if (payload.channel === "final") finalAnswer = markdown;
      continue;
    }
    if (payload.type === "tool_call") {
      const plan = parsePlanToolCall(payload.name, payload.arguments);
      if (payload.name === "update_plan" || plan) {
        planCalls.add(payload.call_id);
        if (plan) mainStatus = { ...mainStatus, planSteps: plan };
        continue;
      }
      const projected = projectToolCall(payload.name, payload.arguments);
      const sequence = cursor.nextSequence();
      calls.set(payload.call_id, { descriptor: projected.descriptor, sequence });
      const activity = toolActivity(payload.call_id, projected.descriptor, "active");
      if (activity) {
        toolActivities.push(activity);
        timelineDeltas.push(toolTimeline(payload.call_id, sequence, projected.descriptor, "running"));
      }
      continue;
    }
    if (payload.type === "tool_result") {
      if (planCalls.delete(payload.call_id)) continue;
      const call = calls.get(payload.call_id);
      if (!call) continue;
      const resultState = payload.is_error ? "failed" : projectToolResultState(payload.text);
      const activity = toolActivity(payload.call_id, call.descriptor, resultState);
      if (activity) {
        toolActivities.push(activity);
        timelineDeltas.push(toolTimeline(payload.call_id, call.sequence, call.descriptor, resultState === "active" ? "running" : resultState === "done" ? "succeeded" : "failed", payload.text));
      }
      continue;
    }
    if (payload.type === "files_changed" && turnId) {
      if (!cursor.acceptFilesChangedCount(payload.file_count)) continue;
      const id = `files-changed:${turnId}`;
      const label = `已编辑 ${payload.file_count} 个文件`;
      toolActivities.push({ key: id, kind: "edit", label, state: "done" });
      timelineDeltas.push({ kind: "tool", id, sequence: cursor.editedFilesSequence(), category: "edit", label, state: "succeeded" });
      continue;
    }
    if (payload.type === "turn_completed") terminal = "completed";
    if (payload.type === "turn_aborted") { terminal = "aborted"; reason = safe(payload.reason); }
    if (payload.type === "source_error") throw new Error(`agent event source failed: ${payload.code}`);
  }
  cursor.updateProjectionState({ ...(turnId ? { turnId } : {}), ...(startedAt ? { startedAt } : {}), ...(finalAnswer ? { finalAnswer } : {}), ...(terminal ? { terminal } : {}), ...(reason ? { terminalReason: reason } : {}) });
  return {
    ...(turnId ? { turnId } : {}),
    ...(freshTurnStart ? { freshTurnStart: true } : {}),
    ...(requestText ? { requestText } : {}),
    answerDelta: safe(answers.join("\n\n")),
    ...(agentMessages.length ? { agentMessages } : {}),
    ...(toolActivities.length ? { toolActivities } : {}),
    ...(timelineDeltas.length ? { timelineDeltas } : {}),
    ...(mainStatus ? { mainStatus } : {}),
    ...(turnId && startedAt ? { turnLifecycle: { turnId, state: terminal ?? "active", startedAt, ...(terminal === "completed" && finalAnswer ? { finalAnswer } : {}), ...(terminal === "aborted" && reason ? { reason } : {}) } } : {})
  };
}

function toolActivity(callId: string, descriptor: ToolActivityDescriptor, state: "active" | "done" | "failed"): NonNullable<AgentTranscriptObservation["toolActivities"]>[number] | null {
  if (descriptor.category === "Command" && !descriptor.target) return null;
  return { key: `tool:${callId}`, kind: toolKind(descriptor), label: safe(`${descriptor.category} · ${descriptor.target}`), state };
}
function toolKind(descriptor: ToolActivityDescriptor): "analyze" | "read" | "search" | "edit" | "test" {
  if (descriptor.category === "Read") return "read";
  if (descriptor.category === "Search") return "search";
  if (descriptor.category === "Edit") return "edit";
  return descriptor.category === "Command" && /(?:^|\s)(?:npm|npx|pnpm|yarn|bun|uv|pytest|cargo|go)\b.*\btest(?:s|ing)?\b|\b(?:vitest|jest|pytest)\b/i.test(descriptor.target) ? "test" : "analyze";
}
function timelineCategory(descriptor: ToolActivityDescriptor): AnswerTimelineToolCategory {
  if (descriptor.inputPreview) return "input";
  if (descriptor.category === "Skill") return "skill";
  if (descriptor.category === "Agent") return "agent";
  const kind = toolKind(descriptor);
  if (kind !== "analyze") return kind;
  return descriptor.category === "Command" ? "command" : "step";
}
function toolTimeline(id: string, sequence: number, descriptor: ToolActivityDescriptor, state: "running" | "succeeded" | "failed", output?: string): AnswerTimelineDelta {
  const category = timelineCategory(descriptor);
  const resultPreview = output === undefined || category === "input" || category === "skill" ? "" : safe(normalizeToolOutput(output));
  return {
    kind: "tool", id: `tool:${id}`, sequence, category,
    label: safe(descriptor.target || descriptor.category),
    ...(descriptor.inputPreview ? { command: safe(descriptor.inputPreview) } : category === "command" || category === "test" ? { command: safe(descriptor.target) } : {}),
    ...(resultPreview ? { resultPreview } : {}), state
  };
}
function safe(value: string): string { return boundTranscriptMarkdown(redactSecrets(value), MAX_RENDERED_CHARS); }
function typed(cursor: AgentTranscriptCursorPort): AgentTranscriptOpenResult { return { mode: "typed", cursor }; }
function unavailable(reason: Extract<AgentTranscriptOpenResult, { mode: "unavailable" }>["reason"]): AgentTranscriptOpenResult { return { mode: "unavailable", reason }; }
function wait(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function normalizeStartedAt(value: string): string {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}
