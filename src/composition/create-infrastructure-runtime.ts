import type { Logger } from "pino";
import { dirname, resolve } from "node:path";
import type { BridgeConfig } from "../config.js";
import { HerdrCliAdapter } from "../adapters/herdr-adapter.js";
import {
  HerdrEventsAdapter,
  normalizeSessionEventMultiplexAck,
  normalizeSessionEventMultiplexFrame
} from "../adapters/herdr-events-adapter.js";
import { HerdrAgentInputAdapter } from "../adapters/herdr-agent-input-adapter.js";
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
import type { HerdrNativeEventHint } from "../runtime/herdr-event-hint.js";
import { HerdrPaneHost } from "../runtime/herdr/pane-host.js";
import { HerdrSocketSubscriber } from "../runtime/herdr-socket-subscriber.js";
import { HerdrSessionEventSubscriber } from "../runtime/herdr-session-event-subscriber.js";
import { TraexTranscriptReader } from "../runtime/traex-transcript.js";
import { PiTranscriptReader } from "../runtime/pi-transcript.js";
import { AgentTranscriptReader, type DescriptorAwareTranscriptReader } from "../runtime/agent-transcript-reader.js";
import { HerdrEventsShadowReader } from "../runtime/herdr-events-shadow.js";
import { HerdrEventsReader } from "../runtime/herdr-events-reader.js";
import { WorkspaceSnapshotCache } from "../runtime/workspace-snapshot-cache.js";
import { WorktreeManager } from "../runtime/worktree-manager.js";
import { WorktreeNameResolver } from "../runtime/worktree-name-resolver.js";
import { RuntimeLink } from "./runtime-link.js";
import type { AgentKind } from "../domain/agent-instance.js";
import type { AuthoritativeTurnSnapshotStore, CoreEventInboxStore } from "../domain/core-event-inbox.js";
import { AgentInputCapabilityGate } from "../runtime/agent-input-capability.js";
import type { CoreSessionEventMultiplexFrame, CoreSessionEventMultiplexTarget } from "../domain/herdr-events.js";

export interface AgentRuntimeAvailability { codex: boolean; claude: boolean; pi: boolean; }

