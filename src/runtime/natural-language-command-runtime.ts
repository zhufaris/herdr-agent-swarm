import type { NaturalLanguageCommandInterpreter, NaturalLanguageCommandResult } from "../domain/natural-language-command.js";
import { DeterministicNaturalLanguageCommandInterpreter } from "../domain/natural-language-command.js";
import type { Logger } from "pino";
import type { ControllerInterpretationStore } from "../domain/ports/controller-interpretation.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { IncomingLarkMessage, ProjectConfig } from "../domain/types.js";
import { ControllerAgentManager } from "./controller-agent-manager.js";
import { ControllerToolGateway, type ControllerToolContext } from "./controller-tool-gateway.js";
import { safeLogError } from "./safe-error.js";

export interface NaturalLanguageCommandRuntime extends NaturalLanguageCommandInterpreter {
  start(): Promise<void>;
  stop(): Promise<void>;
  interpret(text: string, message?: IncomingLarkMessage): Promise<NaturalLanguageCommandResult>;
}

export interface NaturalLanguageCommandRuntimeOptions {
  projects: readonly ProjectConfig[];
  controller?: {
    store: ControllerInterpretationStore;
    herdr: HerdrPort;
    project: ProjectConfig;
    socketPath: string;
    traexExecutable: string;
    mcpCommand: string;
    mcpArgs: string[];
    turnTimeoutMs: number;
    model?: string | null;
    logger: Pick<Logger, "info" | "warn" | "error">;
    context?: ControllerToolContext;
    idFactory?: () => string;
    capabilityFactory?: () => string;
    now?: () => Date;
    pollIntervalMs?: number;
  };
}

export function createNaturalLanguageCommandRuntime(options: NaturalLanguageCommandRuntimeOptions): NaturalLanguageCommandRuntime {
  const deterministic = new DeterministicNaturalLanguageCommandInterpreter(options.projects);
  const manager = options.controller ? new ControllerAgentManager(options.controller) : null;
  const endpoint = options.controller
    ? new ControllerToolGateway(options.controller.socketPath, options.controller.store, options.projects, options.controller.logger, options.controller.context)
    : null;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let controllerAvailable = false;

  const start = async () => {
    if (!endpoint || !manager) return;
    try {
      await endpoint.start();
      await manager.start();
      controllerAvailable = true;
    } catch (error) {
      controllerAvailable = false;
      await manager.stop().catch(() => undefined);
      await endpoint.stop().catch(() => undefined);
      options.controller!.logger.warn({ event: "natural-language-controller-unavailable", err: safeLogError(error), outcome: "degraded" }, "Controller interpretation is unavailable; deterministic commands remain active");
    }
  };
  const stop = async () => {
    controllerAvailable = false;
    const results = await Promise.allSettled([manager?.stop(), endpoint?.stop()]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(({ reason }) => reason), "Natural-language Controller shutdown failed");
  };

  return {
    start() { return startPromise ??= start(); },
    stop() { return stopPromise ??= stop(); },
    async interpret(text, message) {
      const result = deterministic.interpret(text);
      return result.outcome === "unresolved" && manager && controllerAvailable ? manager.interpret(text, message) : result;
    }
  };
}
