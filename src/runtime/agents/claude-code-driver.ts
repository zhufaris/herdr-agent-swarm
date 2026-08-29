import type { AgentCapabilities } from "../../domain/agent-runtime.js";
import { TerminalAgentDriver } from "./terminal-agent-driver.js";

export class ClaudeCodeDriver extends TerminalAgentDriver {
  readonly kind = "claude-code" as const;
  protected readonly herdrKind = "claude" as const;
  describe(): AgentCapabilities { return { available: this.available, structuredEvents: true, nativeResume: true, primaryTools: false, steering: "unsupported", interrupt: "terminal-signal", approvals: "terminal", modelSelection: "startup-only", usageReporting: true }; }
}
