import type { AgentCapabilities } from "../../domain/agent-runtime.js";
import type { AgentRuntimeRef } from "../../domain/agent-instance.js";
import { mkdir } from "node:fs/promises";
import { TerminalAgentDriver } from "./terminal-agent-driver.js";
import { piTranscriptDescriptor } from "./pi-transcript-identity.js";

export class PiDriver extends TerminalAgentDriver {
  readonly kind = "pi" as const;
  protected readonly herdrKind = "pi" as const;
  constructor(herdr: ConstructorParameters<typeof TerminalAgentDriver>[0], executable: string, turnTimeoutMs: number, available: boolean, private readonly transcriptRoot?: string) { super(herdr, executable, turnTimeoutMs, available); }
  describe(): AgentCapabilities { return { available: this.available, structuredEvents: Boolean(this.transcriptRoot), nativeResume: false, primaryTools: false, steering: "unsupported", interrupt: "terminal-signal", approvals: "terminal", modelSelection: "unsupported", usageReporting: Boolean(this.transcriptRoot) }; }
  protected override async extendStartupArgs(args: string[], runtime: AgentRuntimeRef, options?: { transcriptOwnerId?: string }): Promise<void> {
    if (!this.transcriptRoot || !options?.transcriptOwnerId) return;
    const descriptor = piTranscriptDescriptor(this.transcriptRoot, options.transcriptOwnerId, runtime.generation);
    await mkdir(descriptor.sessionDir, { recursive: true, mode: 0o700 });
    args.push("--session-id", descriptor.sessionId, "--session-dir", descriptor.sessionDir);
  }
}
