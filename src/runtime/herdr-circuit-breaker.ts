import type { Logger } from "pino";
import type { HerdrPort } from "../domain/ports/external.js";
import type { AgentState, HerdrCircuitBreakerStatus, HerdrPane, HerdrPaneCreationOptions, RuntimeObservation, RuntimeTurnObservation } from "../domain/types.js";
import { CommandError } from "../infra/command-runner.js";
import { safeLogError } from "./safe-error.js";

export interface HerdrCircuitBreakerOptions { failureThreshold: number; openMs: number }
type CircuitState = HerdrCircuitBreakerStatus["state"];
type OperationKind = "probe" | "command";

export class HerdrCircuitOpenError extends Error {
  constructor(readonly nextProbeAt: string | null) {
    super(nextProbeAt ? `Herdr transport circuit is open until ${nextProbeAt}` : "Herdr transport circuit is half-open; recovery probe is in progress");
    this.name = "HerdrCircuitOpenError";
  }
}

export class HerdrCircuitBreaker implements HerdrPort {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private totalTransportFailures = 0;
  private rejectedCalls = 0;
  private successfulProbes = 0;
  private openedAt: number | null = null;
  private nextProbeAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastFailure: string | null = null;

  constructor(
    private readonly delegate: HerdrPort,
    private readonly options: HerdrCircuitBreakerOptions,
    private readonly logger?: Pick<Logger, "info" | "warn">,
    private readonly clock: () => number = Date.now
  ) {}

  status(): HerdrCircuitBreakerStatus {
    return {
      state: this.state, failureThreshold: this.options.failureThreshold, openMs: this.options.openMs,
      consecutiveFailures: this.consecutiveFailures, totalTransportFailures: this.totalTransportFailures,
      rejectedCalls: this.rejectedCalls, successfulProbes: this.successfulProbes,
      openedAt: iso(this.openedAt), nextProbeAt: iso(this.nextProbeAt),
      lastFailureAt: iso(this.lastFailureAt), lastFailure: this.lastFailure
    };
  }

  async assertWorkspace(workspaceId: string, expectedSpaceName?: string): Promise<void> {
    await this.call("probe", () => expectedSpaceName === undefined ? this.delegate.assertWorkspace(workspaceId) : this.delegate.assertWorkspace(workspaceId, expectedSpaceName));
  }
  async listAllPanes(): Promise<HerdrPane[]> {
    if (!this.delegate.listAllPanes) throw new Error("Herdr adapter does not support an all-workspace snapshot");
    return this.call("probe", () => this.delegate.listAllPanes!());
  }
  async listPanes(workspaceId: string, options?: { forceRefresh?: boolean }): Promise<HerdrPane[]> { return this.call("probe", () => this.delegate.listPanes(workspaceId, options)); }
  async getPane(paneId: string): Promise<HerdrPane | null> { return this.call("probe", () => this.delegate.getPane(paneId)); }
  async observeRuntime(paneId: string): Promise<RuntimeObservation> { return this.call("probe", () => this.delegate.observeRuntime(paneId)); }
  async waitForRuntimeChange(paneId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (!this.delegate.waitForRuntimeChange) return;
    await this.delegate.waitForRuntimeChange(paneId, timeoutMs, signal);
  }
  async createPane(workspaceId: string, cwd: string, options?: HerdrPaneCreationOptions): Promise<HerdrPane> { return this.call("command", () => this.delegate.createPane(workspaceId, cwd, options)); }
  async startTraex(paneId: string, executable: string, args?: string[]): Promise<void> { await this.call("command", () => this.delegate.startTraex(paneId, executable, args)); }
  async startAgent(paneId: string, input: { name: string; kind: "pi" | "claude" | "codex" | "traex"; executable: string; args?: string[]; useConfiguredPermissionMode?: boolean }): Promise<void> {
    if (!this.delegate.startAgent) throw new Error("Herdr adapter does not support managed agent startup");
    await this.call("command", () => this.delegate.startAgent!(paneId, input));
  }
  async runPrompt(paneId: string, text: string, timeoutMs: number, onObservation?: (observation: RuntimeTurnObservation) => void | Promise<void>, signal?: AbortSignal, onDispatched?: () => void | Promise<void>): Promise<AgentState> {
    return this.call("command", () => this.delegate.runPrompt(paneId, text, timeoutMs, onObservation, signal, onDispatched));
  }
  async waitForAgent(paneId: string, timeoutMs: number, onObservation?: (observation: RuntimeTurnObservation) => void | Promise<void>, signal?: AbortSignal): Promise<AgentState> {
    if (!this.delegate.waitForAgent) throw new Error("Herdr adapter does not support native Agent wait");
    return this.call("command", () => this.delegate.waitForAgent!(paneId, timeoutMs, onObservation, signal));
  }
  async sendEscape(paneId: string): Promise<void> {
    if (!this.delegate.sendEscape) throw new Error("Herdr adapter does not support Escape control");
    await this.call("command", () => this.delegate.sendEscape!(paneId));
  }
  async interruptAgent(input: Parameters<NonNullable<HerdrPort["interruptAgent"]>>[0]): Promise<import("../domain/agent-runtime.js").InterruptReceipt> {
    if (!this.delegate.interruptAgent) return { status: "unsupported", reason: "Herdr adapter does not support native interruption" };
    return this.call("command", () => this.delegate.interruptAgent!(input));
  }
  async renamePane(paneId: string, title: string, options?: { tabTitle?: string }): Promise<void> { await this.call("command", () => this.delegate.renamePane(paneId, title, options)); }
  async closePane(paneId: string): Promise<void> { await this.call("command", () => this.delegate.closePane(paneId)); }

