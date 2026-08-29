export type ReportableAgentState = "idle" | "working" | "blocked" | "unknown";

export interface ReporterInput {
  paneId: string;
  name: string;
  executable: string;
  pid: number;
  processStartTicks: string;
}

export interface ReporterOperations {
  processIdentity(paneId: string, pid: number): Promise<{ executable: string; pid: number; startTicks: string } | null>;
  readPane(paneId: string): Promise<string>;
  explainCodexSnapshot(snapshot: string): Promise<unknown>;
  reportAgent(paneId: string, state: ReportableAgentState, sequence: string): Promise<void>;
  renameAgent(paneId: string, name: string): Promise<void>;
  releaseAgent(paneId: string, source: "herdr-traex-shim", agent: "traex", sequence: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface ReporterOptions {
  pollIntervalMs?: number;
  maxCycles?: number;
  sequence?: () => bigint;
}

export class TraexAgentReporter {
  private readonly pollIntervalMs: number;
  private readonly maxCycles: number;
  private readonly sequence: () => bigint;

  constructor(private readonly operations: ReporterOperations, options: ReporterOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.maxCycles = options.maxCycles ?? Number.POSITIVE_INFINITY;
    this.sequence = options.sequence ?? process.hrtime.bigint;
  }

  async run(input: ReporterInput, signal?: AbortSignal): Promise<"released" | "lost-pane"> {
    let outcome: "released" | "lost-pane" = "released";
    let previous: ReportableAgentState | null = null;
    let renamed = false;
    try {
      for (let cycle = 0; cycle < this.maxCycles && !signal?.aborted; cycle += 1) {
        const identity = await this.operations.processIdentity(input.paneId, input.pid);
        if (!identity || identity.pid !== input.pid || identity.executable !== input.executable || identity.startTicks !== input.processStartTicks) {
          outcome = "lost-pane";
          break;
        }
        const state = normalizeState(await this.operations.explainCodexSnapshot(await this.operations.readPane(input.paneId)));
        if (state !== previous) {
          await this.operations.reportAgent(input.paneId, state, this.nextSequence());
          previous = state;
        }
        if (!renamed && state !== "unknown") {
          await this.operations.renameAgent(input.paneId, input.name);
          renamed = true;
        }
        await this.operations.sleep(this.pollIntervalMs);
      }
      return outcome;
    } finally {
      await this.operations.releaseAgent(input.paneId, "herdr-traex-shim", "traex", this.nextSequence());
    }
  }

  private nextSequence(): string { return this.sequence().toString(10); }
}

export function normalizeState(value: unknown): ReportableAgentState {
  if (value === "idle" || value === "working" || value === "blocked") return value;
  return "unknown";
}
