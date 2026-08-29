export type ReportableAgentState = "idle" | "working" | "blocked" | "unknown";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReporterInput {
  paneId: string;
  name: string;
  executable: string;
  pid: number;
  processStartTicks: string;
  launchCorrelationId: string;
}

export interface ReporterOperations {
  processIdentity(paneId: string, pid: number): Promise<{ executable: string; pid: number; startTicks: string } | null>;
  resolveSessionPeer(pid: number, launchCorrelationId: string): Promise<{ status: "resolved"; threadId: string } | { status: "pending" } | { status: "ambiguous" }>;
  reportAgent(paneId: string, state: ReportableAgentState, sequence: string): Promise<void>;
  reportAgentSession(paneId: string, sequence: string, agentSessionId: string): Promise<void>;
  renameAgent(paneId: string, name: string): Promise<void>;
  reportMetadata(paneId: string, sequence: string): Promise<void>;
  clearMetadata(paneId: string, sequence: string): Promise<void>;
  releaseAgent(paneId: string, source: "herdr-traex-shim", agent: "codex", sequence: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface ReporterOptions {
  pollIntervalMs?: number;
  maxCycles?: number;
  sequence?: () => bigint;
  maxSessionResolutionCycles?: number;
}

export class TraexAgentReporter {
  private readonly pollIntervalMs: number;
  private readonly maxCycles: number;
  private readonly sequence: () => bigint;
  private readonly maxSessionResolutionCycles: number;

  constructor(private readonly operations: ReporterOperations, options: ReporterOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.maxCycles = options.maxCycles ?? Number.POSITIVE_INFINITY;
    this.sequence = options.sequence ?? process.hrtime.bigint;
    this.maxSessionResolutionCycles = options.maxSessionResolutionCycles ?? 40;
  }

  async run(input: ReporterInput, signal?: AbortSignal): Promise<"released" | "lost-pane"> {
    if (!SESSION_ID.test(input.launchCorrelationId)) throw new Error("Invalid TraeX launch correlation identity");
    let outcome: "released" | "lost-pane" = "released";
    try {
      const initialIdentity = await this.operations.processIdentity(input.paneId, input.pid);
      if (!initialIdentity || initialIdentity.pid !== input.pid || initialIdentity.executable !== input.executable || initialIdentity.startTicks !== input.processStartTicks) {
        return "lost-pane";
      }
      await this.operations.reportAgent(input.paneId, "idle", this.nextSequence());
      const canonicalThreadId = await this.resolveCanonicalThreadId(input, signal);
      await this.operations.reportAgentSession(input.paneId, this.nextSequence(), canonicalThreadId);
      await this.operations.reportMetadata(input.paneId, this.nextSequence());
      await this.operations.renameAgent(input.paneId, input.name);
      for (let cycle = 0; cycle < this.maxCycles && !signal?.aborted; cycle += 1) {
        const identity = await this.operations.processIdentity(input.paneId, input.pid);
        if (!identity || identity.pid !== input.pid || identity.executable !== input.executable || identity.startTicks !== input.processStartTicks) {
          outcome = "lost-pane";
          break;
        }
        await this.operations.sleep(this.pollIntervalMs);
      }
      return outcome;
    } finally {
      await this.operations.releaseAgent(input.paneId, "herdr-traex-shim", "codex", this.nextSequence());
      await this.operations.clearMetadata(input.paneId, this.nextSequence());
    }
  }

  private nextSequence(): string { return this.sequence().toString(10); }

  private async resolveCanonicalThreadId(input: ReporterInput, signal?: AbortSignal): Promise<string> {
    for (let cycle = 0; cycle < this.maxSessionResolutionCycles && !signal?.aborted; cycle += 1) {
      const identity = await this.operations.processIdentity(input.paneId, input.pid);
      if (!identity || identity.pid !== input.pid || identity.executable !== input.executable || identity.startTicks !== input.processStartTicks) {
        throw new Error("TraeX process identity changed before canonical session resolution");
      }
      const resolution = await this.operations.resolveSessionPeer(input.pid, input.launchCorrelationId);
      if (resolution.status === "resolved") return resolution.threadId;
      if (resolution.status === "ambiguous") throw new Error("TraeX canonical session identity is ambiguous");
      if (cycle + 1 < this.maxSessionResolutionCycles) await this.operations.sleep(this.pollIntervalMs);
    }
    throw new Error("TraeX canonical session identity was not resolved");
  }
}

export function normalizeState(value: unknown): ReportableAgentState {
  if (value === "idle" || value === "working" || value === "blocked") return value;
  return "unknown";
}
