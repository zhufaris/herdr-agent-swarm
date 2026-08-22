import { z } from "zod";
import type { HerdrPort } from "../domain/ports.js";
import type { AgentState, HerdrPane } from "../domain/types.js";
import type { CommandRunner } from "../infra/command-runner.js";

const envelopeSchema = z.object({ id: z.string(), result: z.unknown() });
const paneSchema = z.object({
  pane_id: z.string(), workspace_id: z.string(), cwd: z.string().nullish(), label: z.string().nullish(),
  agent_status: z.enum(["idle", "working", "blocked", "done", "unknown"]).default("unknown")
}).passthrough();
const processSchema = z.object({
  foreground_processes: z.array(z.object({ name: z.string().optional(), argv: z.array(z.string()).optional() }).passthrough()).default([])
}).passthrough();

export class HerdrCliAdapter implements HerdrPort {
  constructor(
    private readonly runner: CommandRunner,
    private readonly executable: string,
    private readonly commandTimeoutMs: number
  ) {}

  async assertWorkspace(workspaceId: string): Promise<void> {
    const result = await this.json(["workspace", "get", workspaceId]);
    const workspace = z.object({ workspace: z.object({ workspace_id: z.string() }) }).parse(result);
    if (workspace.workspace.workspace_id !== workspaceId) throw new Error(`Herdr workspace mismatch: ${workspaceId}`);
  }

  async listPanes(workspaceId: string): Promise<HerdrPane[]> {
    const result = await this.json(["pane", "list", "--workspace", workspaceId]);
    const panes = z.object({ panes: z.array(paneSchema) }).parse(result).panes;
    return Promise.all(panes.map((pane) => this.enrichPane(pane)));
  }

  async getPane(paneId: string): Promise<HerdrPane | null> {
    try {
      const result = await this.json(["pane", "get", paneId]);
      return this.enrichPane(z.object({ pane: paneSchema }).parse(result).pane);
    } catch (error) {
      if (String(error).includes("not found")) return null;
      throw error;
    }
  }

  async createPane(workspaceId: string, cwd: string): Promise<HerdrPane> {
    const panes = await this.listPanes(workspaceId);
    const anchor = panes[0];
    if (!anchor) throw new Error(`Cannot create pane: workspace ${workspaceId} has no anchor pane`);
    const result = await this.json([
      "pane", "split", "--pane", anchor.paneId, "--direction", "right", "--ratio", "0.5",
      "--cwd", cwd, "--no-focus"
    ]);
    const candidate = findPaneRecord(result);
    if (!candidate) throw new Error("Herdr pane split response did not contain a pane");
    return this.enrichPane(candidate);
  }

  async startTraex(paneId: string, executable: string): Promise<void> {
    await this.runner.run(this.executable, ["pane", "run", paneId, executable, "--permission-mode", "auto"], this.commandTimeoutMs);
    await this.waitUntilTraex(paneId);
  }

  async runPrompt(
    paneId: string,
    text: string,
    timeoutMs: number,
    onObservation?: (observation: { state: AgentState; output: string }) => void | Promise<void>
  ): Promise<AgentState> {
    const before = await this.readOutput(paneId, 240);
    await this.runner.run(this.executable, ["pane", "send-text", paneId, text], this.commandTimeoutMs);
    await this.runner.run(this.executable, ["pane", "send-keys", paneId, "Enter"], this.commandTimeoutMs);
    return this.waitForTraexTurn(paneId, before, timeoutMs, onObservation);
  }

  async steerPrompt(paneId: string, text: string): Promise<"injected" | "not_working"> {
    const pane = await this.getPane(paneId);
    if (!pane || pane.agentState !== "working") return "not_working";
    await this.runner.run(this.executable, ["pane", "send-text", paneId, text], this.commandTimeoutMs);
    await this.runner.run(this.executable, ["pane", "send-keys", paneId, "Enter"], this.commandTimeoutMs);
    return "injected";
  }

