import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { AgentRuntimeRef } from "../domain/agent-instance.js";
import type { ControllerInterpretationJob } from "../domain/controller-interpretation.js";
import type { NaturalLanguageCommandInterpreter, NaturalLanguageCommandResult } from "../domain/natural-language-command.js";
import type { ControllerInterpretationStore } from "../domain/ports/controller-interpretation.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { IncomingLarkMessage, ProjectConfig } from "../domain/types.js";
import { CoalescingDrain } from "./coalescing-drain.js";
import { safeLogError } from "./safe-error.js";

const CONTROLLER_NAME = "herdr-swarm-controller";
const TERMINAL_STATES = new Set(["succeeded", "clarification", "unsupported", "task", "failed", "uncertain"]);

// `--allowed-tool` approves matching tools; it is not an exclusive allowlist.
// Keep this defense-in-depth list explicit so new Controller capabilities must
// be reviewed here instead of being inherited from the operator's Trae config.
export const CONTROLLER_DISALLOWED_TOOLS = [
  // Native command, filesystem, and process tools. Include compatibility names
  // used by older harnesses because unknown deny entries fail closed/no-op.
  "exec", "functions.exec", "multi_tool_use.parallel",
  "exec_command", "write_stdin", "apply_patch", "shell", "Bash",
  "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep",
  // Network, browser, computer-control, image, and interactive approval tools.
  "web_search", "WebSearch", "WebFetch", "browser_use", "computer",
  "view_image", "request_user_input", "AskUserQuestion",
  // Planning/goal tools and every supported agent-delegation spelling.
  "create_goal", "get_goal", "update_goal", "update_plan", "TodoWrite",
  "spawn_agent", "send_message", "followup_task", "wait_agent",
  "interrupt_agent", "list_agents", "Task", "TaskOutput",
  "collaboration__spawn_agent", "collaboration__send_message",
  "collaboration__followup_task", "collaboration__wait_agent",
  "collaboration__interrupt_agent", "collaboration__list_agents",
] as const;

export interface ControllerAgentManagerOptions {
  store: ControllerInterpretationStore; herdr: HerdrPort; project: ProjectConfig; traexExecutable: string;
  mcpCommand: string; mcpArgs: string[]; turnTimeoutMs: number; model?: string | null; logger: Pick<Logger, "info" | "warn" | "error">;
  idFactory?: () => string; capabilityFactory?: () => string; now?: () => Date; pollIntervalMs?: number;
}

