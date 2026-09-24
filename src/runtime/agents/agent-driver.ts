import type { AgentKind } from "../../domain/agent-instance.js";
import type { AgentCapabilities, AgentDriverCatalog, AgentRuntimeDriver } from "../../domain/agent-runtime.js";

const unavailableCapabilities: AgentCapabilities = {
  available: false, structuredEvents: false, nativeResume: false, primaryTools: false,
  steering: "unsupported", interrupt: "terminal-signal", approvals: "none",
  modelSelection: "unsupported", usageReporting: false
};

export class AgentDriverRegistry implements AgentDriverCatalog {
  private readonly drivers: ReadonlyMap<AgentKind, AgentRuntimeDriver>;

  constructor(drivers: readonly AgentRuntimeDriver[]) {
    const entries = new Map<AgentKind, AgentRuntimeDriver>();
    for (const driver of drivers) {
      if (entries.has(driver.kind)) throw new Error(`Duplicate agent driver: ${driver.kind}`);
      entries.set(driver.kind, driver);
    }
    this.drivers = entries;
  }

  get(kind: AgentKind): AgentRuntimeDriver | null { return this.drivers.get(kind) ?? null; }
  describe(kind: AgentKind): AgentCapabilities { return this.get(kind)?.describe() ?? unavailableCapabilities; }
}
