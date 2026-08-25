import { z } from "zod";
import type { HerdrPort } from "../domain/ports.js";
import type { AgentState, HerdrPane, HerdrPaneCreationOptions, RuntimeObservation, RuntimeTurnObservation } from "../domain/types.js";
import type { CommandRunner } from "../infra/command-runner.js";
import { stripTerminalControl } from "../runtime/output.js";
import { inferTraexAgentState, isTraexComposerReady } from "../runtime/traex-output-parser.js";

const envelopeSchema = z.object({ id: z.string(), result: z.unknown() });
const paneSchema = z.object({
  pane_id: z.string(), tab_id: z.string().nullish(), workspace_id: z.string(), cwd: z.string().nullish(), foreground_cwd: z.string().nullish(), label: z.string().nullish(), terminal_id: z.string().nullish(),
  agent_status: z.enum(["idle", "working", "blocked", "done", "unknown"]).optional()
}).passthrough();
const tabSchema = z.object({ tab_id: z.string(), label: z.string() }).passthrough();
const processSchema = z.object({
  foreground_processes: z.array(z.object({ name: z.string().optional(), argv: z.array(z.string()).optional() }).passthrough()).default([])
}).passthrough();
const nativeProcessInfoSchema = z.object({ process_info: processSchema }).passthrough();
const agentSessionSchema = z.object({
  source: z.string(), agent: z.string(), kind: z.enum(["id", "path"]), value: z.string()
});
const snapshotPaneSchema = paneSchema.extend({
  agent: z.string().nullish(),
  agent_session: agentSessionSchema.nullish(),
  revision: z.number().int().nullish(),
  state_change_seq: z.number().int().nullish()
});
const snapshotSchema = z.object({
  snapshot: z.object({ panes: z.array(snapshotPaneSchema), agents: z.array(snapshotPaneSchema).default([]) }).passthrough()
});
const nativeReadSchema = z.object({ read: z.object({ text: z.string() }).passthrough() }).passthrough();

interface HerdrNativeRequestClient {
  request(method: string, params: object, timeoutMs: number): Promise<unknown>;
  waitForPaneEvent?(paneId: string, timeoutMs: number): Promise<boolean>;
}

