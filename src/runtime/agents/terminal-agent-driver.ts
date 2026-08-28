import type { AgentKind, AgentRuntimeRef } from "../../domain/agent-instance.js";
import type { AgentCapabilities, AgentRuntimeDriver, DispatchReceipt, InterruptReceipt, SteerReceipt } from "../../domain/agent-runtime.js";
import type { HerdrPort } from "../../domain/ports.js";
import { safeLogError } from "../safe-error.js";

export abstract class TerminalAgentDriver implements AgentRuntimeDriver {
  abstract readonly kind: AgentKind;
  protected abstract readonly herdrKind: "pi" | "claude" | "codex";

  constructor(protected readonly herdr: HerdrPort, protected readonly executable: string, protected readonly turnTimeoutMs: number, protected readonly available: boolean) {}
  abstract describe(): AgentCapabilities;

  async start(runtime: AgentRuntimeRef, options?: { projectId?: string; name: string; model: string | null; primaryTools?: { command: string; args: string[]; agentArgs?: string[] } }): Promise<void> {
    if (!this.available) throw new Error(`Agent adapter is unavailable: ${this.kind}`);
    if (!this.herdr.startAgent) throw new Error("Herdr adapter does not support managed agent startup");
    const args = options?.model && this.describe().modelSelection !== "unsupported" ? ["--model", options.model] : [];
    if (options?.primaryTools && this.kind === "codex") args.push(...(options.primaryTools.agentArgs ?? []), ...mcpArguments(options.primaryTools));
    await this.herdr.startAgent(runtime.paneId, { name: managedName(options?.projectId, options?.name ?? this.kind), kind: this.herdrKind, executable: this.executable, args });
  }

  async submit(runtime: AgentRuntimeRef, text: string): Promise<DispatchReceipt> {
    if (!this.available) return { status: "not-delivered", reason: `Agent adapter is unavailable: ${this.kind}` };
    let dispatched = false;
    try {
      const run = this.herdr.runManagedPrompt
        ? this.herdr.runManagedPrompt(runtime.paneId, text, this.turnTimeoutMs, () => { dispatched = true; })
        : this.herdr.runPrompt(runtime.paneId, text, this.turnTimeoutMs, undefined, undefined, () => { dispatched = true; });
      await run;
      return { status: "confirmed-delivered" };
    } catch (error) {
      const reason = safeLogError(error).message;
      return dispatched ? { status: "delivery-uncertain", reason } : { status: "not-delivered", reason };
    }
  }

  async steer(runtime: AgentRuntimeRef, text: string): Promise<SteerReceipt> {
    if (this.describe().steering === "unsupported" || !this.herdr.steerPrompt) return { status: "unsupported" };
    try { return await this.herdr.steerPrompt(runtime.paneId, text) === "injected" ? { status: "delivered" } : { status: "not-active" }; }
    catch (error) { return { status: "failed", reason: safeLogError(error).message }; }
  }

  async interrupt(runtime: AgentRuntimeRef): Promise<InterruptReceipt> {
    if (!this.herdr.sendEscape) return { status: "failed", reason: "Agent interruption is unavailable" };
    try { await this.herdr.sendEscape(runtime.paneId); return { status: "interrupted" }; }
    catch (error) { return { status: "failed", reason: safeLogError(error).message }; }
  }
}

function mcpArguments(server: { command: string; args: string[] }): string[] {
  return ["-c", `mcp_servers.solo_agent.command=${JSON.stringify(server.command)}`, "-c", `mcp_servers.solo_agent.args=${JSON.stringify(server.args)}`, "-c", 'mcp_servers.solo_agent.env_vars=["SOLO_AGENT_PRIMARY_CAPABILITY"]'];
}

function managedName(projectId: string | undefined, name: string): string {
  const prefix = `${projectId ?? "agent"}-${name}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "a-");
  return prefix.slice(0, 32).replace(/[-_]$/, "") || "agent";
}