  private async call<T>(kind: OperationKind, operation: () => Promise<T>): Promise<T> {
    const admission = this.admit(kind);
    try {
      const value = await operation();
      if (admission === "half_open" && this.state === "half_open") this.close();
      else if (admission === "closed" && this.state === "closed") this.consecutiveFailures = 0;
      return value;
    } catch (error) {
      if (isHerdrTransportFailure(error)) this.recordFailure(error, admission);
      else if (admission === "half_open" && this.state === "half_open") this.close();
      throw error;
    }
  }

  private admit(kind: OperationKind): CircuitState {
    if (this.state === "closed") return "closed";
    const now = this.clock();
    if (this.state === "open" && kind === "probe" && this.nextProbeAt !== null && now >= this.nextProbeAt) {
      this.state = "half_open";
      this.logger?.info({ event: "herdr-circuit-half-open", outcome: "probing" }, "Herdr transport circuit admitted a recovery probe");
      return "half_open";
    }
    this.rejectedCalls += 1;
    throw new HerdrCircuitOpenError(iso(this.nextProbeAt));
  }

  private recordFailure(error: unknown, admission: CircuitState): void {
    const now = this.clock();
    this.totalTransportFailures += 1;
    this.lastFailureAt = now;
    this.lastFailure = boundedError(error);
    if (admission === "half_open") { this.reopen(error); return; }
    if (this.state !== "closed") return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.failureThreshold) this.open(error, now);
  }

  private open(error: unknown, now: number): void {
    this.state = "open"; this.openedAt = now; this.nextProbeAt = now + this.options.openMs;
    this.logger?.warn({ event: "herdr-circuit-opened", consecutiveFailures: this.consecutiveFailures, nextProbeAt: iso(this.nextProbeAt), err: safeLogError(error), outcome: "open" }, "opened Herdr transport circuit");
  }
  private reopen(error: unknown): void {
    const now = this.clock();
    this.state = "open"; this.openedAt = now; this.nextProbeAt = now + this.options.openMs;
    this.logger?.warn({ event: "herdr-circuit-probe-failed", nextProbeAt: iso(this.nextProbeAt), err: safeLogError(error), outcome: "open" }, "Herdr transport recovery probe failed");
  }
  private close(): void {
    this.state = "closed"; this.consecutiveFailures = 0; this.openedAt = null; this.nextProbeAt = null; this.successfulProbes += 1;
    this.logger?.info({ event: "herdr-circuit-closed", outcome: "recovered" }, "closed Herdr transport circuit after successful probe");
  }
}

export function isHerdrTransportFailure(error: unknown): boolean {
  if (error instanceof HerdrCircuitOpenError) return false;
  if (error instanceof CommandError && error.timedOut) return true;
  const candidate = error as NodeJS.ErrnoException;
  if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOENT", "ETIMEDOUT"].includes(candidate?.code ?? "")) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|ECONNRESET|EPIPE|ENOENT|ETIMEDOUT|socket(?:_| )(?:closed|stopped|unavailable|disconnected|request_timeout)|connection (?:closed|lost|refused|reset)|could not reach Herdr|failed to connect|transport (?:closed|unavailable)/i.test(message);
}

function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 500); }
function iso(value: number | null): string | null { return value === null ? null : new Date(value).toISOString(); }
