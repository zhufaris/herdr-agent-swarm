import type { AgentCapabilities } from "../../domain/agent-runtime.js";
import { TerminalAgentDriver } from "./terminal-agent-driver.js";

export class PiDriver extends TerminalAgentDriver {
  readonly kind = "pi" as const;
  protected readonly herdrKind = "pi" as const;
  describe(): AgentCapabilities { return { available: this.available, structuredEvents: false, nativeResume: false, primaryTools: false, steering: "unsupported", interrupt: "terminal-signal", approvals: "terminal", modelSelection: "unsupported", usageReporting: false }; }
}
