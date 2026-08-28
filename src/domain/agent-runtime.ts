import type { AgentKind, AgentRuntimeRef } from "./agent-instance.js";

export interface AgentCapabilities {
  available: boolean;
  structuredEvents: boolean;
  nativeResume: boolean;
  primaryTools: boolean;
  steering: "native" | "terminal-input" | "unsupported";
  interrupt: "native" | "terminal-signal";
  approvals: "structured" | "terminal" | "none";
  modelSelection: "startup-only" | "runtime" | "unsupported";
  usageReporting: boolean;
}

export type DispatchReceipt =
  | { status: "confirmed-delivered"; runtimeCursor?: string }
  | { status: "not-delivered"; reason: string }
  | { status: "delivery-uncertain"; reason: string };

export interface AgentRuntimeDriver {
  readonly kind: AgentKind;
  describe(): AgentCapabilities;
  submit(runtime: AgentRuntimeRef, text: string): Promise<DispatchReceipt>;
}