  async readOutput(paneId: string, lines: number): Promise<string> {
    const { stdout } = await this.runner.run(this.executable, [
      "agent", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines), "--format", "text"
    ], this.commandTimeoutMs);
    return unwrapText(stdout);
  }

  async renamePane(paneId: string, title: string): Promise<void> {
    await this.runner.run(this.executable, ["pane", "rename", paneId, title], this.commandTimeoutMs);
  }

  private async enrichPane(raw: z.infer<typeof paneSchema>): Promise<HerdrPane> {
    let foregroundExecutables: string[] = [];
    try {
      const result = await this.json(["pane", "process-info", "--pane", raw.pane_id]);
      const processInfo = z.object({ process_info: processSchema }).parse(result).process_info;
      foregroundExecutables = processInfo.foreground_processes.flatMap((process) => {
        const values = [process.name, process.argv?.[0]].filter((value): value is string => Boolean(value));
        return values.map((value) => value.split("/").at(-1) ?? value);
      });
    } catch {
      // A pane can disappear between list and process inspection. Reconciliation handles it.
    }
    return {
      paneId: raw.pane_id, workspaceId: raw.workspace_id, cwd: raw.cwd ?? null, label: raw.label ?? null,
      agentState: raw.agent_status, foregroundExecutables: [...new Set(foregroundExecutables)]
    };
  }

  private async waitUntilTraex(paneId: string): Promise<void> {
    const deadline = Date.now() + this.commandTimeoutMs;
    while (Date.now() < deadline) {
      const pane = await this.getPane(paneId);
      if (pane?.foregroundExecutables.includes("traex")) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`TraeX did not become ready in pane ${paneId}`);
  }

  private async waitForTraexTurn(
    paneId: string,
    before: string,
    timeoutMs: number,
    onObservation?: (observation: { state: AgentState; output: string }) => void | Promise<void>
  ): Promise<AgentState> {
    const deadline = Date.now() + timeoutMs;
    let observedWorking = false;
    let lastAgentState: AgentState = "unknown";
    let lastOutput = before;
    let stableIdlePolls = 0;

    while (Date.now() < deadline) {
      let agentState: AgentState = "unknown";
      try {
        const pane = await this.getPane(paneId);
        if (!pane) throw new Error(`Herdr pane not found: ${paneId}`);
        agentState = pane.agentState;
      } catch (error) {
        if (String(error).includes("pane not found")) throw error;
      }
      if (agentState === "working" || agentState === "blocked") observedWorking = true;
      const output = await this.readOutput(paneId, 240);
      if ((agentState !== "unknown" && agentState !== lastAgentState) || output !== lastOutput) {
        if (agentState !== "unknown") lastAgentState = agentState;
        await onObservation?.({ state: agentState, output });
      }
      if (observedWorking && (agentState === "done" || agentState === "idle")) return "done";
      if (agentState === "unknown" && isTraexWorking(output)) {
        observedWorking = true;
        stableIdlePolls = 0;
      } else if (agentState === "unknown" && observedWorking) {
        stableIdlePolls = output === lastOutput ? stableIdlePolls + 1 : 0;
        if (stableIdlePolls >= 1) return "done";
      }
      lastOutput = output;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`Timed out waiting for TraeX turn in pane ${paneId}`);
  }

  private async json(args: string[], timeoutMs = this.commandTimeoutMs): Promise<unknown> {
    const { stdout } = await this.runner.run(this.executable, args, timeoutMs);
    const envelope = envelopeSchema.parse(JSON.parse(stdout));
    return envelope.result;
  }
}

function findPaneRecord(value: unknown): z.infer<typeof paneSchema> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const candidate of [record.pane, record.created_pane, value]) {
    const parsed = paneSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function findAgentState(value: unknown): AgentState | null {
  const valid = new Set<AgentState>(["idle", "working", "blocked", "done", "unknown"]);
  const visit = (candidate: unknown): AgentState | null => {
    if (typeof candidate === "string" && valid.has(candidate as AgentState)) return candidate as AgentState;
    if (!candidate || typeof candidate !== "object") return null;
    const record = candidate as Record<string, unknown>;
    for (const key of ["agent_status", "status", "state"]) { const found = visit(record[key]); if (found) return found; }
    for (const nested of Object.values(record)) { const found = visit(nested); if (found) return found; }
    return null;
  };
  return visit(value);
}

function unwrapText(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const result = record.result as Record<string, unknown> | undefined;
      for (const candidate of [result?.text, result?.output, result?.content, record.text]) {
        if (typeof candidate === "string") return candidate;
      }
    }
  } catch { /* text output is expected on some Herdr versions */ }
  return trimmed;
}

function isTraexWorking(output: string): boolean {
  return /[✧◆]\s*Work(?:ing|i…)/u.test(output);
}
