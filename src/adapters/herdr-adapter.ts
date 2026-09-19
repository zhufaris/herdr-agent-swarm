import { z } from "zod";
import { classifyPromptSubmissionFailure } from "../domain/prompt-submission.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { InterruptReceipt } from "../domain/agent-runtime.js";
import type { AgentState, HerdrPane, HerdrPaneCreationOptions, RuntimeObservation, RuntimeTurnObservation } from "../domain/types.js";
import type { CommandRunner } from "../infra/command-runner.js";
import type { HerdrAgentSession } from "../domain/types.js";
import { sameNativeTraexSession } from "../domain/traex-session-identity.js";
import { mapWithConcurrency } from "../runtime/map-with-concurrency.js";

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
  state_change_seq: z.number().int().nullish(),
  steering_capability: z.enum(["native", "terminal-input", "unsupported"]).optional(),
  active_turn_id: z.string().nullish()
});
const snapshotSchema = z.object({
  snapshot: z.object({ panes: z.array(snapshotPaneSchema), agents: z.array(snapshotPaneSchema).default([]) }).passthrough()
});
const PROCESS_INFO_CONCURRENCY = 4;

interface HerdrNativeRequestClient {
  request(method: string, params: object, timeoutMs: number): Promise<unknown>;
  waitForPaneEvent?(paneId: string, timeoutMs: number): Promise<boolean>;
}

export interface HerdrNativeCircuitOptions { nativeFailureThreshold?: number; nativeOpenMs?: number; now?: () => number }
export interface HerdrNativeTransportStatus { state: "closed" | "open" | "half-open"; consecutiveFailures: number; nextProbeAt: number | null }

export class HerdrCliAdapter implements HerdrPort {
  constructor(
    private readonly runner: CommandRunner,
    private readonly executable: string,
    private readonly commandTimeoutMs: number,
    private readonly traexPermissionMode = "auto",
    private readonly native?: HerdrNativeRequestClient,
    private readonly nativeCircuitOptions: HerdrNativeCircuitOptions = {}
  ) {}

  private nativeFailures = 0;
  private nativeOpenUntil = 0;
  private nativeProbeInFlight = false;

  nativeTransportStatus(): HerdrNativeTransportStatus {
    if (this.nativeOpenUntil === 0) return { state: "closed", consecutiveFailures: this.nativeFailures, nextProbeAt: null };
    const now = (this.nativeCircuitOptions.now ?? Date.now)();
    return { state: now >= this.nativeOpenUntil ? "half-open" : "open", consecutiveFailures: this.nativeFailures, nextProbeAt: this.nativeOpenUntil };
  }

  async assertWorkspace(workspaceId: string, expectedSpaceName?: string): Promise<void> {
    const result = await this.json(["workspace", "get", workspaceId]);
    const workspace = z.object({ workspace: z.object({ workspace_id: z.string(), label: z.string().nullish() }) }).parse(result);
    if (workspace.workspace.workspace_id !== workspaceId) throw new Error(`Herdr workspace mismatch: ${workspaceId}`);
    if (expectedSpaceName && workspace.workspace.label !== expectedSpaceName) {
      throw new Error(`Project Space mismatch: workspace ${workspaceId} is '${workspace.workspace.label ?? "unlabeled"}', expected '${expectedSpaceName}'`);
    }
  }

  async listPanes(workspaceId: string): Promise<HerdrPane[]> {
    try {
      return (await this.listAllPanes()).filter((pane) => pane.workspaceId === workspaceId);
    } catch {
      const result = await this.json(["pane", "list", "--workspace", workspaceId]);
      const panes = z.object({ panes: z.array(paneSchema) }).parse(result).panes;
      return mapWithConcurrency(panes, PROCESS_INFO_CONCURRENCY, (pane) => this.enrichPane(pane));
    }
  }