export class HerdrCliAdapter implements HerdrPort {
  constructor(
    private readonly runner: CommandRunner,
    private readonly executable: string,
    private readonly commandTimeoutMs: number,
    private readonly traexPermissionMode = "auto",
    private readonly native?: HerdrNativeRequestClient
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
    let parsed: z.infer<typeof snapshotSchema>;
    if (this.native) {
      try { parsed = snapshotSchema.parse(await this.native.request("session.snapshot", {}, this.commandTimeoutMs)); }
      catch { parsed = snapshotSchema.parse(await this.json(["api", "snapshot"])); }
    } else parsed = snapshotSchema.parse(await this.json(["api", "snapshot"]));
    const result = parsed.snapshot;
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

  async observeRuntime(paneId: string): Promise<RuntimeObservation> {
    const pane = await this.getPane(paneId);
    if (!pane) return { pane: null, traexProcess: false, composerReady: false, evidenceSource: "none" };
    const nativeTraex = pane.agentKind === "traex" || pane.agentKind === "codex";
    const foregroundExecutables = nativeTraex ? pane.foregroundExecutables : await this.foregroundExecutables(paneId);
    const traexProcess = nativeTraex || foregroundExecutables.includes("traex");
    const observed = { ...pane, foregroundExecutables };
    if (!traexProcess) return { pane: { ...observed, agentState: "unknown" }, traexProcess, composerReady: false, evidenceSource: "process" };
    if (pane.agentState !== "unknown") return { pane: observed, traexProcess, composerReady: pane.agentState === "idle", evidenceSource: "structured" };
    try {
      const recentState = inferTraexAgentState(await this.readOutput(paneId, 80));
      if (recentState !== "unknown") return this.runtimeObservation(observed, recentState, "recent");
      const visibleState = inferTraexAgentState(await this.readOutputSource(paneId, 80, "visible"));
      return this.runtimeObservation(observed, visibleState, visibleState === "unknown" ? "process" : "visible");
    } catch {
      return { pane: observed, traexProcess, composerReady: false, evidenceSource: "process" };
    }
  }

  async waitForRuntimeChange(paneId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await this.waitForPaneChange(paneId, timeoutMs, signal);
  }

  async createPane(workspaceId: string, cwd: string, options?: HerdrPaneCreationOptions): Promise<HerdrPane> {
    const identityArgs = options ? [
      "--env", `HERDR_BRIDGE_BINDING_ID=${options.bindingId}`, "--env", `HERDR_BRIDGE_GENERATION=${options.generation}`, "--env", `HERDR_PROJECT_ID=${options.projectId}`
    ] : [];
    if (options?.placement === "dedicated-tab") {
      const result = await this.json([
        "tab", "create", "--workspace", workspaceId, "--cwd", cwd,
        "--label", larkTabTitle(options.title), ...identityArgs, "--no-focus"
      ]);
      const candidate = findPaneRecord(result);
      if (!candidate) throw new Error("Herdr tab create response did not contain a root pane");
      if (options.title) {
        await this.runner.run(this.executable, ["pane", "rename", candidate.pane_id, normalizePaneTitle(options.title)], this.commandTimeoutMs);
      }
      return this.enrichPane(candidate);
    }
    const panes = await this.listPanes(workspaceId);
    const anchor = panes[0];
    if (!anchor) throw new Error(`Cannot create pane: workspace ${workspaceId} has no anchor pane`);
    const result = await this.json([
      "pane", "split", "--pane", anchor.paneId, "--direction", "down", "--ratio", "0.5",
      "--cwd", cwd, ...identityArgs, "--no-focus"
    ]);
    const candidate = findPaneRecord(result);
    if (!candidate) throw new Error("Herdr pane split response did not contain a pane");
    return this.enrichPane(candidate);
  }

  async startTraex(paneId: string, executable: string): Promise<void> {
    const initial = await this.observeRuntime(paneId);
    if (initial.composerReady) return;
    if (!initial.traexProcess) {
      await this.runner.run(this.executable, ["pane", "run", paneId, executable, "--permission-mode", this.traexPermissionMode], this.commandTimeoutMs);
    }
    await this.waitUntilTraexComposer(paneId);
  }

  async runPrompt(
    paneId: string,
    text: string,
    timeoutMs: number,
    onObservation?: (observation: RuntimeTurnObservation) => void | Promise<void>,
    signal?: AbortSignal,
    onDispatched?: () => void | Promise<void>
  ): Promise<AgentState> {
    throwIfAborted(signal);
    const before = await this.readOutput(paneId, 240);
    try {
      await this.runner.run(this.executable, ["agent", "prompt", paneId, text], this.commandTimeoutMs);
      await onDispatched?.();
    } catch (error) {
      if (isPossiblyDispatchedAgentPromptError(error)) await onDispatched?.();
      if (!isUnsupportedAgentPromptError(error)) throw error;
      await this.submitPromptText(paneId, text, before, signal, onDispatched);
    }
    return this.waitForTraexTurn(paneId, before, timeoutMs, onObservation, signal);
  }

  async steerPrompt(paneId: string, text: string): Promise<"injected" | "not_working"> {
    const pane = await this.getPane(paneId);
    if (!pane || (pane.agentState !== "working" && pane.agentState !== "blocked")) return "not_working";
    const before = await this.readOutput(paneId, 240);
    await this.submitPromptText(paneId, text, before);
    return "injected";
  }

  async sendEscape(paneId: string): Promise<void> {
    await this.runner.run(this.executable, ["pane", "send-keys", paneId, "Esc"], this.commandTimeoutMs);
  }

  async runPaneCommand(paneId: string, command: string, timeoutMs: number): Promise<string> {
    const before = await this.readOutput(paneId, 240);
    await this.submitPromptText(paneId, command, before);
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stablePolls = 0;
    while (Date.now() < deadline) {
      const after = await this.readOutput(paneId, 240);
      const selector = interactiveModelSelectorOutput(command, after);
      if (selector) {
        await this.runner.run(this.executable, ["pane", "send-keys", paneId, "Esc"], this.commandTimeoutMs);
        return selector;
      }
      const output = paneCommandOutput(before, after, command);
      if (output && output === previous) {
        stablePolls += 1;
        if (stablePolls >= 1) {
          return output;
        }
      } else {
        previous = output;
        stablePolls = 0;
      }
      await abortableDelay(50);
    }
    throw new Error(`Timed out waiting for Pane command output in ${paneId}`);
  }

  async beginPaneModelSelection(paneId: string, model: string, timeoutMs: number): Promise<{ kind: "mode_required"; modes: string[] } | { kind: "composer_ready" }> {
    const before = await this.readOutput(paneId, 240);
    await this.clearComposerInput(paneId);
    await this.submitPromptText(paneId, "/model", before);
    const deadline = Date.now() + timeoutMs;
    await this.waitForOutputMarker(paneId, "Select Model and Effort", deadline);
    while (Date.now() < deadline) {
      const output = await this.readOutput(paneId, 240);
      if (/Select Model and Effort/i.test(output) && /esc to go back/i.test(output)) {
        await this.clearComposerInput(paneId);
        await this.runner.run(this.executable, ["pane", "send-text", paneId, model], this.commandTimeoutMs);
        await this.runner.run(this.executable, ["pane", "send-keys", paneId, "Enter"], this.commandTimeoutMs);
        await this.waitForOutputMarker(paneId, "Select Model and Mode", deadline);
        while (Date.now() < deadline) {
          const selected = await this.readOutput(paneId, 240);
          const modes = interactiveModelModes(selected);
          if (modes) return { kind: "mode_required", modes };
          if (isTraexComposerReady(selected)) return { kind: "composer_ready" };
          await abortableDelay(50);
        }
        throw new Error(`Timed out waiting for TraeX model selection in pane ${paneId}`);
      }
      await abortableDelay(50);
    }
    throw new Error(`Timed out waiting for TraeX model selector in pane ${paneId}`);
  }

  async completePaneModelMode(paneId: string, mode: string, timeoutMs: number): Promise<void> {
    const before = await this.readOutput(paneId, 240);
    if (!interactiveModelModes(before)?.includes(mode)) throw new Error(`TraeX mode selector is no longer active in pane ${paneId}`);
    await this.clearComposerInput(paneId);
    await this.runner.run(this.executable, ["pane", "send-text", paneId, mode], this.commandTimeoutMs);
    await this.runner.run(this.executable, ["pane", "send-keys", paneId, "Enter"], this.commandTimeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isTraexComposerReady(await this.readOutput(paneId, 240))) return;
      await abortableDelay(50);
    }
    throw new Error(`Timed out waiting for TraeX mode selection in pane ${paneId}`);
  }

