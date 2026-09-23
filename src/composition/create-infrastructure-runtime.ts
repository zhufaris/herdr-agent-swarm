import type { Logger } from "pino";
import { dirname, resolve } from "node:path";
import type { BridgeConfig } from "../config.js";
import { HerdrCliAdapter } from "../adapters/herdr-adapter.js";
import { TraexControlAdapter } from "../adapters/traex-control-adapter.js";
import { createFeishuGatewayPlugin } from "../gateways/feishu/plugin.js";
import { GatewayEffectClient } from "../gateways/effect-client.js";
import { BuiltinGatewayRegistry } from "../gateways/registry.js";
import { ExecFileCommandRunner } from "../infra/command-runner.js";
import { AgentDriverRegistry } from "../runtime/agents/agent-driver.js";
import { ClaudeCodeDriver } from "../runtime/agents/claude-code-driver.js";
import { CodexDriver } from "../runtime/agents/codex-driver.js";
import { PiDriver } from "../runtime/agents/pi-driver.js";
import { TraexDriver } from "../runtime/agents/traex-driver.js";
import { HerdrCircuitBreaker } from "../runtime/herdr-circuit-breaker.js";
import type { HerdrRuntimeHint } from "../runtime/herdr-event-hint.js";
import { HerdrPaneHost } from "../runtime/herdr/pane-host.js";
import { HerdrSocketSubscriber } from "../runtime/herdr-socket-subscriber.js";
import { TraexTranscriptReader } from "../runtime/traex-transcript.js";
import { WorkspaceSnapshotCache } from "../runtime/workspace-snapshot-cache.js";
import { WorktreeManager } from "../runtime/worktree-manager.js";
import { WorktreeNameResolver } from "../runtime/worktree-name-resolver.js";
import { RuntimeLink } from "./runtime-link.js";

export interface AgentRuntimeAvailability { codex: boolean; claude: boolean; pi: boolean; }

export function createInfrastructureRuntime(
  config: BridgeConfig,
  logger: Logger,
  availability: AgentRuntimeAvailability,
  onHerdrEvent: (hint: HerdrRuntimeHint, signal: AbortSignal) => void | Promise<void>
) {
  const runner = new ExecFileCommandRunner(config.commandTimeoutMs);
  const worktreeNameResolver = new WorktreeNameResolver(runner, config.commandTimeoutMs);
  const herdrLink = new RuntimeLink<WorkspaceSnapshotCache>("Herdr snapshot cache");
  const herdrSocketSubscriber = process.env.HERDR_SOCKET_PATH
    ? new HerdrSocketSubscriber(process.env.HERDR_SOCKET_PATH, async () => {
      const workspaceIds = new Set(config.projects.map((project) => project.workspaceId));
      return (await herdrLink.get().listAllPanes()).filter((pane) => workspaceIds.has(pane.workspaceId)).map((pane) => pane.paneId);
    }, onHerdrEvent, logger)
    : null;
  const rawHerdr = new HerdrCliAdapter(runner, config.herdr.executable, config.commandTimeoutMs, config.traex.permissionMode, herdrSocketSubscriber ?? undefined);
  const traexControl = new TraexControlAdapter(resolve(dirname(config.traex.sessionsRoot), "session-peers"), resolve(dirname(config.databasePath), "traex-model-prompt-operations"), config.commandTimeoutMs);
  const herdrCircuitBreaker = new HerdrCircuitBreaker(rawHerdr, config.herdrCircuitBreaker, logger);
  const herdr = new WorkspaceSnapshotCache(herdrCircuitBreaker, config.runtimeTuning.cache.herdrSnapshotTtlMs, logger);
  herdrLink.connect(herdr);
  const paneHost = new HerdrPaneHost(herdr);
  const gateway = new BuiltinGatewayRegistry([createFeishuGatewayPlugin()]).create(
    config.gateway.kind, { gatewayId: config.gateway.id, ...config.lark }, { logger },
    { threads: true, richViews: true, mutableSurfaces: true, interactions: true, orderedStreaming: true }
  );
  const gatewayEffects = new GatewayEffectClient(gateway.delivery);
  const agentDrivers = new AgentDriverRegistry([
    new TraexDriver(herdr, config.traex.executable, config.turnTimeoutMs),
    new CodexDriver(herdr, config.agents.codex, config.turnTimeoutMs, availability.codex),
    new ClaudeCodeDriver(herdr, config.agents.claudeCode, config.turnTimeoutMs, availability.claude),
    new PiDriver(herdr, config.agents.pi, config.turnTimeoutMs, availability.pi)
  ]);
  return {
    runner, worktreeNameResolver, herdrSocketSubscriber, herdrCircuitBreaker, herdr, traexControl, paneHost, agentDrivers,
    worktrees: new WorktreeManager(runner, { timeoutMs: config.commandTimeoutMs }),
    gateway, gatewayEffects,
    transcriptReader: new TraexTranscriptReader({ sessionsRoot: config.traex.sessionsRoot })
  };
}