  async listAllPanes(): Promise<HerdrPane[]> {
    let parsed: z.infer<typeof snapshotSchema>;
    if (this.native) {
      try { parsed = snapshotSchema.parse(await this.nativeRequest("session.snapshot", {})); }
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
    const nativeTraex = pane.agentKind === "traex";
    const foregroundExecutables = nativeTraex ? pane.foregroundExecutables : await this.foregroundExecutables(paneId);
    return runtimeObservation(pane, foregroundExecutables);
  }

  async observeRuntimes(paneIds: readonly string[]): Promise<ReadonlyMap<string, RuntimeObservation>> {
    const requested = new Set(paneIds);
    const panes = (await this.listAllPanes()).filter((pane) => requested.has(pane.paneId));
    const observations = await mapWithConcurrency(panes, PROCESS_INFO_CONCURRENCY, async (pane) => {
      if (pane.agentKind === "traex") return runtimeObservation(pane, pane.foregroundExecutables);
      return runtimeObservation(pane, await this.foregroundExecutables(pane.paneId));
    });
    return new Map(observations.map((observation) => [observation.pane!.paneId, observation]));
  }

  async waitForRuntimeChange(paneId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await this.waitForPaneChange(paneId, timeoutMs, signal);
  }

  async createPane(workspaceId: string, cwd: string, options?: HerdrPaneCreationOptions): Promise<HerdrPane> {
    const identityArgs = options ? [
      "--env", `HERDR_BRIDGE_BINDING_ID=${options.bindingId}`, "--env", `HERDR_BRIDGE_GENERATION=${options.generation}`, "--env", `HERDR_PROJECT_ID=${options.projectId}`,
      ...Object.entries(options.environment ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`])
    ] : [];
    if (options?.placement === "dedicated-tab") {
      const result = await this.json([
        "tab", "create", "--workspace", workspaceId, "--cwd", cwd,
        "--label", paneCreationTitle(options), ...identityArgs, "--no-focus"
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

  async startTraex(paneId: string, executable: string, args: string[] = []): Promise<void> {
    const initial = await this.getPane(paneId);
    if (isReadyTraexAgent(initial)) return;
    const foregroundExecutables = initial?.foregroundExecutables.length
      ? initial.foregroundExecutables
      : await this.foregroundExecutables(paneId);
    if (!foregroundExecutables.includes("traex")) {
      await this.startAgent(paneId, { name: managedTraexName(paneId), kind: "traex", executable, args });
      return;
    }
    await this.waitUntilTraexAgentReady(paneId);
  }

  async startAgent(paneId: string, input: { name: string; kind: "pi" | "claude" | "codex" | "traex"; executable: string; args?: string[] }): Promise<void> {
    if (input.kind === "traex") {
      const args = [
        "agent", "start", input.name, "--kind", "traex", "--pane", paneId, "--timeout", String(this.commandTimeoutMs), "--",
        "--permission-mode", this.traexPermissionMode,
        ...(input.args ?? [])
      ];
      await this.startWhenShellReady(args);
    } else {
      const args = ["agent", "start", input.name, "--kind", input.kind, "--pane", paneId, "--timeout", String(this.commandTimeoutMs)];
      if (input.args?.length) args.push("--", ...input.args);
      await this.startWhenShellReady(args);
    }
    const pane = await this.getAgentPane(paneId) ?? await this.getPane(paneId);
    if (!pane || pane.agentKind !== input.kind || pane.agentState === "unknown") throw new Error(`Herdr did not verify ${input.kind} in pane ${paneId}`);
  }

  private async getAgentPane(paneId: string): Promise<HerdrPane | null> {
    try {
      const result = await this.json(["agent", "get", paneId]);
      const agent = z.object({ agent: snapshotPaneSchema }).parse(result).agent;
      return this.fromSnapshot(agent, agent);
    } catch { return null; }
  }

  private async startWhenShellReady(args: string[]): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await this.runner.run(this.executable, args, this.commandTimeoutMs); return; }
      catch (error) {
        lastError = error;
        const message = String(error);
        const shellNotReady = message.includes("agent_pane_busy")
          || (message.includes("agent_start_failed") && message.includes("is not an available shell"));
        if (!shellNotReady) throw error;
        await new Promise((resolve) => setTimeout(resolve, herdrRetryDelay(attempt)));
      }
    }
    throw lastError;
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
    let commandStarted = false;
    let dispatchReported = false;
    const reportDispatched = async (): Promise<void> => {
      if (dispatchReported) return;
      dispatchReported = true;
      await onDispatched?.();
    };
    try {
      const { stdout } = await this.runner.run(
        this.executable,
        ["agent", "prompt", paneId, text, "--wait", "--until", "working", "--until", "blocked", "--until", "done", "--timeout", String(this.commandTimeoutMs)],
        this.commandTimeoutMs * 2,
        () => { commandStarted = true; },
        signal
      );
      await reportDispatched();
      const accepted = promptResultState(stdout);
      await onObservation?.({ state: accepted === "blocked" ? "blocked" : "working", stateSource: "structured" });
      if (accepted === "blocked" || accepted === "done") return accepted;
      return this.waitForAgent(paneId, timeoutMs, onObservation, signal);
    } catch (error) {
      if (!isExplicitPreDispatchAgentPromptError(error) && (commandStarted || isPossiblyDispatchedAgentPromptError(error))) {
        await reportDispatched();
      }
      throw error;
    }
  }

  async waitForAgent(paneId: string, timeoutMs: number, onObservation?: (observation: RuntimeTurnObservation) => void | Promise<void>, signal?: AbortSignal): Promise<AgentState> {
    throwIfAborted(signal);
    await onObservation?.({ state: "working", stateSource: "structured" });
    const { stdout } = await this.runner.run(
      this.executable,
      ["agent", "wait", paneId, "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", String(timeoutMs)],
      timeoutMs + this.commandTimeoutMs,
      undefined,
      signal
    );
    const state = promptResultState(stdout) ?? (await this.getPane(paneId))?.agentState ?? "unknown";
    const settled = state === "idle" ? "done" : state;
    await onObservation?.({ state: settled, stateSource: settled === "unknown" ? "unknown" : "structured" });
    return settled;
  }

  async sendEscape(paneId: string): Promise<void> {
    await this.runner.run(this.executable, ["agent", "send-keys", paneId, "esc"], this.commandTimeoutMs);
  }


  async interruptAgent(input: { paneId: string; agentSession: HerdrAgentSession; runtimeTurnId: string; idempotencyKey: string }): Promise<InterruptReceipt> {
    void input.idempotencyKey;
    const pane = await this.getAgentPane(input.paneId);
    if (!pane) return { status: "not-active", reason: "Herdr Agent is no longer active" };
    if (!pane.agentSession || !sameNativeTraexSession(pane.agentSession, input.agentSession)) return { status: "not-active", reason: "Agent session identity changed" };
    if (pane.agentState === "blocked") return { status: "blocked", reason: "Agent is blocked on a local approval or question" };
    if (pane.agentState !== "working") return { status: "not-active", reason: "Agent turn is not active" };
    if (pane.activeTurnId !== input.runtimeTurnId) return { status: "not-active", reason: "Runtime turn identity changed" };
    await this.runner.run(this.executable, ["agent", "send-keys", input.paneId, "ctrl+c"], this.commandTimeoutMs);
    return { status: "interrupted" };
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
    if (this.native?.waitForPaneEvent) {
      const observed = await this.native.waitForPaneEvent(paneId, this.commandTimeoutMs).catch(() => false);
      if (observed && !await this.getPane(paneId)) return;
    }
    const deadline = Date.now() + this.commandTimeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      if (!await this.getPane(paneId)) return;
      await abortableDelay(Math.min(herdrRetryDelay(attempt++), Math.max(1, deadline - Date.now())));
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
        try { value = await this.nativeRequest("pane.process_info", { pane_id: paneId }); }
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

  private async nativeRequest(method: string, params: object): Promise<unknown> {
    if (!this.native) throw new Error("Herdr native transport is unavailable");
    const now = (this.nativeCircuitOptions.now ?? Date.now)();
    if (this.nativeOpenUntil > now || this.nativeProbeInFlight) throw new Error("Herdr native transport circuit is open");
    const probing = this.nativeOpenUntil > 0;
    if (probing) this.nativeProbeInFlight = true;
    try {
      const result = await this.native.request(method, params, this.commandTimeoutMs);
      this.nativeFailures = 0;
      this.nativeOpenUntil = 0;
      return result;
    } catch (error) {
      this.nativeFailures += 1;
      if (this.nativeFailures >= Math.max(1, this.nativeCircuitOptions.nativeFailureThreshold ?? 3)) {
        this.nativeOpenUntil = now + Math.max(1, this.nativeCircuitOptions.nativeOpenMs ?? 10_000);
      }
      throw error;
    } finally {
      if (probing) this.nativeProbeInFlight = false;
    }
  }

  private fromSnapshot(raw: z.infer<typeof snapshotPaneSchema>, agent?: z.infer<typeof snapshotPaneSchema>): HerdrPane {
    const kind = agent?.agent ?? raw.agent ?? null;
    const agentSession = agent?.agent_session ?? raw.agent_session ?? null;
    const foregroundCwd = raw.foreground_cwd ?? agent?.foreground_cwd ?? null;
    const foregroundExecutables = kind ? [kind] : [];
    return {
      paneId: raw.pane_id, tabId: raw.tab_id ?? null, terminalId: raw.terminal_id ?? null, workspaceId: raw.workspace_id, cwd: raw.cwd ?? null,
      ...(foregroundCwd ? { foregroundCwd } : {}), label: raw.label ?? null,
      agentKind: kind, agentSession, outputRevision: raw.revision ?? agent?.revision ?? null, stateChangeSeq: agent?.state_change_seq ?? raw.state_change_seq ?? null,
      steeringCapability: agent?.steering_capability ?? raw.steering_capability ?? "unsupported",
      activeTurnId: agent?.active_turn_id ?? raw.active_turn_id ?? null,
      agentState: agent?.agent_status ?? raw.agent_status ?? "unknown", foregroundExecutables
    };
  }

  private async waitUntilTraexAgentReady(paneId: string): Promise<void> {
    const deadline = Date.now() + this.commandTimeoutMs;
    while (Date.now() < deadline) {
      if (isReadyTraexAgent(await this.getPane(paneId))) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Herdr did not detect a ready native TraeX agent in pane ${paneId}`);
  }

  private async waitForPaneChange(paneId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (!this.native?.waitForPaneEvent) { await abortableDelay(timeoutMs, signal); return; }
    throwIfAborted(signal);
    const startedAt = Date.now();
    if (!signal) {
      const changed = await this.native.waitForPaneEvent(paneId, timeoutMs);
      if (!changed) await abortableDelay(Math.max(0, timeoutMs - (Date.now() - startedAt)));
      return;
    }
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Bridge shutdown detached from an in-flight TraeX turn; the request will not be replayed"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const changed = await Promise.race([this.native.waitForPaneEvent(paneId, timeoutMs), aborted]);
      if (!changed) await abortableDelay(Math.max(0, timeoutMs - (Date.now() - startedAt)), signal);
    }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  private async json(args: string[], timeoutMs = this.commandTimeoutMs): Promise<unknown> {
    const { stdout } = await this.runner.run(this.executable, args, timeoutMs);
    const envelope = envelopeSchema.parse(JSON.parse(stdout));
    return envelope.result;
  }
}

export function herdrRetryDelay(attempt: number): number { return Math.min(1_000, 100 * (2 ** Math.max(0, Math.floor(attempt)))); }

function managedTraexName(paneId: string): string {
  return `traex-${paneId.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}`.slice(0, 32);
}

function runtimeObservation(pane: HerdrPane, foregroundExecutables: readonly string[]): RuntimeObservation {
  const nativeTraex = pane.agentKind === "traex";
  const traexProcess = nativeTraex || foregroundExecutables.includes("traex");
  const observed = { ...pane, foregroundExecutables: [...foregroundExecutables] };
  if (!traexProcess) return { pane: { ...observed, agentState: "unknown" }, traexProcess, composerReady: false, evidenceSource: "process" };
  return { pane: observed, traexProcess, composerReady: pane.agentState === "idle" || pane.agentState === "done", evidenceSource: pane.agentState === "unknown" ? "process" : "structured" };
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

function isExplicitPreDispatchAgentPromptError(error: unknown): boolean {
  const outcome = classifyPromptSubmissionFailure(error);
  return outcome?.kind === "not_started" || outcome?.kind === "rejected";
}

function isPossiblyDispatchedAgentPromptError(error: unknown): boolean {
  return classifyPromptSubmissionFailure(error)?.kind === "uncertain";
}

function promptResultState(stdout: string): AgentState | null {
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    return findAgentState(value.result ?? value);
  } catch {
    return null;
  }
}

function findAgentState(value: unknown): AgentState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["agent_status", "state", "status"] as const) {
    const state = record[key];
    if (state === "idle" || state === "working" || state === "blocked" || state === "done" || state === "unknown") return state;
  }
  for (const key of ["agent", "wait", "prompt", "observation", "result"] as const) {
    const state = findAgentState(record[key]);
    if (state) return state;
  }
  return null;
}

function larkTabTitle(title: string | undefined): string {
  const normalized = normalizePaneTitle(title).replace(/^(?:lark_)+/i, "");
  return `lark_${normalized}`;
}

function paneCreationTitle(options: HerdrPaneCreationOptions): string {
  return options.titlePolicy === "complete" ? normalizePaneTitle(options.title) : larkTabTitle(options.title);
}

function normalizePaneTitle(title: string | undefined): string {
  return (title ?? "TraeX pane").replace(/\s+/g, " " ).trim() || "TraeX pane";
}

function isReadyTraexAgent(pane: HerdrPane | null): boolean {
  return Boolean(pane
    && pane.agentKind === "traex"
    && (pane.agentState === "idle" || pane.agentState === "done"));
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