  async readOutput(paneId: string, lines: number): Promise<string> {
    return this.readOutputSource(paneId, lines, "recent-unwrapped");
  }

  private async readOutputSource(paneId: string, lines: number, source: "visible" | "recent-unwrapped"): Promise<string> {
    if (this.native) {
      try {
        const result = nativeReadSchema.parse(await this.native.request("agent.read", {
          target: paneId, source: source === "recent-unwrapped" ? "recent_unwrapped" : source, lines, format: "text", strip_ansi: true
        }, this.commandTimeoutMs));
        return result.read.text;
      } catch { /* Read-only native failure falls back to the Pane CLI. */ }
    }
    const { stdout } = await this.runner.run(this.executable, [
      "pane", "read", paneId, "--source", source, "--lines", String(lines), "--format", "text"
    ], this.commandTimeoutMs);
    return unwrapText(stdout);
  }

  private async waitForOutputMarker(paneId: string, marker: string, deadline: number): Promise<void> {
    if (!this.native) return;
    const timeoutMs = Math.max(1, Math.min(500, deadline - Date.now()));
    try {
      await this.native.request("pane.wait_for_output", {
        pane_id: paneId, source: "recent_unwrapped", lines: 240, strip_ansi: true,
        match: { type: "substring", value: marker }, timeout_ms: timeoutMs
      }, timeoutMs);
    } catch { /* The bounded polling loop remains the compatibility fallback. */ }
  }

  async renamePane(paneId: string, title: string, options?: { tabTitle?: string }): Promise<void> {
    const pane = options?.tabTitle ? await this.getPane(paneId) : null;
    await this.runner.run(this.executable, ["pane", "rename", paneId, title], this.commandTimeoutMs);
    if (options?.tabTitle) {
      if (!pane?.tabId) throw new Error(`Cannot rename Herdr tab: pane ${paneId} has no tab id`);
      const result = await this.json(["tab", "get", pane.tabId]);
      const tab = z.object({ tab: tabSchema }).parse(result).tab;
      if (tab.label.startsWith("lark_")) {
        await this.runner.run(this.executable, ["tab", "rename", pane.tabId, larkTabTitle(options.tabTitle)], this.commandTimeoutMs);
      }
    }
  }