export function createInfrastructureRuntime(
  config: BridgeConfig,
  logger: Logger,
  availability: AgentRuntimeAvailability,
  onHerdrEvent: (hint: HerdrNativeEventHint, signal: AbortSignal) => void | Promise<void>,
  coreEvents?: CoreEventInboxStore,
  turnSnapshots?: AuthoritativeTurnSnapshotStore
) {
  const runner = new ExecFileCommandRunner(config.commandTimeoutMs);
  const worktreeNameResolver = new WorktreeNameResolver(runner, config.commandTimeoutMs);
  const herdrLink = new RuntimeLink<WorkspaceSnapshotCache>("Herdr snapshot cache");
  const sessionEventFrameLink = new RuntimeLink<(frame: CoreSessionEventMultiplexFrame, generation: number) => void>("Core session event consumer");
  const sessionEventActivationLink = new RuntimeLink<(targets: readonly CoreSessionEventMultiplexTarget[], generation: number) => void>("Core session event activation");
  const sessionEventTargetRefreshLink = new RuntimeLink<() => Promise<readonly CoreSessionEventMultiplexTarget[]>>("Core session event target refresh");
  const sessionEventTransportLink = new RuntimeLink<(state: "connected" | "disconnected", generation: number) => void>("Core session event transport state");
  const herdrSocketSubscriber: HerdrSocketSubscriber | null = process.env.HERDR_SOCKET_PATH
    ? new HerdrSocketSubscriber(process.env.HERDR_SOCKET_PATH, async () => {
      const workspaceIds = new Set(config.projects.map((project) => project.workspaceId));
      return (await herdrLink.get().listAllPanes()).filter((pane) => workspaceIds.has(pane.workspaceId)).map((pane) => pane.paneId);
    }, onHerdrEvent, logger, 250, 10_000, 2 * 1024 * 1024, 5_000, (): Promise<boolean> => eventsAdapter.supportsPaneAgentStatusAll())
    : null;
  const rawHerdr = new HerdrCliAdapter(runner, config.herdr.executable, config.commandTimeoutMs, config.traex.permissionMode, herdrSocketSubscriber ?? undefined);
  const traexControl = new TraexControlAdapter(config.commandTimeoutMs, runner, config.traex.executable);
  const herdrCircuitBreaker = new HerdrCircuitBreaker(rawHerdr, config.herdrCircuitBreaker, logger);
  const herdr = new WorkspaceSnapshotCache(herdrCircuitBreaker, config.runtimeTuning.cache.herdrSnapshotTtlMs, logger);
  herdrLink.connect(herdr);
  const paneHost = new HerdrPaneHost(herdr);
  const gateway = new BuiltinGatewayRegistry([createFeishuGatewayPlugin()]).create(
    config.gateway.kind, { gatewayId: config.gateway.id, ...config.lark }, { logger },
    { threads: true, richViews: true, mutableSurfaces: true, interactions: true, orderedStreaming: true }
  );
  const gatewayEffects = new GatewayEffectClient(gateway.delivery);
  const piTranscriptRoot = resolve(dirname(config.databasePath), "pi-sessions");
  const agentDrivers = new AgentDriverRegistry([
    new TraexDriver(herdr, config.traex.executable, config.turnTimeoutMs),
    new CodexDriver(herdr, config.agents.codex, config.turnTimeoutMs, availability.codex),
    new ClaudeCodeDriver(herdr, config.agents.claudeCode, config.turnTimeoutMs, availability.claude),
    new PiDriver(herdr, config.agents.pi, config.turnTimeoutMs, availability.pi, piTranscriptRoot)
  ]);
  const traexTranscriptReader = new TraexTranscriptReader({ sessionsRoot: config.traex.sessionsRoot, reasoningDisplay: config.runtimeTuning.cards.reasoningDisplay });
  const piTranscriptReader = new PiTranscriptReader({ root: piTranscriptRoot });
  const transcriptReader = new AgentTranscriptReader(new Map<AgentKind, DescriptorAwareTranscriptReader>([
    ["traex", traexTranscriptReader],
    ["pi", piTranscriptReader]
  ]));
  const eventsAdapter: HerdrEventsAdapter = new HerdrEventsAdapter(runner, config.herdr.executable, herdrSocketSubscriber ?? undefined);
  const herdrSessionEventSubscriber = config.herdr.replyObservation === "events" && process.env.HERDR_SOCKET_PATH
    ? new HerdrSessionEventSubscriber({
      socketPath: process.env.HERDR_SOCKET_PATH,
      supportsMultiplex: () => eventsAdapter.supportsSessionEventMultiplex(),
      normalizeAck: normalizeSessionEventMultiplexAck,
      normalizeFrame: normalizeSessionEventMultiplexFrame,
      onFrame: sessionEventFrameLink.callable(),
      onActivated: sessionEventActivationLink.callable(),
      onTransportState: sessionEventTransportLink.callable(),
      refreshTargets: sessionEventTargetRefreshLink.callable(),
      logger
    })
    : null;
  const agentInputCore = new HerdrAgentInputAdapter(runner, config.herdr.executable);
  const agentInputCapability = new AgentInputCapabilityGate(agentInputCore, true);
  const eventsReader = new HerdrEventsReader(eventsAdapter, herdr, (source) => transcriptReader.resolveTranscriptDescriptor(source), coreEvents, { reasoningDisplay: config.runtimeTuning.cards.reasoningDisplay }, turnSnapshots);
  return {
    runner, worktreeNameResolver, herdrSocketSubscriber, herdrSessionEventSubscriber,
    connectSessionEventFrames: (consumer: (frame: CoreSessionEventMultiplexFrame, generation: number) => void) => sessionEventFrameLink.connect(consumer),
    connectSessionEventActivation: (consumer: (targets: readonly CoreSessionEventMultiplexTarget[], generation: number) => void) => sessionEventActivationLink.connect(consumer),
    connectSessionEventTargetRefresh: (consumer: () => Promise<readonly CoreSessionEventMultiplexTarget[]>) => sessionEventTargetRefreshLink.connect(consumer),
    connectSessionEventTransport: (consumer: (state: "connected" | "disconnected", generation: number) => void) => sessionEventTransportLink.connect(consumer),
    herdrCircuitBreaker, herdr, traexControl, paneHost, agentDrivers,
    agentInputCore, agentInputCapability,
    worktrees: new WorktreeManager(runner, { timeoutMs: config.commandTimeoutMs }),
    gateway, gatewayEffects,
    coreSessionIngestor: config.herdr.replyObservation === "events" ? eventsReader : null,
    transcriptReader: config.herdr.replyObservation === "events"
      ? eventsReader
      : config.herdr.replyObservation === "shadow"
        ? new HerdrEventsShadowReader(transcriptReader, runner, herdr, config.herdr.executable, logger, (source) => transcriptReader.resolveTranscriptDescriptor(source))
        : transcriptReader
  };
}