export class ControllerAgentManager implements NaturalLanguageCommandInterpreter {
  private runtime: AgentRuntimeRef | null = null;
  private activeAbort: AbortController | null = null;
  private readonly drain: CoalescingDrain;
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly options: ControllerAgentManagerOptions) {
    this.drain = new CoalescingDrain({ drain: () => this.drainOne(), onError: (error) => options.logger.error({ event: "controller-interpretation-drain-failed", err: safeLogError(error), outcome: "deferred" }, "Controller interpretation drain failed") });
  }

  async start(): Promise<void> {
    const recovered = this.options.store.recoverControllerInterpretations(this.now());
    if (recovered) this.options.logger.warn({ event: "controller-interpretations-recovered", recovered, outcome: "uncertain" }, "retained possibly dispatched Controller jobs without replay");
    try { this.runtime = await this.ensureRuntime(); }
    catch (error) { this.options.logger.warn({ event: "controller-runtime-unavailable", err: safeLogError(error), outcome: "degraded" }, "Controller Agent is unavailable; deterministic commands remain active"); }
    this.drain.start(this.options.pollIntervalMs ?? 1_000);
  }

  async stop(): Promise<void> { this.activeAbort?.abort(new Error("Controller manager stopping")); await this.drain.stop(); this.runtime = null; }

  async interpret(_rawText: string, message?: IncomingLarkMessage): Promise<NaturalLanguageCommandResult> {
    if (!message || !this.runtime) return { outcome: "unresolved" };
    const acceptedAt = this.now();
    const receipt = this.options.store.acceptControllerInterpretation({ id: this.id(), message, controllerGeneration: this.runtime.generation, capabilityHash: hash("not-issued"), acceptedAt });
    if (TERMINAL_STATES.has(receipt.job.state)) return receipt.job.result ?? { outcome: "unresolved" };
    this.drain.wake();
    return this.waitForResult(receipt.job.id);
  }

  private async drainOne(): Promise<void> {
    let runtime = this.runtime;
    if (!runtime) {
      try { runtime = await this.ensureRuntime(); this.runtime = runtime; }
      catch (error) { this.options.logger.warn({ event: "controller-runtime-reconcile-failed", err: safeLogError(error), outcome: "degraded" }, "Controller Agent remains unavailable"); return; }
    }
    const capability = (this.options.capabilityFactory ?? (() => randomBytes(32).toString("hex")))();
    const job = this.options.store.claimNextControllerInterpretation(runtime.generation, hash(capability), this.now());
    if (!job) return;
    const abort = new AbortController(); this.activeAbort = abort;
    try {
      let dispatched = false;
      await this.options.herdr.runPrompt(runtime.paneId, controllerPrompt(job, capability), this.options.turnTimeoutMs, undefined, abort.signal, () => {
        dispatched = true;
        this.options.store.markControllerInterpretationDispatched(job.id, runtime.generation, null, this.now());
      });
      const settled = this.options.store.getControllerInterpretation(job.id);
      if (settled?.state === "dispatching") this.options.store.failControllerInterpretation(job.id, runtime.generation, dispatched ? "uncertain" : "failed", dispatched ? "controller_prompt_settled_without_structured_result" : "controller_prompt_not_dispatched", this.now());
      else if (settled?.state === "observing") this.options.store.failControllerInterpretation(job.id, runtime.generation, "failed", "controller_turn_completed_without_structured_result", this.now());
    } catch (error) {
      const current = this.options.store.getControllerInterpretation(job.id);
      const state = current?.state === "observing" ? "uncertain" : "failed";
      this.options.store.failControllerInterpretation(job.id, runtime.generation, state, safeLogError(error).message, this.now());
    } finally {
      if (this.activeAbort === abort) this.activeAbort = null;
      this.notify(job.id);
      this.drain.wake();
    }
  }

  private async ensureRuntime(): Promise<AgentRuntimeRef> {
    const current = this.options.store.getControllerRuntime();
    if (current?.state === "active") {
      const pane = await this.options.herdr.getPane(current.paneId);
      if (pane && matchesControllerRuntime(pane, this.options.project, current)) return { herdrWorkspaceId: pane.workspaceId, paneId: pane.paneId, nativeSessionId: pane.agentSession?.value ?? current.nativeSessionId, generation: current.generation };
      this.options.store.markControllerRuntimeStale(current.generation, this.now());
    }
    const generation = (current?.generation ?? 0) + 1;
    const discovered = (await this.options.herdr.listPanes(this.options.project.workspaceId)).filter((pane) => pane.label === CONTROLLER_NAME && pane.cwd === this.options.project.cwd);
    if (discovered.length > 1) throw new Error("Multiple Controller panes require operator reconciliation");
    if (discovered.length === 1) {
      const pane = discovered[0]!;
      if (!pane.terminalId) throw new Error("Existing Controller pane has no terminal identity");
      if (pane.agentKind !== "traex" || !pane.agentSession?.value) return this.startRuntime(pane.paneId, generation);
      const saved = this.options.store.saveControllerRuntime({ generation, paneId: pane.paneId, terminalId: pane.terminalId, nativeSessionId: pane.agentSession.value, state: "active" }, this.now());
      return { herdrWorkspaceId: pane.workspaceId, paneId: pane.paneId, nativeSessionId: saved.nativeSessionId, generation };
    }
    const pane = await this.options.herdr.createPane(this.options.project.workspaceId, this.options.project.cwd, { bindingId: "controller", generation, projectId: this.options.project.id, placement: "dedicated-tab", title: CONTROLLER_NAME, titlePolicy: "complete" });
    return this.startRuntime(pane.paneId, generation);
  }

  private async startRuntime(paneId: string, generation: number): Promise<AgentRuntimeRef> {
    if (!this.options.herdr.startAgent) throw new Error("Herdr adapter cannot start the Controller Agent");
    try {
      await this.options.herdr.startAgent(paneId, { name: CONTROLLER_NAME, kind: "traex", executable: this.options.traexExecutable, args: controllerAgentArguments(this.options.mcpCommand, this.options.mcpArgs, this.options.model), useConfiguredPermissionMode: false });
    } catch (error) {
      const started = await this.options.herdr.getPane(paneId);
      if (!started || started.agentKind !== "traex" || !started.terminalId || started.agentState === "unknown") throw error;
    }
    const verified = await this.options.herdr.getPane(paneId);
    if (!verified?.terminalId || verified.agentKind !== "traex" || verified.agentState === "unknown") throw new Error("Herdr did not expose a verified Controller runtime identity");
    const runtimeIdentity = verified.agentSession?.value ?? verified.terminalId;
    const saved = this.options.store.saveControllerRuntime({ generation, paneId: verified.paneId, terminalId: verified.terminalId, nativeSessionId: runtimeIdentity, state: "active" }, this.now());
    this.options.logger.info({ event: "controller-runtime-ready", paneId: saved.paneId, generation: saved.generation, outcome: "ready" }, "Controller Agent is ready");
    return { herdrWorkspaceId: verified.workspaceId, paneId: verified.paneId, nativeSessionId: runtimeIdentity, generation };
  }

  private waitForResult(id: string): Promise<NaturalLanguageCommandResult> {
    const timeoutMs = this.options.turnTimeoutMs + 5_000;
    return new Promise((resolve) => {
      let settled = false;
      let interval: ReturnType<typeof setInterval>;
      let deadline: ReturnType<typeof setTimeout>;
      const cleanup = () => { clearInterval(interval); clearTimeout(deadline); const listeners = this.waiters.get(id); listeners?.delete(check); if (!listeners?.size) this.waiters.delete(id); };
      const check = () => {
        const job = this.options.store.getControllerInterpretation(id);
        if (!settled && (!job || TERMINAL_STATES.has(job.state))) { settled = true; cleanup(); resolve(job?.result ?? { outcome: "unresolved" }); }
      };
      interval = setInterval(check, Math.max(10, this.options.pollIntervalMs ?? 50)); interval.unref?.();
      const listeners = this.waiters.get(id) ?? new Set(); listeners.add(check); this.waiters.set(id, listeners);
      deadline = setTimeout(() => { if (!settled) { settled = true; cleanup(); resolve({ outcome: "unresolved" }); } }, timeoutMs); deadline.unref?.();
      check();
    });
  }
  private notify(id: string): void { for (const listener of this.waiters.get(id) ?? []) listener(); }
  private now(): string { return (this.options.now ?? (() => new Date()))().toISOString(); }
  private id(): string { return (this.options.idFactory ?? randomUUID)(); }
}