  async closePane(paneId: string): Promise<void> {
    let closeError: unknown;
    try {
      await this.runner.run(this.executable, ["pane", "close", paneId], this.commandTimeoutMs);
    } catch (error) {
      closeError = error;
    }
    const deadline = Date.now() + this.commandTimeoutMs;
    while (Date.now() < deadline) {
      if (!await this.getPane(paneId)) return;
      await abortableDelay(100);
    }
    if (closeError) throw closeError;
    throw new Error(`Herdr pane ${paneId} remained present after close`);
  }

  private async enrichPane(raw: z.infer<typeof paneSchema>): Promise<HerdrPane> {
    const foregroundExecutables = await this.foregroundExecutables(raw.pane_id);
    return {
      paneId: raw.pane_id, tabId: raw.tab_id ?? null, terminalId: raw.terminal_id ?? null, workspaceId: raw.workspace_id, cwd: raw.cwd ?? null,
      ...(raw.foreground_cwd !== null && raw.foreground_cwd !== undefined ? { foregroundCwd: raw.foreground_cwd } : {}), label: raw.label ?? null,
      agentState: raw.agent_status ?? "unknown", foregroundExecutables: [...new Set(foregroundExecutables)]
    };
  }

  private async foregroundExecutables(paneId: string): Promise<string[]> {
    try {
      let value: unknown;
      if (this.native) {
        try { value = await this.native.request("pane.process_info", { pane_id: paneId }, this.commandTimeoutMs); }
        catch { value = await this.json(["pane", "process-info", "--pane", paneId]); }
      } else value = await this.json(["pane", "process-info", "--pane", paneId]);
      const processInfo = nativeProcessInfoSchema.parse(value).process_info;
      return [...new Set(processInfo.foreground_processes.flatMap((process) => {
        const values = [process.name, process.argv?.[0]].filter((value): value is string => Boolean(value));
        return values.map((value) => value.split("/").at(-1) ?? value);
      }))];
    } catch {
      return [];
    }
  }

  private fromSnapshot(raw: z.infer<typeof snapshotPaneSchema>, agent?: z.infer<typeof snapshotPaneSchema>): HerdrPane {
    const kind = agent?.agent ?? raw.agent ?? null;
    const foregroundCwd = raw.foreground_cwd ?? agent?.foreground_cwd ?? null;
    const foregroundExecutables = kind === "codex" || kind === "traex" ? ["traex"] : kind ? [kind] : [];
    return {
      paneId: raw.pane_id, tabId: raw.tab_id ?? null, terminalId: raw.terminal_id ?? null, workspaceId: raw.workspace_id, cwd: raw.cwd ?? null,
      ...(foregroundCwd ? { foregroundCwd } : {}), label: raw.label ?? null,
      agentKind: kind, agentSession: agent?.agent_session ?? raw.agent_session ?? null, outputRevision: raw.revision ?? agent?.revision ?? null, stateChangeSeq: agent?.state_change_seq ?? raw.state_change_seq ?? null,
      agentState: agent?.agent_status ?? raw.agent_status ?? "unknown", foregroundExecutables
    };
  }

  private async waitUntilTraexComposer(paneId: string): Promise<void> {
    const deadline = Date.now() + this.commandTimeoutMs;
    while (Date.now() < deadline) {
      if ((await this.observeRuntime(paneId)).composerReady) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`TraeX composer did not become ready in pane ${paneId}`);
  }

  private runtimeObservation(pane: HerdrPane, state: AgentState, evidenceSource: RuntimeObservation["evidenceSource"]): RuntimeObservation {
    return { pane: { ...pane, agentState: state }, traexProcess: true, composerReady: state === "idle", evidenceSource };
  }

