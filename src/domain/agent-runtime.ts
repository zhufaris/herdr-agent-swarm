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
export type SteerReceipt = { status: "delivered" } | { status: "unsupported" } | { status: "not-active" } | { status: "failed"; reason: string };
export type InterruptReceipt = { status: "interrupted" } | { status: "not-active" } | { status: "failed"; reason: string };

export interface AgentRuntimeDriver {
  readonly kind: AgentKind;
  describe(): AgentCapabilities;
  start(runtime: AgentRuntimeRef, options?: { projectId?: string; name: string; model: string | null; primaryTools?: { command: string; args: string[]; agentArgs?: string[] } }): Promise<void>;
  submit(runtime: AgentRuntimeRef, text: string, onDispatched?: () => void): Promise<DispatchReceipt>;
  steer?(runtime: AgentRuntimeRef, text: string): Promise<SteerReceipt>;
  interrupt?(runtime: AgentRuntimeRef): Promise<InterruptReceipt>;
}
