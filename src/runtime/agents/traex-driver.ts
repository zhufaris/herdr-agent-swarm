import type { AgentRuntimeRef } from "../../domain/agent-instance.js";
import type { AgentCapabilities, AgentRuntimeDriver, DispatchReceipt, InterruptReceipt, SteerReceipt } from "../../domain/agent-runtime.js";
import type { HerdrPort } from "../../domain/ports.js";
import { safeLogError } from "../safe-error.js";

export class TraexDriver implements AgentRuntimeDriver {
  readonly kind = "traex" as const;

  constructor(
    private readonly herdr: HerdrPort,
    private readonly executable: string,
    private readonly turnTimeoutMs: number
  ) {}

  describe(): AgentCapabilities {
    return {
      available: true, structuredEvents: true, nativeResume: true, primaryTools: true,
      steering: "unsupported", interrupt: "native", approvals: "terminal",
      modelSelection: "startup-only", usageReporting: true
    };
  }

  async start(runtime: AgentRuntimeRef, options?: { projectId?: string; name: string; model: string | null; primaryTools?: { command: string; args: string[]; agentArgs?: string[] } }): Promise<void> {
    const args = [
      ...(options?.model ? ["--model", options.model] : []),
      ...(options?.primaryTools ? [...(options.primaryTools.agentArgs ?? []), ...mcpArguments(options.primaryTools)] : [])
    ];
    if (!this.herdr.startAgent) throw new Error("Herdr adapter does not support managed agent startup");
    await this.herdr.startAgent(runtime.paneId, { name: managedName(options?.projectId, options?.name ?? this.kind), kind: "traex", executable: this.executable, args });
  }

  async submit(runtime: AgentRuntimeRef, text: string, onDispatched?: () => void): Promise<DispatchReceipt> {
    let dispatched = false;
    try {
      await this.herdr.runPrompt(runtime.paneId, text, this.turnTimeoutMs, undefined, undefined, () => { dispatched = true; onDispatched?.(); });
      return { status: "confirmed-delivered" };
    } catch (error) {
      const reason = safeLogError(error).message;
      return dispatched ? { status: "delivery-uncertain", reason } : { status: "not-delivered", reason };
    }
  }

  async steer(_runtime: AgentRuntimeRef, _text: string): Promise<SteerReceipt> {
    return { status: "unsupported" };
  }

  async interrupt(runtime: AgentRuntimeRef): Promise<InterruptReceipt> {
    if (!this.herdr.sendEscape) return { status: "failed", reason: "Agent interruption is unavailable" };
    try { await this.herdr.sendEscape(runtime.paneId); return { status: "interrupted" }; }
    catch (error) { return { status: "failed", reason: safeLogError(error).message }; }
  }
}

function mcpArguments(server: { command: string; args: string[] }): string[] {
  return [
    "-c", `mcp_servers.herdr_agent_swarm.command=${JSON.stringify(server.command)}`,
    "-c", `mcp_servers.herdr_agent_swarm.args=${JSON.stringify(server.args)}`,
    "-c", 'mcp_servers.herdr_agent_swarm.env_vars=["SWARM_PRIMARY_CAPABILITY"]'
  ];
}
function managedName(projectId: string | undefined, name: string): string {
  const prefix = `${projectId ?? "agent"}-${name}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "a-");
  return prefix.slice(0, 32).replace(/[-_]$/, "") || "agent";
}