  private async submitPromptText(paneId: string, text: string, before: string, signal?: AbortSignal, onDispatched?: () => void | Promise<void>): Promise<void> {
    const comparableText = normalizePromptEcho(text);
    const previousOccurrences = countOccurrences(normalizePromptEcho(before), comparableText);
    await this.runner.run(this.executable, ["pane", "send-text", paneId, text], this.commandTimeoutMs);
    const deadline = Date.now() + this.commandTimeoutMs;
    await this.waitForOutputMarker(paneId, text, Math.min(deadline, Date.now() + 250));
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const output = await this.readOutput(paneId, 240);
      if (countOccurrences(normalizePromptEcho(output), comparableText) > previousOccurrences) {
        await this.runner.run(this.executable, ["pane", "send-keys", paneId, "Enter"], this.commandTimeoutMs, onDispatched);
        return;
      }
      await abortableDelay(25, signal);
    }
    throw new Error(`Timed out waiting for prompt text in pane ${paneId}`);
  }

  private async clearComposerInput(paneId: string): Promise<void> {
    await this.runner.run(this.executable, ["pane", "send-keys", paneId, "ctrl+u"], this.commandTimeoutMs);
  }

  private async waitForTraexTurn(
    paneId: string,
    before: string,
    timeoutMs: number,
    onObservation?: (observation: RuntimeTurnObservation) => void | Promise<void>,
    signal?: AbortSignal
  ): Promise<AgentState> {
    const deadline = Date.now() + timeoutMs;
    let observedWorking = false;
    let lastAgentState: AgentState = "unknown";
    let lastOutput = before;
    let lastOutputRevision: number | null | undefined;
    let stableIdlePolls = 0;
    let outputChangedAfterSubmission = false;
    let outputStable = false;

    while (Date.now() < deadline) {
      throwIfAborted(signal);
      let agentState: AgentState = "unknown";
      let foregroundExecutables: string[] = [];
      let outputRead = false;
      try {
        const pane = await this.getPane(paneId);
        if (!pane) throw new Error(`Herdr pane not found: ${paneId}`);
        agentState = pane.agentState;
        foregroundExecutables = pane.foregroundExecutables;
        const revisionChanged = pane.outputRevision === null || pane.outputRevision === undefined || pane.outputRevision !== lastOutputRevision;
        if (agentState === "unknown" || revisionChanged) {
          const output = await this.readOutput(paneId, 240);
          outputRead = true;
          outputStable = output === lastOutput;
          if (output !== before) outputChangedAfterSubmission = true;
          if ((agentState !== "unknown" && agentState !== lastAgentState) || output !== lastOutput) {
            if (agentState !== "unknown") lastAgentState = agentState;
            await onObservation?.({ state: agentState, stateSource: agentState === "unknown" ? "unknown" : "structured", output });
          }
          lastOutput = output;
        } else if (agentState !== lastAgentState) {
          lastAgentState = agentState;
          await onObservation?.({ state: agentState, stateSource: "structured", output: lastOutput });
        }
        lastOutputRevision = pane.outputRevision;
      } catch (error) {
        if (String(error).includes("pane not found")) throw error;
      }
      if (!outputRead && agentState === "unknown") {
        const output = await this.readOutput(paneId, 240);
        outputStable = output === lastOutput;
        if (output !== before) outputChangedAfterSubmission = true;
        if (output !== lastOutput) await onObservation?.({ state: "unknown", stateSource: "unknown", output });
        lastOutput = output;
      }
      if (agentState === "working" || agentState === "blocked") observedWorking = true;
      if (observedWorking && (agentState === "done" || agentState === "idle")) return "done";
      const safelyIdle = agentState === "unknown" && outputChangedAfterSubmission && isTraexIdle(lastOutput) && !hasActiveTurnHelper(foregroundExecutables);
      if (safelyIdle) {
        stableIdlePolls = outputStable ? stableIdlePolls + 1 : 0;
        if (stableIdlePolls >= 2) return "done";
      } else if (agentState === "unknown" && isTraexWorking(lastOutput)) {
        observedWorking = true;
        if (lastAgentState !== "working") {
          lastAgentState = "working";
          await onObservation?.({ state: "working", stateSource: "terminal", output: lastOutput });
        }
        stableIdlePolls = 0;
      } else if (agentState === "unknown" && observedWorking) {
        stableIdlePolls = outputStable ? stableIdlePolls + 1 : 0;
        if (stableIdlePolls >= 1) return "done";
      } else {
        stableIdlePolls = 0;
      }
      await this.waitForPaneChange(paneId, 250, signal);
    }

    throw new Error(`Timed out waiting for TraeX turn in pane ${paneId}`);
  }

  private async waitForPaneChange(paneId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (!this.native?.waitForPaneEvent) { await abortableDelay(timeoutMs, signal); return; }
    throwIfAborted(signal);
    if (!signal) { await this.native.waitForPaneEvent(paneId, timeoutMs); return; }
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Bridge shutdown detached from an in-flight TraeX turn; the request will not be replayed"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try { await Promise.race([this.native.waitForPaneEvent(paneId, timeoutMs), aborted]); }
    finally { signal.removeEventListener("abort", onAbort); }
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

function isUnsupportedAgentPromptError(error: unknown): boolean {
  return /"code"\s*:\s*"agent_(?:not_ready|not_found)"/.test(error instanceof Error ? error.message : String(error));
}

function isPossiblyDispatchedAgentPromptError(error: unknown): boolean {
  return /"code"\s*:\s*"agent_prompt_stalled"/.test(error instanceof Error ? error.message : String(error));
}

function larkTabTitle(title: string | undefined): string {
  return `lark_${normalizePaneTitle(title)}`;
}

function normalizePaneTitle(title: string | undefined): string {
  return (title ?? "TraeX pane").replace(/\s+/g, " " ).trim() || "TraeX pane";
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

function isTraexIdle(output: string): boolean {
  const lines = stripTerminalControl(output).replace(/\r/g, "").split("\n");
  const composerIndex = lines.findLastIndex((line) => /^\s*[❯›>]\s*(?:[^<].*)?$/u.test(line));
  if (composerIndex < 0) return false;
  const tail = lines.slice(composerIndex + 1);
  if (/approve|approval|required|allow this|waiting for user|等待.*(?:批准|确认|用户)/iu.test(tail.join("\n"))) return false;
  return tail.every((line) => {
    const value = line.trim();
    return !value || /^[─━-]{3,}$/u.test(value) || /(?:Context|Mode|left|ctrl\+|shift\+tab|to cycle|Auto Mode)/iu.test(value);
  });
}

function hasActiveTurnHelper(executables: string[]): boolean {
  return executables.some((name) => !["traex", "bash", "sh", "zsh", "fish"].includes(name));
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
  const lines = cleanAfter.split("\n");
  const commandKey = normalizePromptEcho(command);
  let commandLine = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (normalizePromptEcho(lines[index]!.replace(/^\s*[❯›>]\s*/, "")) === commandKey) { commandLine = index; break; }
  }
  const suffix = commandLine >= 0
    ? lines.slice(commandLine + 1).join("\n")
    : cleanAfter.startsWith(cleanBefore) ? cleanAfter.slice(cleanBefore.length) : "";
  return redactTerminalSecrets(suffix.split("\n")
    .map((line) => line.replace(/^\s*[❯›>]\s*/, ""))
    .filter((line) => normalizePromptEcho(line) !== normalizePromptEcho(command))
    .join("\n").trim());
}

function isInteractiveModelSelector(command: string, output: string): boolean {
  return normalizePromptEcho(command) === normalizePromptEcho("/model") &&
    /Select Model and Effort/i.test(output) && /esc to go back/i.test(output);
}

function isInteractiveModelModeSelector(output: string): boolean {
  return /Select Model and Mode/i.test(output) && /esc to go back/i.test(output);
}

function interactiveModelModes(output: string): string[] | null {
  if (!isInteractiveModelModeSelector(output)) return null;
  const modes = output.split("\n")
    .map((line) => /^\s*(?:❯\s*)?\d+\.\s+.+?\/\s+(.+?)\s*$/u.exec(line)?.[1]?.trim() ?? null)
    .filter((mode): mode is string => mode !== null && mode.length > 0 && mode.length <= 128);
  const uniqueModes = [...new Set(modes)].slice(0, 100);
  return uniqueModes.length ? uniqueModes : null;
}

function interactiveModelSelectorOutput(command: string, output: string): string | null {
  if (normalizePromptEcho(command) !== normalizePromptEcho("/model")) return null;
  const clean = stripTerminalControl(output).replace(/\r/g, "");
  const start = clean.search(/Select Model and Effort/i);
  if (start < 0) return null;
  const selector = clean.slice(start).trim();
  return /esc to go back/i.test(selector) ? redactTerminalSecrets(selector) : null;
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
  if (signal?.aborted) throw new Error("Bridge shutdown detached from an in-flight TraeX turn; the request will not be replayed");
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Bridge shutdown detached from an in-flight TraeX turn; the request will not be replayed"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
