import type { AgentCapabilities } from "../../domain/agent-runtime.js";
import { TerminalAgentDriver } from "./terminal-agent-driver.js";

export class CodexDriver extends TerminalAgentDriver {
  readonly kind = "codex" as const;
  protected readonly herdrKind = "codex" as const;
  describe(): AgentCapabilities { return { available: this.available, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "unsupported", interrupt: "terminal-signal", approvals: "terminal", modelSelection: "startup-only", usageReporting: true }; }
}
