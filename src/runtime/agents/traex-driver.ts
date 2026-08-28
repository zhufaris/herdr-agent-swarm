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
      steering: "terminal-input", interrupt: "terminal-signal", approvals: "terminal",
      modelSelection: "runtime", usageReporting: true
    };
  }

  async start(runtime: AgentRuntimeRef): Promise<void> {
    await this.herdr.startTraex(runtime.paneId, this.executable);
  }

  async submit(runtime: AgentRuntimeRef, text: string): Promise<DispatchReceipt> {
    let dispatched = false;
    try {
      await this.herdr.runPrompt(runtime.paneId, text, this.turnTimeoutMs, undefined, undefined, () => { dispatched = true; });
      return { status: "confirmed-delivered" };
    } catch (error) {
      const reason = safeLogError(error).message;
      return dispatched ? { status: "delivery-uncertain", reason } : { status: "not-delivered", reason };
    }
  }

  async steer(runtime: AgentRuntimeRef, text: string): Promise<SteerReceipt> {
    if (!this.herdr.steerPrompt) return { status: "unsupported" };
    try { return await this.herdr.steerPrompt(runtime.paneId, text) === "injected" ? { status: "delivered" } : { status: "not-active" }; }
    catch (error) { return { status: "failed", reason: safeLogError(error).message }; }
  }

  async interrupt(runtime: AgentRuntimeRef): Promise<InterruptReceipt> {
    if (!this.herdr.sendEscape) return { status: "failed", reason: "Agent interruption is unavailable" };
    try { await this.herdr.sendEscape(runtime.paneId); return { status: "interrupted" }; }
    catch (error) { return { status: "failed", reason: safeLogError(error).message }; }
  }
}
