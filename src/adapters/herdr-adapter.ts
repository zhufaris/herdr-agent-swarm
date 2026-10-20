import { z } from "zod";
import { classifyPromptSubmissionFailure } from "../domain/prompt-submission.js";
import type { CoreMalformedResponse, CoreOperationRejected, CoreOperationUncertain, HerdrPort, HerdrWorkspace, NativePromptSubmissionReceipt, NativePromptSubmissionResult, PaneCreationV2Request, PaneCreationV2Result, PaneIdentity, PaneIdentityReconcileV1Request, PaneIdentityReconcileV1Result } from "../domain/ports/external.js";
import type { InterruptReceipt } from "../domain/agent-runtime.js";
import type { AgentState, HerdrActiveTurn, HerdrPane, HerdrPaneCreationOptions, RuntimeObservation, RuntimeTurnObservation } from "../domain/types.js";
import { CommandError, type CommandRunner } from "../infra/command-runner.js";
import type { HerdrAgentSession } from "../domain/types.js";
import { sameNativeTraexSession } from "../domain/traex-session-identity.js";
import { mapWithConcurrency } from "../runtime/map-with-concurrency.js";
import { normalizePaneToken } from "../domain/pane-display-identity.js";
import type { SessionRotationRequest, SessionRotationResult } from "../domain/orchestrator-clear.js";
import { paneIdentityLabels } from "../domain/pane-title.js";
import type { PaneTopologyLabelRequest, PaneTopologyMoveReceipt, PaneTopologyMoveRequest } from "../domain/pane-topology-intent.js";

const envelopeSchema = z.object({ id: z.string(), result: z.unknown() });
const workspaceListSchema = z.object({ workspaces: z.array(z.object({ workspace_id: z.string().min(1), label: z.string() }).passthrough()) });
const paneSchema = z.object({
  pane_id: z.string(), token: z.string().nullish(), tab_id: z.string().nullish(), workspace_id: z.string(), cwd: z.string().nullish(), foreground_cwd: z.string().nullish(), label: z.string().nullish(), terminal_id: z.string().nullish(),
  agent_status: z.enum(["idle", "working", "blocked", "done", "unknown"]).optional()
}).passthrough();
const tabSchema = z.object({ tab_id: z.string(), label: z.string() }).passthrough();
const processSchema = z.object({
  foreground_processes: z.array(z.object({ name: z.string().optional(), argv: z.array(z.string()).optional() }).passthrough()).default([])
}).passthrough();
const nativeProcessInfoSchema = z.object({ process_info: processSchema }).passthrough();
const paneMoveSchema = z.object({ move_result: z.object({ previous_pane_id: z.string(), pane: paneSchema }) });
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
  snapshot: z.object({ panes: z.array(snapshotPaneSchema), agents: z.array(snapshotPaneSchema).default([]), tabs: z.array(tabSchema).default([]) }).passthrough()
});
const agentTurnListSchema = z.object({
  turns: z.array(z.object({ turn_id: z.string().min(1), started_at: z.string().min(1), terminal_state: z.string().nullish() }).passthrough()).default([])
}).passthrough();
const rotationReceiptSchema = z.object({
  operation_id: z.string(), pane_id: z.string(), terminal_id: z.string(),
  old_session: agentSessionSchema, new_session: agentSessionSchema
});
const rotationResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("rotated"), receipt: rotationReceiptSchema }),
  z.object({ outcome: z.literal("already_applied"), receipt: rotationReceiptSchema }),
  z.object({ outcome: z.literal("fence_lost"), operation_id: z.string(), pane_id: z.string(), reason: z.string() }),
  z.object({ outcome: z.literal("unsupported_launch"), operation_id: z.string(), pane_id: z.string(), reason: z.string() }),
  z.object({ outcome: z.literal("definitely_not_started"), operation_id: z.string(), pane_id: z.string(), reason: z.string() }),
  z.object({ outcome: z.literal("uncertain"), operation_id: z.string(), pane_id: z.string(), reason: z.string() }),
  z.object({ outcome: z.literal("rotating"), operation_id: z.string(), pane_id: z.string() })
]);
const rotationEnvelopeSchema = z.object({ rotation: rotationResultSchema });
const paneCreationV2Schema = z.object({
  tab: z.object({ tab_id: z.string(), workspace_id: z.string() }).passthrough(),
  root_pane: z.object({
    pane_id: z.string(), terminal_id: z.string(), token: z.string(),
    tab_id: z.string(), workspace_id: z.string()
  }).passthrough()
}).passthrough();
const paneIdentitySchema = z.object({
  pane_id: z.string(), terminal_id: z.string(), workspace_id: z.string(), token: z.string()
});
const paneIdentityReconcileSchema = z.object({ receipt: z.object({
  operation_id: z.string(), disposition: z.enum(["applied", "already_converged"]),
  previous: paneIdentitySchema, current: paneIdentitySchema
}) });
const nativePromptReceiptSchema = z.object({
  submission_id: z.string().min(1).max(256), terminal_id: z.string().min(1).max(512),
  agent_kind: z.enum(["traex", "pi"]), session_id: z.string().min(1).max(512),
  state: z.enum(["prepared", "accepted", "rejected", "uncertain"]),
  created_at: z.number().int().nonnegative(), updated_at: z.number().int().nonnegative()
});
const nativePromptResultSchema = z.object({
  result: z.object({
    submission_id: z.string().min(1).max(256),
    submission_receipt: nativePromptReceiptSchema.optional()
  }).passthrough()
});
const PROCESS_INFO_CONCURRENCY = 4;

