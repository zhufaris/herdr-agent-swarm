import { createHash } from "node:crypto";
import { z } from "zod";
import type { Logger } from "pino";
import type { CommandRunner } from "../infra/command-runner.js";
import type { AgentTranscriptObservation, AgentTranscriptOpenResult, AgentTranscriptReaderPort, AgentTranscriptSource, HerdrPort } from "../domain/ports/external.js";
import type { AgentTranscriptDescriptor } from "./agent-transcript-reader.js";

export type AgentTranscriptDescriptorResolver = (source: AgentTranscriptSource) => Promise<AgentTranscriptDescriptor | null>;

const sourceSchema = z.object({ source_id: z.string().min(1).max(256), terminal_id: z.string().min(1), agent_kind: z.enum(["traex", "pi"]), session_id: z.string(), state: z.string(), checkpoint_offset: z.number().int().nonnegative(), latest_cursor: z.string().max(1024) });
const attachedSchema = z.object({ result: z.object({ type: z.literal("agent_events_attached"), source_id: z.string().min(1).max(256), attach_offset: z.number().int().nonnegative(), sources: z.array(sourceSchema).max(256) }) });
const sourcesSchema = z.object({ result: z.object({ type: z.literal("agent_events_sources"), enabled: z.boolean(), sources: z.array(sourceSchema).max(256) }) });
const eventSchema = z.object({ schema_version: z.literal(1), source_id: z.string(), turn_id: z.string().nullable(), payload: z.union([
  z.object({ type: z.literal("message"), channel: z.string(), text: z.string().max(20_000), truncated: z.boolean() }),
  z.object({ type: z.enum(["turn_started", "turn_completed", "turn_aborted", "tool_call", "tool_result", "branch_changed", "source_error"]) })
]) });
const batchSchema = z.object({ result: z.object({ type: z.literal("agent_events_batch"), events: z.array(eventSchema).max(128), next_cursor: z.string().max(1024), latest_cursor: z.string().max(1024) }) });

export class HerdrEventsShadowReader implements AgentTranscriptReaderPort {
  private inFlight = 0;

  constructor(
    private readonly primary: AgentTranscriptReaderPort,
    private readonly runner: CommandRunner,
    private readonly herdr: Pick<HerdrPort, "listAllPanes">,
    private readonly executable: string,
    private readonly logger: Logger,
    private readonly resolveTranscript: AgentTranscriptDescriptorResolver
  ) {}

  open(source: AgentTranscriptSource) { return this.wrap(source, this.primary.open(source)); }
  openActiveTurn(source: AgentTranscriptSource) { return this.wrap(source, this.primary.openActiveTurn?.(source) ?? this.primary.open(source)); }
  openFirstTurn(source: AgentTranscriptSource) { return this.wrap(source, this.primary.openFirstTurn?.(source) ?? Promise.resolve(unavailable())); }
  openAtTurn(source: AgentTranscriptSource, turnId: string, startedAt: string) { return this.wrap(source, this.primary.openAtTurn?.(source, turnId, startedAt) ?? Promise.resolve(unavailable())); }
  openAfterTurn(source: AgentTranscriptSource, turnId: string, startedAt: string) { return this.wrap(source, this.primary.openAfterTurn?.(source, turnId, startedAt) ?? Promise.resolve(unavailable())); }

  private async wrap(source: AgentTranscriptSource, opened: Promise<AgentTranscriptOpenResult>): Promise<AgentTranscriptOpenResult> {
    const result = await opened;
    if (result.mode !== "typed" || !result.cursor.readObservation) return result;
    const cursor = result.cursor;
    const baseline = await this.prepare(source).then(value => ({ value }), error => ({ error }));
    let comparedTurn: string | undefined;
    return { mode: "typed", cursor: {
      readDelta: () => cursor.readDelta(),
      readObservation: async () => {
        const observation = await cursor.readObservation!();
        const turn = observation.turnLifecycle;
        if (turn && turn.state !== "active" && turn.turnId !== comparedTurn) {
          comparedTurn = turn.turnId;
          if (this.inFlight >= 2) {
            this.logger.debug({ bindingId: source.bindingId, generation: source.generation, turnId: turn.turnId, agentKind: source.agentKind, outcome: "capacity_skipped" }, "Herdr reply shadow comparison");
          } else {
            this.inFlight += 1;
            void this.compare(source, observation, baseline).catch((error: unknown) => {
              this.logger.debug({ bindingId: source.bindingId, generation: source.generation, turnId: turn.turnId, agentKind: source.agentKind, outcome: "unavailable", reason: safeReason(error) }, "Herdr reply shadow comparison");
            }).finally(() => { this.inFlight -= 1; });
          }
        }
        return observation;
      }
    } };
  }