export function controllerAgentArguments(command: string, args: readonly string[], model?: string | null): string[] {
  const server = "herdr_swarm_controller";
  return [...(model ? ["--model", model] : []), "--sandbox", "read-only", "--ask-for-approval", "never",
    "--allowed-tool", `mcp__${server}__get_interpretation_context`, "--allowed-tool", `mcp__${server}__inspect_swarm_target`, "--allowed-tool", `mcp__${server}__submit_interpretation`,
    ...CONTROLLER_DISALLOWED_TOOLS.flatMap((tool) => ["--disallowed-tool", tool]),
    "-c", `mcp_servers.${server}.command=${JSON.stringify(command)}`, "-c", `mcp_servers.${server}.args=${JSON.stringify(args)}`];
}

function controllerPrompt(job: ControllerInterpretationJob, capability: string): string {
  return `You are the Herdr Swarm Controller interpreter. Do not execute the user's request and do not use shell or terminal mutation tools. Read request ${job.id} with capability ${capability}, inspect a target only when needed, then call submit_interpretation exactly once with a typed proposal. If ambiguous, submit clarification; if outside the supported Swarm command schema, submit unsupported. Never print the capability.`;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function matchesControllerRuntime(pane: Awaited<ReturnType<HerdrPort["getPane"]>>, project: ProjectConfig, runtime: { terminalId: string; nativeSessionId: string }): boolean {
  return Boolean(pane && pane.workspaceId === project.workspaceId && pane.cwd === project.cwd && pane.label === CONTROLLER_NAME && pane.terminalId === runtime.terminalId && pane.agentKind === "traex" && (pane.agentSession?.value ?? pane.terminalId) === runtime.nativeSessionId);
}
