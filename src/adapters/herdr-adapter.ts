import { z } from "zod";
import type { HerdrPort } from "../domain/ports.js";
import type { AgentState, HerdrPane } from "../domain/types.js";
import type { CommandRunner } from "../infra/command-runner.js";
import { stripTerminalControl } from "../runtime/output.js";

const envelopeSchema = z.object({ id: z.string(), result: z.unknown() });
const paneSchema = z.object({
  pane_id: z.string(), workspace_id: z.string(), tab_id: z.string().nullish(), cwd: z.string().nullish(), label: z.string().nullish(), terminal_id: z.string().nullish(),
  agent_status: z.enum(["idle", "working", "blocked", "done", "unknown"]).default("unknown")
}).passthrough();
const processSchema = z.object({
  foreground_processes: z.array(z.object({ name: z.string().optional(), argv: z.array(z.string()).optional() }).passthrough()).default([])
}).passthrough();
const snapshotPaneSchema = paneSchema.extend({
  agent: z.string().nullish(),
  revision: z.number().int().nullish(),
  state_change_seq: z.number().int().nullish()
});
const snapshotSchema = z.object({
  snapshot: z.object({ panes: z.array(snapshotPaneSchema), agents: z.array(snapshotPaneSchema).default([]) }).passthrough()
});

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
    try {
      return (await this.listAllPanes()).filter((pane) => pane.workspaceId === workspaceId);
    } catch {
      const result = await this.json(["pane", "list", "--workspace", workspaceId]);
      const panes = z.object({ panes: z.array(paneSchema) }).parse(result).panes;
      return Promise.all(panes.map((pane) => this.enrichPane(pane)));
    }
  }

  async listAllPanes(): Promise<HerdrPane[]> {
    const result = snapshotSchema.parse(await this.json(["api", "snapshot"])).snapshot;
    const agents = new Map(result.agents.map((agent) => [agent.pane_id, agent]));
    return result.panes.map((pane) => this.fromSnapshot(pane, agents.get(pane.pane_id)));
  }

  async getPane(paneId: string): Promise<HerdrPane | null> {
    try {
      try { return (await this.listAllPanes()).find((pane) => pane.paneId === paneId) ?? null; }
      catch { /* Compatibility fallback for older Herdr snapshots. */ }
      const result = await this.json(["pane", "get", paneId]);
      return this.enrichPane(z.object({ pane: paneSchema }).parse(result).pane);
    } catch (error) {
      if (String(error).includes("not found")) return null;
      throw error;
    }
  }

  async createPane(workspaceId: string, cwd: string, options?: { bindingId: string; generation: number; projectId: string; title?: string; placement?: "split" | "dedicated-tab" }): Promise<HerdrPane> {
    const identityArgs = options ? [
      "--env", `HERDR_BRIDGE_BINDING_ID=${options.bindingId}`, "--env", `HERDR_BRIDGE_GENERATION=${options.generation}`, "--env", `HERDR_PROJECT_ID=${options.projectId}`
    ] : [];
    if (options?.placement === "dedicated-tab") {
      if (!options.title) throw new Error("Cannot create a dedicated Herdr tab without a title");
      const result = await this.json([
        "tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", `lark_${options.title}`,
        ...identityArgs, "--no-focus"
      ]);
      const candidate = findPaneRecord(result);
      if (!candidate) throw new Error("Herdr tab create response did not contain a root pane");
      return this.enrichPane(candidate);
    }
    const panes = await this.listPanes(workspaceId);
    const anchor = panes[0];
    if (!anchor) throw new Error(`Cannot create pane: workspace ${workspaceId} has no anchor pane`);
    const result = await this.json([
      "pane", "split", "--pane", anchor.paneId, "--direction", "right", "--ratio", "0.5",
      "--cwd", cwd, ...identityArgs, "--no-focus"
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
    onObservation?: (observation: { state: AgentState; output: string }) => void | Promise<void>,
    signal?: AbortSignal
  ): Promise<AgentState> {
    throwIfAborted(signal);
    const before = await this.readOutput(paneId, 240);
    await this.runner.run(this.executable, ["agent", "prompt", paneId, text], this.commandTimeoutMs);
    return this.waitForTraexTurn(paneId, before, timeoutMs, onObservation, signal);
  }

  async steerPrompt(paneId: string, text: string): Promise<"injected" | "not_working"> {
    const pane = await this.getPane(paneId);
    if (!pane || pane.agentState !== "working") return "not_working";
    const before = await this.readOutput(paneId, 240);
    await this.submitPromptText(paneId, text, before);
    return "injected";
  }

  async runPaneCommand(paneId: string, command: string, timeoutMs: number): Promise<string> {
    const before = await this.readOutput(paneId, 240);
    await this.submitPromptText(paneId, command, before);
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stablePolls = 0;
    while (Date.now() < deadline) {
      const after = await this.readOutput(paneId, 240);
      const output = paneCommandOutput(before, after, command);
      if (output && output === previous) {
        stablePolls += 1;
        if (stablePolls >= 1) return output;
      } else {
        previous = output;
        stablePolls = 0;
      }
      await abortableDelay(50);
    }
    throw new Error(`Timed out waiting for Pane command output in ${paneId}`);
  }

  async readOutput(paneId: string, lines: number): Promise<string> {
    const { stdout } = await this.runner.run(this.executable, [
      "pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines), "--format", "text"
    ], this.commandTimeoutMs);
    return unwrapText(stdout);
  }

  async renamePane(paneId: string, title: string, options?: { tabTitle?: string }): Promise<void> {
    await this.runner.run(this.executable, ["pane", "rename", paneId, title], this.commandTimeoutMs);
    if (!options?.tabTitle) return;
    const result = await this.json(["pane", "get", paneId]);
    const pane = z.object({ pane: paneSchema }).parse(result).pane;
    if (!pane.tab_id) throw new Error(`Herdr pane ${paneId} did not report its containing tab`);
    await this.runner.run(this.executable, ["tab", "rename", pane.tab_id, options.tabTitle], this.commandTimeoutMs);
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
      paneId: raw.pane_id, terminalId: raw.terminal_id ?? null, workspaceId: raw.workspace_id, cwd: raw.cwd ?? null, label: raw.label ?? null,
      agentState: raw.agent_status, foregroundExecutables: [...new Set(foregroundExecutables)]
    };
  }

  private fromSnapshot(raw: z.infer<typeof snapshotPaneSchema>, agent?: z.infer<typeof snapshotPaneSchema>): HerdrPane {
    const kind = agent?.agent ?? raw.agent ?? null;
    return {
      paneId: raw.pane_id, terminalId: raw.terminal_id ?? null, workspaceId: raw.workspace_id, cwd: raw.cwd ?? null, label: raw.label ?? null,
      agentKind: kind, stateChangeSeq: agent?.state_change_seq ?? raw.state_change_seq ?? null,
      agentState: agent?.agent_status ?? raw.agent_status, foregroundExecutables: kind ? [kind] : []
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

  private async submitPromptText(paneId: string, text: string, before: string, signal?: AbortSignal): Promise<void> {
    const comparableText = normalizePromptEcho(text);
    const previousOccurrences = countOccurrences(normalizePromptEcho(before), comparableText);
    await this.runner.run(this.executable, ["pane", "send-text", paneId, text], this.commandTimeoutMs);
    const deadline = Date.now() + this.commandTimeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const output = await this.readOutput(paneId, 240);
      if (countOccurrences(normalizePromptEcho(output), comparableText) > previousOccurrences) {
        await this.runner.run(this.executable, ["pane", "send-keys", paneId, "Enter"], this.commandTimeoutMs);
        return;
      }
      await abortableDelay(25, signal);
    }
    throw new Error(`Timed out waiting for prompt text in pane ${paneId}`);
  }

  private async waitForTraexTurn(
    paneId: string,
    before: string,
    timeoutMs: number,
    onObservation?: (observation: { state: AgentState; output: string }) => void | Promise<void>,
    signal?: AbortSignal
  ): Promise<AgentState> {
    const deadline = Date.now() + timeoutMs;
    let observedWorking = false;
    let lastAgentState: AgentState = "unknown";
    let lastOutput = before;
    let stableIdlePolls = 0;

    while (Date.now() < deadline) {
      throwIfAborted(signal);
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
      await abortableDelay(250, signal);
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
  for (const candidate of [record.root_pane, record.pane, record.created_pane, value]) {
    const parsed = paneSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
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

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function normalizePromptEcho(value: string): string {
  return value.replace(/[▍\s]+/gu, "");
}

function paneCommandOutput(before: string, after: string, command: string): string {
  const cleanBefore = stripTerminalControl(before).replace(/\r/g, "").trimEnd();
  const cleanAfter = stripTerminalControl(after).replace(/\r/g, "").trimEnd();
  const suffix = cleanAfter.startsWith(cleanBefore) ? cleanAfter.slice(cleanBefore.length) : cleanAfter;
  return redactTerminalSecrets(suffix.split("\n")
    .map((line) => line.replace(/^\s*[❯›>]\s*/, ""))
    .filter((line) => normalizePromptEcho(line) !== normalizePromptEcho(command))
    .join("\n").trim());
}

function redactTerminalSecrets(value: string): string {
  return value
    .replace(/((?:proxy-)?authorization\s*[:=]\s*(?:bearer\s+)?)([^\s'";,}]+)/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)([a-z0-9._~+\/-]+)/gi, "$1[REDACTED]")
    .replace(/((?:access[_-]?token|api[_-]?key|token|secret|password)\s*[=:]\s*["']?)([^\s"'&,;}]+)/gi, "$1[REDACTED]")
    .replace(/([?&](?:access_token|api_key|token|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Bridge shutdown interrupted prompt wait; resend the Lark message to retry");
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Bridge shutdown interrupted prompt wait; resend the Lark message to retry"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