  private async prepare(source: AgentTranscriptSource): Promise<{ sourceId: string; after: string }> {
    if (!source.paneId || !this.herdr.listAllPanes) throw new Error("identity unavailable");
    const panes = (await this.herdr.listAllPanes()).filter((pane) => pane.paneId === source.paneId);
    if (panes.length !== 1 || !panes[0]!.terminalId) throw new Error("identity unavailable");
    const descriptor = await this.resolveTranscript(source);
    if (!descriptor) throw new Error("transcript unavailable");
    const attached = attachedSchema.parse(await this.read(["attach", "--pane", source.paneId, "--kind", source.agentKind, "--session-id", descriptor.sessionId, "--path", descriptor.path])).result;
    let candidate = exactSource(attached.sources, attached.source_id, panes[0]!.terminalId, source.agentKind, descriptor.sessionId);
    for (let attempt = 0; candidate && candidate.checkpoint_offset < attached.attach_offset && attempt < 8; attempt += 1) {
      await wait(125);
      const sources = sourcesSchema.parse(await this.read(["sources"])).result.sources;
      candidate = exactSource(sources, attached.source_id, panes[0]!.terminalId, source.agentKind, descriptor.sessionId);
    }
    if (!candidate || candidate.state !== "active" || candidate.checkpoint_offset < attached.attach_offset) throw new Error("source unavailable");
    return { sourceId: candidate.source_id, after: candidate.latest_cursor };
  }

  private async compare(source: AgentTranscriptSource, observation: AgentTranscriptObservation, baseline: { value: { sourceId: string; after: string } } | { error: unknown }): Promise<void> {
    const turn = observation.turnLifecycle!;
    const report = (outcome: string) => this.logger.info({ bindingId: source.bindingId, generation: source.generation, turnId: turn.turnId, agentKind: source.agentKind, outcome }, "Herdr reply shadow comparison");
    if ("error" in baseline) throw baseline.error;
    const { sourceId } = baseline.value;
    let after = baseline.value.after;
    let finalText: string | undefined;
    let truncated = false;
    let state: string | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const batch = batchSchema.parse(await this.read(["read", "--source", sourceId, "--after", after, "--limit", "128"])).result;
      for (const event of batch.events) {
        if (event.source_id !== sourceId) throw new Error("event source mismatch");
        if (event.turn_id !== turn.turnId) continue;
        if (event.payload.type === "message" && "channel" in event.payload && event.payload.channel === "final") {
          finalText = event.payload.text;
          truncated = event.payload.truncated;
        }
        if (event.payload.type === "turn_completed") state = "completed";
        if (event.payload.type === "turn_aborted") state = "aborted";
      }
      if (batch.next_cursor === batch.latest_cursor) {
        if (!state) {
          if (attempt < 7) { await wait(125); continue; }
          return void report("pending");
        }
        if (state !== turn.state) return void report("lifecycle_mismatch");
        if (turn.state === "aborted") return void report("lifecycle_match");
        if (truncated || finalText === undefined || turn.finalAnswer === undefined) return void report("answer_not_comparable");
        return void report(digest(finalText) === digest(turn.finalAnswer) ? "match" : "answer_mismatch");
      }
      if (batch.next_cursor === after) throw new Error("event cursor stalled");
      after = batch.next_cursor;
    }
    report("scan_limit");
  }

  private async read(args: string[]): Promise<unknown> {
    const { stdout } = await this.runner.run(this.executable, ["agent", "events", ...args], 2_000, undefined, AbortSignal.timeout(5_000));
    if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) throw new Error("oversized event response");
    return JSON.parse(stdout) as unknown;
  }
}

function digest(text: string): string { return createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex"); }
function safeReason(error: unknown): string {
  if (error instanceof z.ZodError) return "invalid_response";
  if (error instanceof SyntaxError) return "invalid_json";
  if (error instanceof Error && error.message === "oversized event response") return "oversized_response";
  if (error instanceof Error && error.message === "event source mismatch") return "source_mismatch";
  if (error instanceof Error && error.message === "event cursor stalled") return "cursor_stalled";
  return "command_unavailable";
}
function wait(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
function unavailable(): AgentTranscriptOpenResult { return { mode: "unavailable", reason: "unsupported_session_identity" }; }
function exactSource(sources: z.infer<typeof sourceSchema>[], sourceId: string, terminalId: string, agentKind: string, sessionId: string) {
  const matches = sources.filter((candidate) => candidate.source_id === sourceId && candidate.terminal_id === terminalId && candidate.agent_kind === agentKind && candidate.session_id === sessionId);
  return matches.length === 1 ? matches[0] : undefined;
}
