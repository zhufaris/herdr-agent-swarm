import type { AgentKind, AgentRuntimeRef } from "./agent-instance.js";
import type { RuntimeTurnObservation } from "./types.js";

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
export type SteerReceipt =
  | { status: "delivered"; operationId?: string; turnId?: string }
  | { status: "unsupported"; reason?: string }
  | { status: "not-active"; reason?: string }
  | { status: "blocked"; reason: string }
  | { status: "delivery-uncertain"; operationId: string; reason: string }
  | { status: "failed"; reason: string };
export type InterruptReceipt =
  | { status: "interrupted" }
  | { status: "not-active"; reason?: string }
  | { status: "blocked"; reason: string }
  | { status: "unsupported"; reason?: string }
  | { status: "delivery-uncertain"; operationId: string; reason: string }
  | { status: "failed"; reason: string };
export interface AgentDispatchHooks {
  onDispatched?(): void | Promise<void>;
  onObservation?(observation: RuntimeTurnObservation): void | Promise<void>;
}

export interface AgentRuntimeDriver {
  readonly kind: AgentKind;
  describe(): AgentCapabilities;
  start(runtime: AgentRuntimeRef, options?: { projectId?: string; name: string; managedName?: string; model: string | null; primaryTools?: { command: string; args: string[]; agentArgs?: string[] } }): Promise<void>;
  submit(runtime: AgentRuntimeRef, text: string, hooks?: AgentDispatchHooks, signal?: AbortSignal): Promise<DispatchReceipt>;
  steer?(runtime: AgentRuntimeRef, text: string): Promise<SteerReceipt>;
  interrupt?(runtime: AgentRuntimeRef): Promise<InterruptReceipt>;
}

export interface AgentDriverCatalog {
  get(kind: AgentKind): AgentRuntimeDriver | null;
  describe(kind: AgentKind): AgentCapabilities;
}