type ProcessProbe = { state: "observed"; executables: string[] } | { state: "unavailable"; executables: [] };

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
  private promptQueueCapability: Promise<boolean> | null = null;
  private modelPromptCapability: Promise<boolean> | null = null;
  private sessionRotationCapability: Promise<boolean> | null = null;
  private paneCreationV2Capability: Promise<boolean> | null = null;
  private paneIdentityReconcileV1Capability: Promise<boolean> | null = null;

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

  async listWorkspaces(): Promise<HerdrWorkspace[]> {
    const result = workspaceListSchema.parse(await this.json(["workspace", "list"]));
    return result.workspaces.map((workspace) => ({ workspaceId: workspace.workspace_id, label: workspace.label }));
  }

  async listPanes(workspaceId: string, options: { skipAllWorkspaceSnapshot?: boolean } = {}): Promise<HerdrPane[]> {
    if (!options.skipAllWorkspaceSnapshot) {
      try { return (await this.listAllPanes()).filter((pane) => pane.workspaceId === workspaceId); }
      catch { /* Compatibility fallback for unavailable all-workspace snapshots. */ }
    }
    const result = await this.json(["pane", "list", "--workspace", workspaceId]);
    const panes = z.object({ panes: z.array(paneSchema) }).parse(result).panes;
    return mapWithConcurrency(panes, PROCESS_INFO_CONCURRENCY, (pane) => this.enrichPane(pane));
  }

  async listAllPanes(): Promise<HerdrPane[]> {
    let parsed: z.infer<typeof snapshotSchema>;
    if (this.native) {
      try { parsed = snapshotSchema.parse(await this.nativeRequest("session.snapshot", {})); }
      catch { parsed = snapshotSchema.parse(await this.json(["api", "snapshot"])); }
    } else parsed = snapshotSchema.parse(await this.json(["api", "snapshot"]));
    const result = parsed.snapshot;
    const agents = new Map(result.agents.map((agent) => [agent.pane_id, agent]));
    const tabLabels = new Map(result.tabs.map((tab) => [tab.tab_id, tab.label]));
    return result.panes.map((pane) => this.fromSnapshot(pane, agents.get(pane.pane_id), pane.tab_id ? tabLabels.get(pane.tab_id) : null));
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

  async getActiveTurn(paneId: string): Promise<HerdrActiveTurn | null> {
    const pane = await this.getAgentPane(paneId) ?? await this.getPane(paneId);
    return pane ? this.activeTurnForPane(pane) : null;
  }

  private async activeTurnForPane(pane: HerdrPane): Promise<HerdrActiveTurn | null> {
    if (!pane.agentSession || pane.agentState !== "working") return null;
    if (pane.activeTurnId) return { turnId: pane.activeTurnId };
    if (pane.agentKind !== "traex" && pane.agentKind !== "pi") return null;
    const result = agentTurnListSchema.parse(await this.json([
      "agent", "events", "turns", "--kind", pane.agentKind, "--session-id", pane.agentSession.value, "--limit", "128"
    ]));
    const active = result.turns.filter((turn) => !turn.terminal_state).sort((left, right) => left.started_at.localeCompare(right.started_at)).at(-1);
    return active ? { turnId: active.turn_id, startedAt: active.started_at } : null;
  }

  async observeRuntime(paneId: string): Promise<RuntimeObservation> {
    const pane = await this.getPane(paneId);
    if (!pane) return { pane: null, traexProcess: false, composerReady: false, evidenceSource: "none" };
    const nativeTraex = pane.agentKind === "traex";
    const processProbe = nativeTraex ? { state: "observed", executables: pane.foregroundExecutables } as const : await this.foregroundExecutables(paneId);
    return runtimeObservation(pane, processProbe);
  }

  async observeRuntimes(paneIds: readonly string[]): Promise<ReadonlyMap<string, RuntimeObservation>> {
    const requested = new Set(paneIds);
    const panes = (await this.listAllPanes()).filter((pane) => requested.has(pane.paneId));
    const observations = await mapWithConcurrency(panes, PROCESS_INFO_CONCURRENCY, async (pane) => {
      if (pane.agentKind === "traex") return runtimeObservation(pane, { state: "observed", executables: pane.foregroundExecutables });
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
      const displayLabel = await this.applyCreatedPaneDisplayIdentity(candidate, options);
      if (!displayLabel && options.title) {
        await this.runner.run(this.executable, ["pane", "rename", candidate.pane_id, normalizePaneTitle(options.title)], this.commandTimeoutMs);
      }
      return this.enrichPane(displayLabel ? { ...candidate, label: displayLabel } : candidate);
    }
    const anchor = options?.anchorPaneId
      ? { paneId: options.anchorPaneId }
      : (await this.listPanes(workspaceId))[0];
    if (!anchor) throw new Error(`Cannot create pane: workspace ${workspaceId} has no anchor pane`);
    const result = await this.json([
      "pane", "split", "--pane", anchor.paneId, "--direction", "down", "--ratio", "0.5",
      "--cwd", cwd, ...identityArgs, "--no-focus"
    ]);
    const candidate = findPaneRecord(result);
    if (!candidate) throw new Error("Herdr pane split response did not contain a pane");
    const displayLabel = options ? await this.applyCreatedPaneDisplayIdentity(candidate, options) : null;
    return this.enrichPane(displayLabel ? { ...candidate, label: displayLabel } : candidate);
  }

  private async applyCreatedPaneDisplayIdentity(candidate: z.infer<typeof paneSchema>, options: HerdrPaneCreationOptions): Promise<string | null> {
    if (!options.displayIdentity) return null;
    const groupToken = options.displayIdentity.groupToken ?? normalizePaneToken(candidate.token);
    if (!groupToken) throw new Error(`Herdr pane ${candidate.pane_id} did not provide a valid Group Token`);
    if (!candidate.tab_id) throw new Error(`Herdr pane ${candidate.pane_id} did not provide a tab identity`);
    const identity = paneIdentityLabels(groupToken, options.displayIdentity.role);
    await this.runner.run(this.executable, ["pane", "rename", candidate.pane_id, identity.paneLabel], this.commandTimeoutMs);
    await this.runner.run(this.executable, ["tab", "rename", candidate.tab_id, identity.tabLabel], this.commandTimeoutMs);
    return identity.paneLabel;
  }

  async movePane(input: PaneTopologyMoveRequest): Promise<PaneTopologyMoveReceipt> {
    const moved = paneMoveSchema.parse(await this.json([
      "pane", "move", input.paneId,
      "--tab", input.targetTabId,
      "--target-pane", input.targetAnchorPaneId,
      "--split", "down", "--ratio", "0.5",
      "--label", input.paneLabel,
      "--tab-label", input.tabLabel,
      "--no-focus"
    ])).move_result;
    if (!moved.pane.tab_id) throw new Error("Herdr pane move receipt omitted the target tab identity");
    return Object.freeze({
      previousPaneId: moved.previous_pane_id,
      paneId: moved.pane.pane_id,
      paneToken: normalizePaneToken(moved.pane.token),
      tabId: moved.pane.tab_id,
      workspaceId: moved.pane.workspace_id
    });
  }

  async labelPane(input: PaneTopologyLabelRequest): Promise<PaneTopologyMoveReceipt> {
    await this.runner.run(this.executable, ["pane", "rename", input.paneId, input.paneLabel], this.commandTimeoutMs);
    await this.runner.run(this.executable, ["tab", "rename", input.tabId, input.tabLabel], this.commandTimeoutMs);
    return Object.freeze({ previousPaneId: input.paneId, paneId: input.paneId, paneToken: input.paneToken ?? null, tabId: input.tabId, workspaceId: input.workspaceId });
  }

  async supportsPaneCreationV2(): Promise<boolean> {
    if (!this.paneCreationV2Capability) {
      this.paneCreationV2Capability = this.runner.run(this.executable, ["tab", "create", "--help"], this.commandTimeoutMs)
        .then(({ stdout, stderr }) => {
          const help = `${stdout}\n${stderr}`;
          return help.includes("--expected-workspace-label") && help.includes("--token");
        })
        .catch(() => false);
    }
    const probe = this.paneCreationV2Capability;
    const supported = await probe;
    if (!supported && this.paneCreationV2Capability === probe) this.paneCreationV2Capability = null;
    return supported;
  }

  async createPaneV2(input: PaneCreationV2Request): Promise<PaneCreationV2Result> {
    if (!await this.supportsPaneCreationV2()) return {
      outcome: "capability-unavailable",
      capability: "tab.create.v2",
      reason: "Herdr Core does not advertise tab.create.v2"
    };
    const identityArgs = [
      "--env", `HERDR_BRIDGE_BINDING_ID=${input.options.bindingId}`,
      "--env", `HERDR_BRIDGE_GENERATION=${input.options.generation}`,
      "--env", `HERDR_PROJECT_ID=${input.options.projectId}`,
      ...Object.entries(input.options.environment ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`])
    ];
    let parsed: z.infer<typeof paneCreationV2Schema>;
    try {
      parsed = paneCreationV2Schema.parse(await this.json([
        "tab", "create", "--workspace", input.workspaceId,
        "--expected-workspace-label", input.expectedWorkspaceLabel,
        "--token", input.token, "--cwd", input.cwd,
        "--label", paneCreationTitle(input.options), ...identityArgs, "--no-focus"
      ]));
    } catch (error) {
      const failure = normalizeCoreOperationFailure(error, "tab.create.v2");
      if (failure) return failure;
      throw error;
    }
    await this.applyCreatedPaneDisplayIdentity(parsed.root_pane, input.options);
    return { outcome: "created", receipt: {
      workspaceId: parsed.root_pane.workspace_id,
      tabId: parsed.root_pane.tab_id,
      paneId: parsed.root_pane.pane_id,
      terminalId: parsed.root_pane.terminal_id,
      token: parsed.root_pane.token
    } };
  }

  async supportsPaneIdentityReconcileV1(): Promise<boolean> {
    if (!this.paneIdentityReconcileV1Capability) {
      this.paneIdentityReconcileV1Capability = this.runner.run(this.executable, ["pane", "identity-reconcile", "--help"], this.commandTimeoutMs)
        .then(({ stdout, stderr }) => {
          const help = `${stdout}\n${stderr}`;
          return help.includes("--operation-id")
            && help.includes("--expected-pane")
            && help.includes("--expected-terminal")
            && help.includes("--expected-workspace")
            && help.includes("--expected-token")
            && help.includes("--target-workspace")
            && help.includes("--expected-workspace-label")
            && help.includes("--token");
        })
        .catch(() => false);
    }
    const probe = this.paneIdentityReconcileV1Capability;
    const supported = await probe;
    if (!supported && this.paneIdentityReconcileV1Capability === probe) this.paneIdentityReconcileV1Capability = null;
    return supported;
  }

  async reconcilePaneIdentityV1(input: PaneIdentityReconcileV1Request): Promise<PaneIdentityReconcileV1Result> {
    if (!await this.supportsPaneIdentityReconcileV1()) return {
      outcome: "capability-unavailable",
      capability: "pane.identity_reconcile.v1",
      reason: "Herdr Core does not advertise pane.identity_reconcile.v1"
    };
    let parsed: z.infer<typeof paneIdentityReconcileSchema>["receipt"];
    try {
      parsed = paneIdentityReconcileSchema.parse(await this.json([
        "pane", "identity-reconcile", "--operation-id", input.operationId,
        "--expected-pane", input.expected.paneId,
        "--expected-terminal", input.expected.terminalId,
        "--expected-workspace", input.expected.workspaceId,
        "--expected-token", input.expected.token,
        "--target-workspace", input.target.workspaceId,
        "--expected-workspace-label", input.target.expectedWorkspaceLabel,
        "--token", input.target.token
      ])).receipt;
    } catch (error) {
      const failure = normalizeCoreOperationFailure(error, "pane.identity_reconcile.v1");
      if (failure) return failure;
      throw error;
    }
    const disposition = parsed.disposition === "already_converged" ? "already-converged" : "applied";
    return { outcome: disposition, receipt: {
      operationId: parsed.operation_id,
      disposition,
      previous: normalizePaneIdentity(parsed.previous),
      current: normalizePaneIdentity(parsed.current)
    } };
  }

  async startTraex(paneId: string, executable: string, args: string[] = []): Promise<void> {
    const initial = await this.getPane(paneId);
    if (isReadyTraexAgent(initial)) return;
    const processProbe = initial?.agentKind === "traex"
      ? { state: "observed", executables: initial.foregroundExecutables } as const
      : await this.foregroundExecutables(paneId);
    if (processProbe.state === "unavailable") throw new Error(`Herdr process probe is unavailable for pane ${paneId}; refusing to start TraeX`);
    if (!processProbe.executables.includes("traex")) {
      await this.startAgent(paneId, { name: managedTraexName(paneId), kind: "traex", executable, args });
      return;
    }
    await this.waitUntilTraexAgentReady(paneId);
  }

  async startAgent(paneId: string, input: { name: string; kind: "pi" | "claude" | "codex" | "traex"; executable: string; args?: string[]; useConfiguredPermissionMode?: boolean; rotatable?: boolean }): Promise<void> {
    if (input.kind === "traex") {
      const args = [
        "agent", "start", input.name, "--kind", "traex", "--pane", paneId, "--timeout", String(this.commandTimeoutMs),
        ...(input.rotatable ? ["--rotatable"] : []),
        "--",
        ...(input.useConfiguredPermissionMode === false ? [] : ["--permission-mode", this.traexPermissionMode]),
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

  async queuePrompt(
    paneId: string,
    text: string,
    input: { submissionId: string; expectedSessionId: string },
    signal?: AbortSignal
  ): Promise<NativePromptSubmissionResult> {
    throwIfAborted(signal);
    const args = [
      "agent", "prompt", paneId, text,
      "--submission-id", input.submissionId,
      "--expected-session-id", input.expectedSessionId,
      "--wait", "--until", "working", "--until", "blocked", "--timeout", String(this.commandTimeoutMs)
    ];
    const { stdout } = await this.runner.run(
      this.executable,
      args,
      this.commandTimeoutMs * 2,
      undefined,
      signal
    );
    const parsed = nativePromptResultSchema.parse(JSON.parse(stdout));
    if (parsed.result.submission_id !== input.submissionId) throw new Error("Herdr prompt submission receipt mismatch");
    return normalizeNativePromptResult(parsed.result);
  }

  async queueModelPrompt(
    paneId: string,
    text: string,
    input: { model: string; submissionId: string; expectedSessionId: string },
    signal?: AbortSignal
  ): Promise<NativePromptSubmissionResult> {
    throwIfAborted(signal);
    const { stdout } = await this.runner.run(
      this.executable,
      [
        "agent", "prompt", paneId, text,
        "--submission-id", input.submissionId,
        "--expected-session-id", input.expectedSessionId,
        "--model", input.model,
        "--wait", "--until", "working", "--until", "blocked", "--timeout", String(this.commandTimeoutMs)
      ],
      this.commandTimeoutMs * 12,
      undefined,
      signal
    );
    const parsed = nativePromptResultSchema.parse(JSON.parse(stdout));
    if (parsed.result.submission_id !== input.submissionId) throw new Error("Herdr model prompt submission receipt mismatch");
    return normalizeNativePromptResult(parsed.result);
  }

  async supportsPromptQueue(): Promise<boolean> {
    if (!this.promptQueueCapability) {
      this.promptQueueCapability = this.runner.run(this.executable, ["agent", "prompt", "--help"], this.commandTimeoutMs)
        .then(({ stdout, stderr }) => {
          const help = `${stdout}\n${stderr}`;
          return help.includes("--submission-id") && help.includes("--expected-session-id");
        })
        .catch(() => false);
    }
    const probe = this.promptQueueCapability;
    const supported = await probe;
    if (!supported && this.promptQueueCapability === probe) this.promptQueueCapability = null;
    return supported;
  }

  async supportsModelPrompt(): Promise<boolean> {
    if (!this.modelPromptCapability) {
      this.modelPromptCapability = this.runner.run(this.executable, ["agent", "prompt", "--help"], this.commandTimeoutMs)
        .then(({ stdout, stderr }) => {
          const help = `${stdout}\n${stderr}`;
          return help.includes("--submission-id")
            && help.includes("--expected-session-id")
            && help.includes("--model");
        })
        .catch(() => false);
    }
    const probe = this.modelPromptCapability;
    const supported = await probe;
    if (!supported && this.modelPromptCapability === probe) this.modelPromptCapability = null;
    return supported;
  }

  async supportsSessionRotation(): Promise<boolean> {
    if (!this.sessionRotationCapability) {
      this.sessionRotationCapability = this.runner.run(this.executable, ["agent", "session-rotate", "--help"], this.commandTimeoutMs)
        .then(({ stdout, stderr }) => `${stdout}\n${stderr}`.includes("--operation-id") && `${stdout}\n${stderr}`.includes("--expected-state-change-seq"))
        .catch(() => false);
    }
    const probe = this.sessionRotationCapability;
    const supported = await probe;
    if (!supported && this.sessionRotationCapability === probe) this.sessionRotationCapability = null;
    return supported;
  }

  async rotateSession(input: SessionRotationRequest): Promise<SessionRotationResult> {
    const args = [
      "agent", "session-rotate", "--operation-id", input.operationId, "--pane", input.paneId,
      "--expected-terminal-id", input.expectedTerminalId,
      "--expected-session-source", input.expectedSession.source,
      "--expected-session-agent", input.expectedSession.agent,
      "--expected-session-kind", input.expectedSession.kind,
      "--expected-session-value", input.expectedSession.value,
      "--expected-state-change-seq", String(input.expectedStateChangeSeq),
      "--name", input.launch.name, "--kind", input.launch.kind,
      "--timeout", String(input.launch.timeoutMs ?? this.commandTimeoutMs),
      ...(input.launch.args?.length ? ["--", ...input.launch.args] : [])
    ];
    let parsed: z.infer<typeof rotationResultSchema>;
    try {
      parsed = rotationEnvelopeSchema.parse(await this.json(args, (input.launch.timeoutMs ?? this.commandTimeoutMs) * 2)).rotation;
    } catch (error) {
      if (error instanceof CommandError && error.timedOut) return {
        outcome: "uncertain",
        operationId: input.operationId,
        paneId: input.paneId,
        reason: "Herdr agent.session_rotate.v1 timed out; the external effect is uncertain"
      };
      if (error instanceof SyntaxError || error instanceof z.ZodError) return {
        outcome: "malformed-response",
        operationId: input.operationId,
        paneId: input.paneId,
        reason: error instanceof SyntaxError
          ? "Herdr agent.session_rotate.v1 returned malformed JSON"
          : "Herdr agent.session_rotate.v1 returned an invalid response"
      };
      if (error instanceof CommandError) return {
        outcome: "uncertain",
        operationId: input.operationId,
        paneId: input.paneId,
        reason: "Herdr agent.session_rotate.v1 failed without an authoritative receipt; the external effect is uncertain"
      };
      throw error;
    }
    if (parsed.outcome === "rotated" || parsed.outcome === "already_applied") return {
      outcome: parsed.outcome === "already_applied" ? "already-applied" : "rotated",
      receipt: {
        operationId: parsed.receipt.operation_id, paneId: parsed.receipt.pane_id, terminalId: parsed.receipt.terminal_id,
        oldSession: parsed.receipt.old_session, newSession: parsed.receipt.new_session
      }
    };
    if (parsed.outcome === "rotating") return { outcome: "rotating", operationId: parsed.operation_id, paneId: parsed.pane_id };
    return {
      outcome: parsed.outcome.replaceAll("_", "-") as "fence-lost" | "unsupported-launch" | "definitely-not-started" | "uncertain",
      operationId: parsed.operation_id, paneId: parsed.pane_id, reason: parsed.reason
    };
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
    const activeTurnId = (await this.activeTurnForPane(pane))?.turnId ?? null;
    if (activeTurnId !== input.runtimeTurnId) return { status: "not-active", reason: "Runtime turn identity changed" };
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
    const processProbe = await this.foregroundExecutables(raw.pane_id);
    return {
      paneId: raw.pane_id, paneToken: normalizePaneToken(raw.token), tabId: raw.tab_id ?? null, terminalId: raw.terminal_id ?? null, workspaceId: raw.workspace_id, cwd: raw.cwd ?? null,
      ...(raw.foreground_cwd !== null && raw.foreground_cwd !== undefined ? { foregroundCwd: raw.foreground_cwd } : {}), label: raw.label ?? null, paneName: stablePaneName(raw.label),
      agentState: raw.agent_status ?? "unknown", foregroundExecutables: [...new Set(processProbe.executables)]
    };
  }

  private async foregroundExecutables(paneId: string): Promise<ProcessProbe> {
    try {
      let value: unknown;
      if (this.native) {
        try { value = await this.nativeRequest("pane.process_info", { pane_id: paneId }); }
        catch { value = await this.json(["pane", "process-info", "--pane", paneId]); }
      } else value = await this.json(["pane", "process-info", "--pane", paneId]);
      const processInfo = nativeProcessInfoSchema.parse(value).process_info;
      return { state: "observed", executables: [...new Set(processInfo.foreground_processes.flatMap((process) => {
        const values = [process.name, process.argv?.[0]].filter((value): value is string => Boolean(value));
        return values.map((value) => value.split("/").at(-1) ?? value);
      }))] };
    } catch {
      return { state: "unavailable", executables: [] };
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

  private fromSnapshot(raw: z.infer<typeof snapshotPaneSchema>, agent?: z.infer<typeof snapshotPaneSchema>, tabLabel?: string | null): HerdrPane {
    const kind = agent?.agent ?? raw.agent ?? null;
    const agentSession = agent?.agent_session ?? raw.agent_session ?? null;
    const foregroundCwd = raw.foreground_cwd ?? agent?.foreground_cwd ?? null;
    const foregroundExecutables = kind ? [kind] : [];
    return {
      paneId: raw.pane_id, paneToken: normalizePaneToken(raw.token) ?? normalizePaneToken(agent?.token), tabId: raw.tab_id ?? null, tabLabel: tabLabel ?? null, terminalId: raw.terminal_id ?? null, workspaceId: raw.workspace_id, cwd: raw.cwd ?? null,
      ...(foregroundCwd ? { foregroundCwd } : {}), label: raw.label ?? null, paneName: stablePaneName(raw.label, tabLabel),
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

function runtimeObservation(pane: HerdrPane, processProbe: ProcessProbe): RuntimeObservation {
  const foregroundExecutables: readonly string[] = processProbe.executables;
  const nativeTraex = pane.agentKind === "traex";
  const traexProcess = nativeTraex || foregroundExecutables.includes("traex");
  const observed = { ...pane, foregroundExecutables: [...foregroundExecutables] };
  if (!traexProcess) return { pane: { ...observed, agentState: "unknown" }, traexProcess, composerReady: false, evidenceSource: "process", processProbe: processProbe.state };
  return { pane: observed, traexProcess, composerReady: pane.agentState === "idle" || pane.agentState === "done", evidenceSource: pane.agentState === "unknown" ? "process" : "structured", processProbe: processProbe.state };
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

function normalizePaneIdentity(identity: z.infer<typeof paneIdentitySchema>): PaneIdentity {
  return {
    paneId: identity.pane_id,
    terminalId: identity.terminal_id,
    workspaceId: identity.workspace_id,
    token: identity.token
  };
}

function normalizeCoreOperationFailure(
  error: unknown,
  capability: "tab.create.v2" | "pane.identity_reconcile.v1"
): CoreOperationRejected | CoreOperationUncertain | CoreMalformedResponse | null {
  if (error instanceof CommandError && error.timedOut) return {
    outcome: "uncertain",
    code: "transport_timeout",
    reason: `Herdr ${capability} timed out; the external effect is uncertain`
  };
  if (error instanceof SyntaxError) return {
    outcome: "malformed-response",
    code: "malformed_json",
    reason: `Herdr ${capability} returned malformed JSON`
  };
  if (error instanceof z.ZodError) return {
    outcome: "malformed-response",
    code: "invalid_response",
    reason: `Herdr ${capability} returned an invalid response`
  };
  const message = String(error);
  const code = /"code"\s*:\s*"([^"]+)"/.exec(message)?.[1];
  const reasonValue = /"message"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(message)?.[1];
  if (!code || !reasonValue) return error instanceof CommandError ? {
    outcome: "uncertain",
    code: "transport_failure",
    reason: `Herdr ${capability} failed without an authoritative receipt; the external effect is uncertain`
  } : null;
  const reason = JSON.parse(reasonValue) as string;
  if (code === "pane_token_conflict") return { outcome: "token-conflict", code, reason };
  if (code === "stale_source_identity") return { outcome: "stale-fence", code, reason };
  if (code === "workspace_label_mismatch") return { outcome: "label-mismatch", code, reason };
  if (code === "pane_identity_reconcile_uncertain") return { outcome: "uncertain", code, reason };
  return { outcome: "rejected", code, reason };
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

function normalizeNativePromptResult(result: z.infer<typeof nativePromptResultSchema>["result"]): NativePromptSubmissionResult {
  if (!result.submission_receipt) return { submissionId: result.submission_id };
  const receipt: NativePromptSubmissionReceipt = {
    submissionId: result.submission_receipt.submission_id,
    terminalId: result.submission_receipt.terminal_id,
    agentKind: result.submission_receipt.agent_kind,
    sessionId: result.submission_receipt.session_id,
    state: result.submission_receipt.state,
    createdAt: result.submission_receipt.created_at,
    updatedAt: result.submission_receipt.updated_at
  };
  return { submissionId: result.submission_id, receipt };
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

function stablePaneName(paneLabel: string | null | undefined, tabLabel?: string | null): string | null {
  const label = paneLabel?.trim();
  if (label) return label;
  const managedTab = tabLabel?.trim().match(/^lark_(.+)$/i)?.[1]?.trim();
  return managedTab || null;
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
